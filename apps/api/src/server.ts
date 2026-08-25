import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { pingDatabase, prisma } from "@averis/db";
import { QUEUES } from "@averis/queue";
import type { ProtocolContext } from "@averis/protocol";
import { registerAuth, extractKey, requesterScope } from "./auth";
import { hashApiKey } from "./api-key";
import { registerJobRoutes } from "./routes/jobs";
import { registerAgentRoutes } from "./routes/agents";
import { registerDatanetRoutes } from "./routes/datanets";
import { isPaidRoute, registerPayments, resolvePaymentConfig } from "./payments";

export interface ServerOptions {
  ctx: ProtocolContext;
}

export async function buildServer({ ctx }: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.env["LOG_LEVEL"] ?? "info",
      // Never let a bearer token or cookie reach the logs.
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-api-key']"],
    },
    // The gateway sits behind a proxy in production; trust its forwarded IPs
    // so rate limiting keys on the real client rather than the proxy.
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin: (ctx.env["CORS_ORIGINS"] ?? "*").split(",").map((o) => o.trim()),
  });

  await app.register(rateLimit, {
    max: Number(ctx.env["RATE_LIMIT_MAX"] ?? 120),
    timeWindow: ctx.env["RATE_LIMIT_WINDOW"] ?? "1 minute",
    // Rate limit per API key when present, per IP otherwise, so one noisy
    // client cannot exhaust the budget of everyone behind the same NAT. The
    // key is hashed first: this bucket name reaches Redis, and a raw key must
    // not live anywhere a key does not have to.
    keyGenerator: (request) => {
      const provided = extractKey(request);
      return provided ? `key:${hashApiKey(provided)}` : `ip:${request.ip}`;
    },
  });

  const keys = (ctx.env["API_KEYS"] ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  // Resolved before auth is registered: whether a keyless request may reach the
  // paywall depends on whether there is a paywall at all. A bad payment config
  // throws here, at startup, rather than at the first request for money.
  const payments = resolvePaymentConfig(ctx.env, keys);

  registerAuth(app, keys, {
    ...(payments ? { allowAnonymous: (request) => isPaidRoute(request.method, request.url) } : {}),
  });

  if (payments) await registerPayments(app, payments);

  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : "Request failed";
    const status = statusCode && statusCode >= 400 ? statusCode : 500;
    // Internal failures never leak their message to the caller.
    return reply.code(status).send({
      error: status >= 500 ? "Internal server error" : message,
    });
  });

  app.get("/", async () => ({
    name: "averis",
    description: "Accountability layer over curated data networks",
    endpoints: [
      "GET  /health",
      "GET  /v1/datanets",
      "GET  /v1/datanets/:id/data",
      "POST /v1/jobs",
      "GET  /v1/jobs",
      "GET  /v1/jobs/:id",
      "GET  /v1/jobs/:id/intelligence",
      "GET  /v1/jobs/:id/explain",
      "GET  /v1/agents",
      "POST /v1/agents",
    ],
  }));

  app.get("/health", async (_request, reply) => {
    const [database, queueDepth] = await Promise.all([
      pingDatabase(),
      ctx.queue.depth(QUEUES.job).catch(() => -1),
    ]);

    const healthy = database && queueDepth >= 0;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      database,
      queue: { driver: ctx.queue.name, jobDepth: queueDepth },
      dataProvider: ctx.data.name,
    });
  });

  // Counts follow the same tenancy rule as the reads they summarize: an
  // account sees its own jobs and their evidence. The agent registry is shared
  // by every tenant, so its count is not scoped.
  app.get("/v1/stats", async (request, reply) => {
    const scope = requesterScope(request.principal);
    const [jobs, resolved, agents, evidence] = await Promise.all([
      prisma.job.count({ where: scope }),
      prisma.job.count({ where: { ...scope, status: "RESOLVED" } }),
      prisma.agent.count({ where: { status: "ACTIVE" } }),
      prisma.evidence.count(scope.requesterId ? { where: { job: scope } } : undefined),
    ]);
    return reply.send({
      data: { jobs, resolved, activeAgents: agents, evidenceItems: evidence },
    });
  });

  registerDatanetRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerAgentRoutes(app, ctx);

  return app;
}
