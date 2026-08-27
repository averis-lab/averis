import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { pingDatabase, prisma, toNumber } from "@averis/db";
import { QUEUES } from "@averis/queue";
import type { ProtocolContext } from "@averis/protocol";
import { registerAuth, extractKey, requesterScope } from "./auth";
import { hashApiKey } from "./api-key";
import { registerJobRoutes } from "./routes/jobs";
import { registerAgentRoutes } from "./routes/agents";
import { registerDatanetRoutes } from "./routes/datanets";
import { registerAutomationRoutes } from "./routes/automations";
import { isPaidRoute, registerPayments, resolvePaymentConfig } from "./payments";
import { createWalletVerifier, resolvePrivyConfig } from "./privy";
import { registerTracing } from "./tracing";

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

  // Registered first, so every later hook, the paywall and the error handler
  // all run inside the request span rather than beside it.
  registerTracing(app, ctx.tracer);

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

  // Half-configured Privy throws here, at startup, rather than presenting a
  // login button whose tokens the gateway will reject one by one.
  const privy = resolvePrivyConfig(ctx.env);
  if (privy) app.log.info({ appId: privy.appId }, "wallet login enabled");

  registerAuth(app, keys, {
    ...(payments ? { allowAnonymous: (request) => isPaidRoute(request.method, request.url) } : {}),
    ...(privy ? { verifyWallet: createWalletVerifier(privy) } : {}),
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
      "GET  /v1/automations",
      "POST /v1/automations",
      "POST /v1/automations/:id/evaluate",
      "GET  /v1/automations/:id/positions",
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
  /**
   * Counts, and what the runs actually cost.
   *
   * The cost and latency figures come from `AgentOutput`, which records them
   * per run — so they are measured, never estimated from a price list. The
   * failure rate is over *terminal* jobs only: a job still queued has not
   * failed, and counting it as a success in waiting flatters the number.
   */
  app.get("/v1/stats", async (request, reply) => {
    const scope = requesterScope(request.principal);
    const outputScope = scope.requesterId ? { job: scope } : {};

    const [jobs, resolved, failed, agents, evidence, runs] = await Promise.all([
      prisma.job.count({ where: scope }),
      prisma.job.count({ where: { ...scope, status: "RESOLVED" } }),
      prisma.job.count({ where: { ...scope, status: "FAILED" } }),
      prisma.agent.count({ where: { status: "ACTIVE" } }),
      prisma.evidence.count(scope.requesterId ? { where: { job: scope } } : undefined),
      prisma.agentOutput.aggregate({
        where: outputScope,
        _count: { _all: true },
        _sum: { costUsd: true },
        _avg: { durationMs: true },
        _max: { durationMs: true },
      }),
    ]);

    const terminal = resolved + failed;

    return reply.send({
      data: {
        jobs,
        resolved,
        activeAgents: agents,
        evidenceItems: evidence,
        metrics: {
          agentRuns: runs._count._all,
          costUsd: toNumber(runs._sum.costUsd ?? 0),
          avgDurationMs: Math.round(runs._avg.durationMs ?? 0),
          maxDurationMs: runs._max.durationMs ?? 0,
          failedJobs: failed,
          // Null rather than 0 when nothing has finished: a rate over an empty
          // denominator is not "zero failures", it is not yet a rate.
          failureRate: terminal > 0 ? failed / terminal : null,
        },
      },
    });
  });

  registerDatanetRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerAutomationRoutes(app, ctx, { walletRequired: privy !== null });

  return app;
}
