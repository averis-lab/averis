import { NextResponse } from "next/server";
import { buildPath, findEndpoint } from "@/lib/playground";

/**
 * Server-side proxy for the playground.
 *
 * It exists for the same reason the UI cannot call the gateway directly: the
 * Averis API key is server-only and must not reach the browser. That makes
 * this route a credentialed forwarder, so it forwards *only* what the
 * catalogue describes — an endpoint id, its declared path parameters, and its
 * declared query keys. There is no path field to pass through, which is what
 * keeps it from becoming an open proxy holding the server's key.
 */

/**
 * `NEXT_PUBLIC_*` values are inlined at build time, which is wrong for a
 * server-only forwarder: the deployed proxy would keep calling whatever
 * gateway the build machine was pointed at. `AVERIS_API_URL` is read at
 * runtime and wins when set; the public var stays as the fallback so existing
 * setups keep working.
 */
const GATEWAY =
  process.env.AVERIS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 100_000;

interface PlaygroundRequest {
  endpointId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
}

export async function POST(request: Request): Promise<Response> {
  let input: PlaygroundRequest;
  try {
    input = (await request.json()) as PlaygroundRequest;
  } catch {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  const endpoint = findEndpoint(input.endpointId ?? "");
  if (!endpoint) {
    return NextResponse.json({ error: "Unknown endpoint" }, { status: 400 });
  }

  const { path, missing } = buildPath(endpoint, input.params ?? {}, input.query ?? {});
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required parameter: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  let payload: string | undefined;
  if (endpoint.method === "POST") {
    payload = input.body ?? "";
    if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
    }
    try {
      JSON.parse(payload);
    } catch {
      // Caught here rather than forwarded, so the reader gets "your JSON is
      // wrong" instead of a 400 from the gateway that means the same thing.
      return NextResponse.json({ error: "Request body is not valid JSON" }, { status: 400 });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(`${GATEWAY}${path}`, {
      method: endpoint.method,
      headers: {
        "content-type": "application/json",
        ...(process.env.AVERIS_API_KEY
          ? { authorization: `Bearer ${process.env.AVERIS_API_KEY}` }
          : {}),
      },
      ...(payload === undefined ? {} : { body: payload }),
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Left as text: a non-JSON body is worth showing verbatim.
    }

    return NextResponse.json({
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - started,
      path,
      method: endpoint.method,
      body: parsed,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return NextResponse.json(
      {
        status: 0,
        statusText: aborted ? "Timed out" : "Unreachable",
        durationMs: Date.now() - started,
        path,
        method: endpoint.method,
        body: {
          error: aborted
            ? `The gateway did not answer within ${TIMEOUT_MS / 1000}s.`
            : `Could not reach the gateway at ${GATEWAY}. Is \`npm run dev:api\` running?`,
        },
      },
      { status: 200 },
    );
  } finally {
    clearTimeout(timer);
  }
}
