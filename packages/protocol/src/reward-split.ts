/**
 * How a job's budget divides.
 *
 * Its own module because it is pure and two callers need it: the pipeline,
 * which writes the reward rows, and the routing description the dashboard
 * reads. Keeping it out of `pipeline.ts` keeps the second caller free of a
 * database import it has no use for — and keeps the dashboard reading the
 * same function that pays, rather than a copy of the numbers that would
 * quietly drift from it.
 */

/** Configurable split; the defaults are placeholders, as the design intends. */
export function splitReward(budget: number, env: NodeJS.ProcessEnv = process.env) {
  const pct = (key: string, fallback: number): number => {
    const raw = Number(env[key]);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : fallback;
  };

  const agents = pct("REWARD_SHARE_AGENTS", 0.7);
  const validators = pct("REWARD_SHARE_VALIDATORS", 0.15);
  const protocol = pct("REWARD_SHARE_PROTOCOL", 0.1);
  const treasury = pct("REWARD_SHARE_TREASURY", 0.05);

  const total = agents + validators + protocol + treasury;
  // Normalize so a misconfigured split can never pay out more than the budget.
  const scale = total > 0 ? budget / total : 0;

  return {
    agents: agents * scale,
    validators: validators * scale,
    protocol: protocol * scale,
    treasury: treasury * scale,
  };
}
