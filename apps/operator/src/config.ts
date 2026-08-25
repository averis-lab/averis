import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { BudgetPolicySchema, type BudgetPolicy } from "@averis/budget";
import { StrategyConfigSchema, type StrategyConfig } from "@averis/strategy";

export interface OperatorConfig {
  name: string;
  strategy: StrategyConfig;
  budget: BudgetPolicy;
}

/**
 * Loads and validates the operator's configuration.
 *
 * Validation is strict and fails at startup. An operator that runs unattended
 * with a silently defaulted budget is exactly the failure this project treats
 * as dangerous — better to refuse to start than to spend on a typo.
 */
export async function loadOperatorConfig(path: string): Promise<OperatorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Operator config not found at "${path}". Copy apps/operator/operator.yaml.`);
  }

  const parsed = parse(raw) as {
    operator?: { name?: string };
    strategy?: Record<string, unknown>;
    budget?: Record<string, unknown>;
  };

  const name = parsed.operator?.name;
  if (!name || typeof name !== "string") {
    throw new Error(`Operator config at "${path}" must set operator.name`);
  }

  const strategy = StrategyConfigSchema.safeParse({
    domains: parsed.strategy?.["domains"],
    minReward: parsed.strategy?.["min_reward"],
    maxRequiredConfidence: parsed.strategy?.["max_required_confidence"],
    maxConcurrentJobs: parsed.strategy?.["max_concurrent_jobs"],
    cadence: parsed.strategy?.["cadence"],
    minTimeToDeadlineMs: parsed.strategy?.["min_time_to_deadline_ms"],
    jobTypes: parsed.strategy?.["job_types"],
  });
  if (!strategy.success) {
    throw new Error(
      `Invalid strategy config: ${strategy.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const budget = BudgetPolicySchema.safeParse({
    daily: parsed.budget?.["daily"],
    weekly: parsed.budget?.["weekly"],
    perJob: parsed.budget?.["per_job"],
    perAgent: parsed.budget?.["per_agent"],
    transactionReserve: parsed.budget?.["transaction_reserve"],
  });
  if (!budget.success) {
    throw new Error(
      `Invalid budget config: ${budget.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  if (budget.data.perJob > budget.data.daily) {
    throw new Error("budget.per_job cannot exceed budget.daily");
  }
  if (budget.data.transactionReserve >= budget.data.daily) {
    throw new Error("budget.transaction_reserve must be less than budget.daily");
  }

  return { name, strategy: strategy.data, budget: budget.data };
}
