import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, toNumber } from "@averis/db";
import type { ProtocolContext } from "@averis/protocol";
import {
  AutomationEngine,
  DEFAULT_TRADE_POLICY,
  TradePolicySchema,
  deriveBreaker,
  parseStoredPolicy,
  resolveDriver,
  resolvePriceSource,
  type ClosedTrade,
} from "@averis/execution";
import type { Principal } from "../auth";

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const DeploySchema = z.object({
  name: z.string().min(2).max(60),
  capabilities: z.array(z.string()).max(10).default(["crypto", "evm", "markets"]),
  policy: TradePolicySchema.partial().default({}),
});

const UpdateSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  capabilities: z.array(z.string()).max(10).optional(),
  policy: TradePolicySchema.partial().optional(),
});

/**
 * Limits a query to what this principal may read.
 *
 * Same shape and same reason as `requesterScope` for jobs: a filter in the
 * `where` clause rather than a check after the fetch, so another account's
 * automation returns 404 instead of 403. A 403 would confirm the id exists,
 * which is itself the leak.
 */
function ownerScope(principal: Principal | null): { ownerId?: string } {
  return principal?.scope === "user" && principal.userId ? { ownerId: principal.userId } : {};
}

/**
 * The account an automation is created under.
 *
 * With wallet login on, an automation belongs to the wallet that deployed it
 * and there is no anonymous path: `walletRequired` makes a keyless or root-key
 * deploy a 401 rather than quietly parking someone's automation on the shared
 * `protocol` account, where a second person could stop it.
 *
 * With wallet login off, the gateway keeps its previous behaviour so an
 * installation that never configured Privy still works from the CLI and the
 * demo.
 */
async function resolveOwnerId(principal: Principal | null): Promise<string | null> {
  if (principal?.userId) return principal.userId;
  const owner = await prisma.user.upsert({
    where: { handle: "protocol" },
    create: { handle: "protocol" },
    update: {},
    select: { id: true },
  });
  return owner.id;
}

