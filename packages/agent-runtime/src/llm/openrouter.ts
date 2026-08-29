import { OpenAIProvider, type OpenAIProviderConfig } from "./openai";
import type { TokenRates } from "./types";

/**
 * OpenRouter, over its OpenAI-compatible Chat Completions surface.
 *
 * It is a separate provider kind rather than `openai` pointed at another
 * `baseURL`, for three reasons that all show up somewhere other than here:
 *
 *  1. `providerIsConfigured` is asked about a name, and the agent registry
 *     stores that name. An agent recorded as running on "openai" while its
 *     key is an OpenRouter one is a registry that lies about what produced a
 *     claim — and every claim in this system is supposed to be attributable.
 *  2. The rate cards differ. OpenAI's per-million rates are wrong for a
 *     `google/gemini-…` route, and a wrong rate is worse than none: it puts a
 *     confident number on the dashboard beside the word "measured".
 *  3. One credential reaches many vendors. That is the point of using it
 *     here — see the cohort note below.
 *
 * **Why this provider matters to the protocol, not just to billing.** A cohort
 * whose agents all run on one vendor shares that vendor's blind spots, so its
 * agreement is partly an artifact rather than evidence. Consensus is only
 * worth something when the agents can genuinely disagree. Reaching three
 * vendors normally means three accounts and three keys; through here it is one
 * key and a different `modelName` per agent, which is a registry change.
 *
 * Cost is never estimated: OpenRouter returns `usage.cost` on every response
 * and `OpenAIProvider` prefers it over any rate card. The rate card below is
 * only the floor for a response that omits it. Credits are USD-denominated,
 * so the figure is carried through as dollars unconverted.
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Deliberately empty. There are hundreds of routable models and their prices
 * move, so a table maintained here would be stale rather than authoritative —
 * and the response carries the real figure anyway. `fallbackRates` of zero
 * means a response with no reported cost books nothing, which is visible as a
 * $0.00 run rather than as a plausible-looking invention.
 */
const RATES: Record<string, TokenRates> = {};
const FALLBACK_RATES: TokenRates = { inputPerMillion: 0, outputPerMillion: 0 };

export interface OpenRouterProviderConfig
  extends Omit<OpenAIProviderConfig, "name" | "rates" | "fallbackRates"> {
  /** Overridable so a self-hosted or proxied OpenRouter endpoint still works. */
  baseURL?: string | undefined;
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: OpenRouterProviderConfig = {}) {
    /**
     * No default model. Every other adapter here can fall back to its vendor's
     * flagship, but OpenRouter routes by a `vendor/model` id and has no single
     * obvious one — and the id it would otherwise inherit is `gpt-5.1`, which
     * this endpoint does not route. Guessing turns a missing setting into a
     * 400 from a third party halfway through a job that has already reserved
     * its budget; refusing here says which setting is missing.
     */
    if (!config.model?.trim()) {
      throw new Error(
        "openrouter: no model set. OpenRouter routes by a \"vendor/model\" id " +
          "(e.g. anthropic/claude-sonnet-5), so set LLM_MODEL, or give the agent " +
          "its own modelName in the registry.",
      );
    }

    super({
      ...config,
      name: "openrouter",
      baseURL: config.baseURL || DEFAULT_BASE_URL,
      rates: RATES,
      fallbackRates: FALLBACK_RATES,
    });
  }
}
