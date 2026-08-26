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
export async function fetchJson<T>(
  path: string,
  timeoutMs = 8_000,
  bearer?: string | null,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${GATEWAY}${path}`,
      {
        headers: { authorization: `Bearer ${bearer ?? process.env.AVERIS_API_KEY ?? ""}` },
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

/**
 * Write to the gateway from a Server Action.
 *
 * `bearer` carries the viewer's own identity when one is connected, so the
 * gateway resolves the request to their wallet rather than to this app's shared
 * key. Falling back to that key is what every unauthenticated read already
 * does, and it is why the automation pages refuse to render at all when a
 * wallet is required but absent — a shared key would show one operator another
 * operator's book.
 *
 * Separate from `fetchJson` because the failure contract differs: a read that
 * fails renders the ApiDown card, while a write has to tell the operator what
 * the gateway actually said. A 501 refusing live mode, or a 409 on a duplicate
 * name, is the answer — flattening it to "request failed" would hide it.
 */
export async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  timeoutMs = 15_000,
  bearer?: string | null,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer ?? process.env.AVERIS_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? `${path}: ${response.status}`);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}