export interface AutomationRouteOptions {
  /** True when Privy is configured, so identity is available and expected. */
  walletRequired: boolean;
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  ctx: ProtocolContext,
  options: AutomationRouteOptions = { walletRequired: false },
): void {
  // Resolved once at startup, not per request: an unknown driver name is a
  // typo in the variable that decides whether money moves, and it should stop
  // the gateway rather than surface on the first trade.
  const driver = resolveDriver(ctx.env["EXECUTION_DRIVER"]);
  const prices = resolvePriceSource(ctx.env);
  const engine = new AutomationEngine(driver, prices);

  /** Loads one automation within the caller's scope, or replies 404. */
  async function load(id: string, principal: Principal | null) {
    return prisma.automation.findFirst({ where: { id, ...ownerScope(principal) } });
  }

  async function summarize(automation: { id: string; policy: unknown; breakerResetAt: Date | null }) {
    const now = new Date();
    const [open, closed] = await Promise.all([
      prisma.position.findMany({ where: { automationId: automation.id, status: "OPEN" } }),
      prisma.position.findMany({
        where: {
          automationId: automation.id,
          status: "CLOSED",
          closedAt: { gte: new Date(now.getTime() - HISTORY_WINDOW_MS) },
        },
        select: { token: true, pnlUsd: true, closedAt: true },
      }),
    ]);

    const trades: ClosedTrade[] = closed.flatMap((row) =>
      row.closedAt
        ? [{ token: row.token, pnlUsd: toNumber(row.pnlUsd), closedAt: row.closedAt }]
        : [],
    );

    const policy = parseStoredPolicy(automation.policy);
    const breaker = deriveBreaker(trades, policy, automation.breakerResetAt, now);
    const wins = trades.filter((t) => t.pnlUsd > 0).length;

    return {
      openPositions: open.length,
      deployedUsd: open.reduce((sum, p) => sum + toNumber(p.sizeUsd), 0),
      closedTrades: trades.length,
      // Reported over the window only, and alongside the sample size: a win
      // rate from nine trades is not a track record, and printing it without
      // its denominator invites reading it as one.
      wins,
      realizedPnlUsd: trades.reduce((sum, t) => sum + t.pnlUsd, 0),
      breaker,
    };
  }

  app.get("/v1/automations", async (request, reply) => {
    const rows = await prisma.automation.findMany({
      where: ownerScope(request.principal),
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        mode: row.mode,
        active: row.active,
        capabilities: row.capabilities,
        policy: parseStoredPolicy(row.policy),
        createdAt: row.createdAt,
        stats: await summarize(row),
      })),
    );

    return reply.send({
      data,
      driver: { name: driver.name, spendsRealMoney: driver.spendsRealMoney },
      priceSource: prices.name,
      viewer: {
        walletAddress: request.principal?.walletAddress ?? null,
        walletRequired: options.walletRequired,
      },
    });
  });

  app.post("/v1/automations", async (request, reply) => {
    const parsed = DeploySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid automation",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    if (options.walletRequired && !request.principal?.walletAddress) {
      return reply.code(401).send({
        error: "Connect a wallet to deploy an automation. It is owned by the wallet that deployed it.",
        walletRequired: true,
      });
    }

    const ownerId = await resolveOwnerId(request.principal);
    if (!ownerId) return reply.code(401).send({ error: "No account for this request" });
    // The stored policy is always complete, never a partial overlay. A policy
    // read back with a missing limit would be enforced as "no limit".
    const policy = TradePolicySchema.parse({ ...DEFAULT_TRADE_POLICY, ...parsed.data.policy });

    try {
      const automation = await prisma.automation.create({
        data: {
          name: parsed.data.name,
          ownerId,
          capabilities: parsed.data.capabilities,
          policy: policy as object,
        },
      });

      await prisma.automationEvent.create({
        data: {
          automationId: automation.id,
          kind: "MODE",
          reason: "DEPLOYED",
          message: `Deployed in ${automation.mode} mode, stopped. Start it to allow entries.`,
        },
      });

      return reply.code(201).send({ data: { ...automation, policy } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "You already have an automation with that name" });
      }
      throw error;
    }
  });

  app.get("/v1/automations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    return reply.send({
      data: {
        ...automation,
        policy: parseStoredPolicy(automation.policy),
        stats: await summarize(automation),
      },
      driver: { name: driver.name, spendsRealMoney: driver.spendsRealMoney },
      priceSource: prices.name,
    });
  });

  app.patch("/v1/automations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid update",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const policy = parsed.data.policy
      ? TradePolicySchema.parse({ ...parseStoredPolicy(automation.policy), ...parsed.data.policy })
      : parseStoredPolicy(automation.policy);

    const updated = await prisma.automation.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.capabilities ? { capabilities: parsed.data.capabilities } : {}),
        policy: policy as object,
      },
    });

    return reply.send({ data: { ...updated, policy } });
  });

  /** The master switch. Gates new entries only; open positions keep exiting. */
  app.post("/v1/automations/:id/active", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ active: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "active must be a boolean" });

    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const updated = await prisma.automation.update({
      where: { id },
      data: { active: parsed.data.active },
    });

    await prisma.automationEvent.create({
      data: {
        automationId: id,
        kind: "TOGGLED",
        reason: parsed.data.active ? "STARTED" : "STOPPED",
        message: parsed.data.active
          ? "Started. New entries are allowed."
          : "Stopped. No new entries; open positions are still watched and exited.",
      },
    });

    return reply.send({ data: { id, active: updated.active } });
  });

  /**
   * Paper or live.
   *
   * Deliberately separate from Start/Stop: one says the automation may trade,
   * this says whether those trades spend real money. Collapsing them would make
   * going live a side effect of a button pressed many times a day.
   *
   * Live is refused outright while no driver can execute it. Accepting the flag
   * and then quietly booking paper fills would hand someone a book they believe
   * is real.
   */
  app.post("/v1/automations/:id/mode", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ mode: z.enum(["PAPER", "LIVE"]) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "mode must be PAPER or LIVE" });

    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    if (parsed.data.mode === "LIVE" && !driver.spendsRealMoney) {
      return reply.code(501).send({
        error:
          "No execution driver can spend real money. Live trading is not implemented — writing an unrun swap path and shipping it beside code that has never executed a trade is the one thing this repository refuses to do.",
        driver: driver.name,
      });
    }

    const updated = await prisma.automation.update({
      where: { id },
      data: { mode: parsed.data.mode },
    });

    await prisma.automationEvent.create({
      data: {
        automationId: id,
        kind: "MODE",
        reason: parsed.data.mode,
        message: `Mode set to ${parsed.data.mode}`,
      },
    });

    return reply.send({ data: { id, mode: updated.mode } });
  });

  /** Moves the breaker's window forward without deleting the trades that tripped it. */
  app.post("/v1/automations/:id/reset-breaker", async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const now = new Date();
    await prisma.automation.update({ where: { id }, data: { breakerResetAt: now } });
    await prisma.automationEvent.create({
      data: {
        automationId: id,
        kind: "BREAKER",
        reason: "RESET",
        message: "Breaker window moved forward. Trade history is unchanged.",
      },
    });

    return reply.send({ data: { id, breakerResetAt: now } });
  });

  /**
   * Runs one finished job past this automation's policy.
   *
   * This is the whole feature in one call, and it is also the honest preview:
   * the gates it reports are the same ones a live tick would apply, because it
   * calls the same planner.
   */
  app.post("/v1/automations/:id/evaluate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ jobId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "jobId is required" });

    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const result = await engine.evaluate(id, parsed.data.jobId);
    return reply.send({ data: result });
  });

  /** Marks open positions and closes the ones whose exit rules fired. */
  app.post("/v1/automations/:id/sweep", async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    return reply.send({ data: await engine.sweepExits(id) });
  });

  app.get("/v1/automations/:id/positions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const rows = await prisma.position.findMany({
      where: { automationId: id },
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
      take: 100,
    });

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        jobId: row.jobId,
        token: row.token,
        symbol: row.symbol,
        status: row.status,
        sizeUsd: toNumber(row.sizeUsd),
        entryPrice: toNumber(row.entryPrice),
        peakPrice: toNumber(row.peakPrice),
        exitPrice: row.exitPrice ? toNumber(row.exitPrice) : null,
        pnlUsd: row.pnlUsd ? toNumber(row.pnlUsd) : null,
        exitReason: row.exitReason,
        confidence: row.confidence,
        consensus: row.consensus,
        agentsReporting: row.agentsReporting,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
      })),
    });
  });

  app.get("/v1/automations/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = await load(id, request.principal);
    if (!automation) return reply.code(404).send({ error: "Automation not found" });

    const rows = await prisma.automationEvent.findMany({
      where: { automationId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return reply.send({ data: rows });
  });
}
