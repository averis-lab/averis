import "server-only";
import { AverisClient } from "@averis/sdk";

/**
 * Server-side API client.
 *
 * The API key is read from a server-only env var and never reaches the
 * browser: every call in this app runs in a Server Component or Server Action.
 */
/**
 * `NEXT_PUBLIC_*` is inlined at build time, which is wrong for a server-only
 * client: a container built once and deployed anywhere would keep calling
 * whatever gateway the build machine was pointed at — silently, since the
 * default is localhost. `AVERIS_API_URL` is read at runtime and wins.
 */
const GATEWAY =
  process.env.AVERIS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const api = new AverisClient({
  baseUrl: GATEWAY,
  apiKey: process.env.AVERIS_API_KEY,
  // Short enough that a server render falls through to the ApiDown card
  // rather than hanging until the platform kills the request.
  timeoutMs: 8_000,
});

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The API is a separate process that may simply not be running. Every read is
 * wrapped so the UI can say so plainly instead of rendering an error page.
 */
export async function attempt<T>(work: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Raw fetch with a deadline.
 *
 * Without one, a server component waiting on an unreachable API hangs until
 * the platform kills the request instead of falling through to the "API is
 * not reachable" card, which is the whole point of wrapping these in attempt().
 */
export async function fetchJson<T>(path: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${GATEWAY}${path}`,
      {
        headers: { authorization: `Bearer ${process.env.AVERIS_API_KEY ?? ""}` },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
