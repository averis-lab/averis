import { BudgetGuard, BudgetPolicySchema, type BudgetPolicy } from "@averis/budget";
import { createToolRegistry, type ToolRegistry } from "@averis/agent-runtime";
import { ConsensusEngine } from "@averis/consensus";
import { AgentSelector, EvaluationEngine, ReputationEngine } from "@averis/reputation";
import { createQueueDriver, type QueueDriver } from "@averis/queue";
import { createReppoProvider, withFixtureFallback } from "@averis/reppo-adapter";
import { createTracer, type Tracer } from "@averis/tracing";
import type { DataProvider } from "@averis/types";
import { PrismaSpendLedger } from "./ledger";

/**
 * The composition root.
 *
 * Every replaceable subsystem is instantiated exactly once, here, and passed
 * down as an interface. Nothing in the protocol core constructs a data
 * provider, an LLM client or a queue for itself — which is what makes each of
 * them swappable without touching lifecycle logic.
 */
export interface ProtocolContext {
  queue: QueueDriver;
  data: DataProvider;
  tools: ToolRegistry;
  consensus: ConsensusEngine;
  evaluation: EvaluationEngine;
  reputation: ReputationEngine;
  selector: AgentSelector;
  budget: BudgetGuard;
  policy: BudgetPolicy;
  /**
   * Spans for this process. Records nothing unless tracing is configured, so
   * call sites can use it unconditionally.
   */
  tracer: Tracer;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface Logger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (message, detail) => console.log(`[info] ${message}`, detail ?? ""),
  warn: (message, detail) => console.warn(`[warn] ${message}`, detail ?? ""),
  error: (message, detail) => console.error(`[error] ${message}`, detail ?? ""),
};

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Overrides for tests; anything omitted is built from the environment. */
  overrides?: Partial<ProtocolContext>;
}

export function createContext(options: ContextOptions = {}): ProtocolContext {
  const env = options.env ?? process.env;
  const logger = options.logger ?? consoleLogger;

  const policy = BudgetPolicySchema.parse({
    daily: numberOr(env["BUDGET_DAILY"], 50),
    weekly: numberOr(env["BUDGET_WEEKLY"], 250),
    perJob: numberOr(env["BUDGET_PER_JOB"], 5),
    perAgent: numberOr(env["BUDGET_PER_AGENT"], 2),
    transactionReserve: numberOr(env["BUDGET_TX_RESERVE"], 5),
  });

  // A transient upstream outage degrades to recorded fixtures rather than
  // failing every in-flight job.
  const data = withFixtureFallback(createReppoProvider(env));

  const httpHosts = (env["AGENT_HTTP_ALLOWLIST"] ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    queue: createQueueDriver(env),
    data,
    tools: createToolRegistry(httpHosts.length > 0 ? { http: { allowedHosts: httpHosts } } : {}),
    consensus: new ConsensusEngine(),
    evaluation: new EvaluationEngine(),
    reputation: new ReputationEngine(),
    selector: new AgentSelector(),
    budget: new BudgetGuard(new PrismaSpendLedger(), policy),
    policy,
    tracer: createTracer(env, env["OTEL_SERVICE_NAME"] ?? "averis"),
    env,
    logger,
    ...options.overrides,
  };
}

function numberOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
