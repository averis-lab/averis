import { NextResponse } from "next/server";
import { SNAPSHOT_TTL_SECONDS, type TokenSnapshot, fetchTokenSnapshot } from "@/lib/token";

/**
 * The live $AVRS snapshot, read from this origin.
 *
 * The chain could be called from the browser directly. It goes through here
 * for three reasons: one cached read serves every visitor instead of one call
 * per open tab, the landing page makes no third-party request from a reader's
 * browser, and the shape the client parses is this app's own rather than raw
 * `eth_call` output that the client would then have to do pool maths on.
 */

/*
 * No `dynamic` export on purpose.
 *
 * A GET handler is already dynamic by default, and `force-dynamic` would go
 * further than "run this per request": it rewrites every fetch inside the
 * segment to `no-store`, which would silently cancel the cache on the upstream
 * reads and put a fresh round of calls behind every poll of every open tab.
 * The handler runs per request; the data it reads does not.
 */

/**
 * The last reading that came back whole.
 *
 * Public RPC nodes and price APIs both drop the occasional connection, and
 * without this a single dropped one blanks the rail for anybody who happens to
 * load the page during it. Serving the previous reading, plainly marked stale,
 * is better than serving nothing — and much better than serving nothing while
 * pretending it is a real absence of price.
 *
 * Module scope: this is per server instance and empty on a cold start, which
 * is why it is a courtesy rather than a cache anything depends on.
 */
let lastGood: TokenSnapshot | null = null;

/** How long a remembered reading may still be served before it is worthless. */
const STALE_GRACE_MS = 10 * 60_000;

export async function GET(): Promise<Response> {
  const snapshot = await fetchTokenSnapshot();

  if (snapshot) {
    lastGood = snapshot;
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": `public, max-age=0, s-maxage=${SNAPSHOT_TTL_SECONDS}, stale-while-revalidate=60`,
      },
    });
  }

  if (lastGood && Date.now() - lastGood.fetchedAt < STALE_GRACE_MS) {
    return NextResponse.json(
      { ...lastGood, stale: true },
      // Never cached: the next request should get a real attempt, not a
      // copy of this apology.
      { headers: { "cache-control": "no-store" } },
    );
  }

  // 503, not 200-with-nulls: the client has to be able to tell "no figure
  // exists" from "we could not go and look", and it shows the last price it
  // holds rather than blanking the rail.
  return NextResponse.json(
    { error: "Live price is unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
