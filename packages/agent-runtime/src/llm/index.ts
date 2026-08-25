import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

export * from "./types";
export { AnthropicProvider } from "./anthropic";
export { OpenAIProvider } from "./openai";
export { GeminiProvider } from "./gemini";
export { MockProvider } from "./mock";

export type ProviderKind = "anthropic" | "openai" | "gemini" | "mock";

export interface ProviderRequest {
  provider?: string | undefined;
  model?: string | undefined;
}

/**
 * Resolves a provider by name. Agents declare which provider and model they
 * run on, so a single cohort can mix vendors — which is exactly what makes
 * multi-agent consensus worth something: correlated model error is the main
 * failure mode of a single-vendor cohort.
 */
export function createLLMProvider(
  request: ProviderRequest = {},
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  const kind = (request.provider || env["LLM_PROVIDER"] || "mock").toLowerCase() as ProviderKind;
  const model = request.model || env["LLM_MODEL"] || undefined;

  switch (kind) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: env["ANTHROPIC_API_KEY"], model });
    case "openai":
      return new OpenAIProvider({ apiKey: env["OPENAI_API_KEY"], model });
    case "gemini":
      return new GeminiProvider({ apiKey: env["GOOGLE_GENERATIVE_AI_API_KEY"], model });
    case "mock":
      return new MockProvider(model);
    default:
      throw new Error(
        `Unknown LLM provider "${kind}". Expected one of: anthropic, openai, gemini, mock.`,
      );
  }
}

/**
 * True when the named provider has credentials available. The job engine uses
 * this to fail fast at assignment time rather than mid-execution, after the
 * budget has already been committed.
 */
export function providerIsConfigured(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (kind.toLowerCase()) {
    case "mock":
      return true;
    case "anthropic":
      return Boolean(env["ANTHROPIC_API_KEY"] || env["ANTHROPIC_AUTH_TOKEN"]);
    case "openai":
      return Boolean(env["OPENAI_API_KEY"]);
    case "gemini":
      return Boolean(env["GOOGLE_GENERATIVE_AI_API_KEY"] || env["GEMINI_API_KEY"]);
    default:
      return false;
  }
}
