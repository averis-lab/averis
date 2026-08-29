import "server-only";
import { AverisClient } from "@averis/sdk";
import { viewerToken } from "./session";

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

/**
 * What the gateway said, not just that it said no.
 *
 * `sendJson` used to flatten every failure to a message, which is enough to
 * show an operator but throws away the body — and some refusals carry the
 * answer in it. A 409 on a duplicate brief names the job that already asks it,
 * and losing that turns "here is the answer you already have" into "request
 * failed". Callers that only read `.message` are unaffected.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * The same client, speaking as whoever is viewing.
 *
 * `api` above authenticates as the *application*, which is right for anonymous
 * reads and wrong for anything a person owns: every job created through it
 * lands in one shared account, so it cannot tell two visitors apart and the
 * gateway's own tenancy filter has nothing to filter on. That is how a public
 * dashboard ended up with one requester id covering everyone who ever opened
 * it.
 *
 * When a wallet is connected its identity token is sent instead, and the
 * gateway verifies the signature before believing a field of it. With no
 * wallet this falls back to the shared key, which keeps anonymous reads working
 * exactly as before — writes are gated separately, where refusing is useful.
 */
export async function viewerApi(): Promise<AverisClient> {
  const token = await viewerToken();
  if (!token) return api;
  return new AverisClient({ baseUrl: GATEWAY, apiKey: token, timeoutMs: 8_000 });
}

/** True when this installation requires a wallet to own what it creates. */
export const WALLET_LOGIN = Boolean(process.env["PRIVY_APP_ID"]?.trim());

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
      throw new GatewayError(
        response.status,
        payload?.error ?? `${path}: ${response.status}`,
        payload,
      );
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}
