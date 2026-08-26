import "server-only";
import { cookies } from "next/headers";

/**
 * Where the viewer's Privy identity token is kept.
 *
 * A cookie rather than a value threaded through every form, because the pages
 * that need it are Server Components — a token held only in browser memory
 * cannot be read while the page is being rendered on the server.
 *
 * It is set **HttpOnly** by a route handler, so page scripts cannot read it
 * back. That is stricter than where it comes from, and deliberately so: the
 * server is the only party that needs to send it onward.
 *
 * The token is not trusted here. Nothing in the web app verifies it, decodes it
 * or acts on its contents — it is forwarded to the gateway, which checks the
 * signature before believing any field. A forged cookie buys nothing but a 401.
 */
export const SESSION_COOKIE = "averis_pid";

/** Identity tokens are short-lived; the client re-syncs this well before it lapses. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60;

/** The viewer's token, or null when nobody has connected a wallet. */
export async function viewerToken(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(SESSION_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}
