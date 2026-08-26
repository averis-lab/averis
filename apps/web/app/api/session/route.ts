import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";

/**
 * Hands the viewer's Privy identity token to the server side of this app.
 *
 * The browser holds the token; the pages that need it render on the server.
 * This is the one hop between the two, and it exists so that hop is an
 * HttpOnly cookie rather than a value pasted into every form.
 *
 * Nothing is verified here on purpose. Verification belongs to the gateway,
 * which holds the Privy app secret and checks the signature before believing
 * a single field. Doing it in two places would mean two implementations that
 * can disagree about who someone is, and the weaker one would win.
 */

function looksLikeJwt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length < 8192 &&
    value.split(".").length === 3 &&
    value.split(".").every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;

  if (!looksLikeJwt(body?.token)) {
    // A shape check, not an authenticity check — it keeps arbitrary strings out
    // of the cookie rather than pretending to establish identity.
    return NextResponse.json({ error: "Expected a JWT-shaped token" }, { status: 400 });
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, body.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
