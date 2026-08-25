import type { FastifyInstance } from "fastify";
import { prisma, toDecimalInput, toNumber } from "@averis/db";
import { JobEngine, type ProtocolContext } from "@averis/protocol";
import { RegisterAgentSchema } from "@averis/types";

export function registerAgentRoutes(app: FastifyInstance, ctx: ProtocolContext): void {
  const engine = new JobEngine(ctx);

  app.get("/v1/agents", async (_request, reply) => {
    const agents = await engine.candidates();
    return reply.send({ data: agents });
  });

  app.get("/v1/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findUnique({
      where: { id },
      include: {
        capabilities: true,
        reputation: { orderBy: { createdAt: "desc" }, take: 30 },
        _count: { select: { outputs: true, assignments: true } },
      },
    });
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    const overall = agent.reputation.find((r) => r.domain === null);
    const domains = new Map<string, (typeof agent.reputation)[number]>();
    for (const snapshot of agent.reputation) {
      if (snapshot.domain && !domains.has(snapshot.domain)) domains.set(snapshot.domain, snapshot);
    }

    return reply.send({
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
        tools: agent.tools,
        pricePerJob: toNumber(agent.pricePerJob),
        capabilities: agent.capabilities,
        reputation: overall
          ? {
              overall: overall.overall,
              accuracy: overall.accuracy,
              calibration: overall.calibration,
              consistency: overall.consistency,
              evidenceQuality: overall.evidenceQuality,
              sampleSize: overall.sampleSize,
            }
          : null,
        domainReputation: Object.fromEntries(
          [...domains].map(([domain, s]) => [domain, { overall: s.overall, sampleSize: s.sampleSize }]),
        ),
        jobsCompleted: agent._count.outputs,
        assignments: agent._count.assignments,
      },
    });
  });

  /** Permissionless registration is deliberately gated behind API auth. */
  app.post("/v1/agents", async (request, reply) => {
    const parsed = RegisterAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid agent registration",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const spec = parsed.data;
    const existing = await prisma.agent.findUnique({ where: { name: spec.name } });
    if (existing) return reply.code(409).send({ error: `Agent "${spec.name}" already exists` });

    const agent = await prisma.agent.create({
      data: {
        name: spec.name,
        description: spec.description,
        modelProvider: spec.modelProvider,
        modelName: spec.modelName,
        tools: spec.tools,
        runtimeConfig: spec.runtimeConfig as object,
        pricePerJob: toDecimalInput(spec.pricePerJob),
        maxConcurrent: spec.maxConcurrent,
        // The registry stays shared — every job may select any active agent —
        // but an agent registered with an account key records who owns it.
        ownerId: request.principal?.userId ?? null,
        capabilities: { create: spec.capabilities },
      },
      include: { capabilities: true },
    });

    return reply.code(201).send({ data: { ...agent, pricePerJob: toNumber(agent.pricePerJob) } });
  });
}
