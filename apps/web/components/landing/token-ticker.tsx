"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import s from "./sections.module.css";
import {
  POLL_INTERVAL_MS,
  TOKEN_SYMBOL,
  type Direction,
  type TokenSnapshot,
  compare,
  formatEth,
  formatPrice,
  formatUsd,
} from "@/lib/token";

/**
 * The live $AVRS rail, sat directly under the hero.
 *
 * It reads from this app's own `/api/token`, which reads the Uniswap v4 pool
 * on Robinhood Chain. Fetching in the browser rather than on the server is the
 * point: the landing page stays fully static and fast, and the one genuinely
 * per-second fact on it is the only thing that goes over the wire after paint.
 *
 * Three states, and they are not interchangeable:
 *
 *   loading  — nothing read yet; the figures are dashes, not zeros.
 *   live     — a reading is on screen.
 *   offline  — the read failed. If a reading is already showing it stays,
 *              marked stale, since a slightly old price is worth more to a
 *              reader than an empty rail.
 */

type Status = "loading" | "live" | "offline";

/**
 * "Set 28 Aug 2026", or nothing.
 *
 * An all-time high means little without knowing whether it was set an hour ago
 * or last year, and on a token this new it is nearly always the former. Undefined
 * rather than an empty string, so React omits the attribute entirely instead of
 * rendering an empty tooltip.
 */
function athNote(snapshot: TokenSnapshot | null): string | undefined {
  if (!snapshot?.athAt) return undefined;
  const when = new Date(snapshot.athAt);
  if (Number.isNaN(when.getTime())) return undefined;
  return `All-time high set ${when.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

const ARROW: Record<"up" | "down", string> = {
  up: "M7 2.6v8.8M3.6 6 7 2.6 10.4 6",
  down: "M7 11.4V2.6M3.6 8 7 11.4 10.4 8",
};

export function TokenTicker() {
  const [snapshot, setSnapshot] = useState<TokenSnapshot | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  /* The direction of the *last* movement, with a counter that restarts the
     flash animation even when the direction repeats. Not a 24h change: the
     chain's public nodes are pruned, so there is no yesterday to compare to. */
  const [move, setMove] = useState<{ dir: Direction; tick: number }>({ dir: "flat", tick: 0 });
  const railRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/token", { signal, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as TokenSnapshot;

      setSnapshot((previous) => {
        const dir = compare(next.priceUsd, previous?.priceUsd ?? null);
        if (dir !== "flat") setMove((m) => ({ dir, tick: m.tick + 1 }));
        return next;
      });
      setStatus("live");
    } catch {
      // An abort is this component standing down, not a failure — marking that
      // offline would flash a warning on every scroll away from the rail.
      if (signal.aborted) return;
      setStatus("offline");
    }
  }, []);

  /*
   * Polling is gated on the rail being both visible and on a foreground tab.
   *
   * A price nobody is looking at is not worth a request every twenty seconds,
   * and a backgrounded tab left open overnight would otherwise make some four
   * thousand of them. Coming back into view refetches immediately, so what a
   * reader sees on return is current rather than however old the last poll was.
   */
  useEffect(() => {
    const rail = railRef.current;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let onScreen = rail === null;

    const active = () => onScreen && document.visibilityState === "visible";

    const poll = () => {
      controller?.abort();
      controller = new AbortController();
      void load(controller.signal);
    };

    const sync = () => {
      if (active()) {
        if (timer) return;
        poll();
        timer = setInterval(poll, POLL_INTERVAL_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
        controller?.abort();
        controller = null;
      }
    };

    let observer: IntersectionObserver | undefined;
    if (rail && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        ([entry]) => {
          onScreen = entry?.isIntersecting ?? false;
          sync();
        },
        { rootMargin: "300px 0px" },
      );
      observer.observe(rail);
    } else {
      onScreen = true;
    }

    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      if (timer) clearInterval(timer);
      controller?.abort();
    };
  }, [load]);

  // Stale either because our own last read failed, or because the server told
  // us the reading it sent was one it had remembered.
  const stale = (status === "offline" || snapshot?.stale === true) && snapshot !== null;
  const state = stale ? "stale" : status;
  const label = { loading: "Reading", live: "Live", offline: "Unavailable", stale: "Last known" }[state];

  /*
   * `wide` is a phone-layout hint, not a rank.
   *
   * The rail folds to two columns on a narrow screen, and the ether price is
   * the one figure that cannot survive it: fifteen characters that must not be
   * abbreviated, because a truncated price is how a reader leaves with a
   * number wrong by orders of magnitude. It takes a row of its own; the two
   * short dollar figures pair up beneath it.
   */
  const cells = [
    { term: "Price", value: formatPrice(snapshot?.priceUsd ?? null), lead: true, wide: false },
    { term: "In ETH", value: formatEth(snapshot?.priceEth ?? null), lead: false, wide: true },
    { term: "Market cap", value: formatUsd(snapshot?.marketCap ?? null), lead: false, wide: false },
    {
      term: "ATH market cap",
      value: formatUsd(snapshot?.athMarketCap ?? null),
      lead: false,
      wide: false,
      /* The date the high was set. On the title rather than in the cell: it is
         context for the figure, not a fifth figure competing with it. */
      note: athNote(snapshot),
    },
  ];

  return (
    <div className={s.ticker} ref={railRef}>
      <div className={s.tickerInner}>
        <div className={s.tickerBrand}>
          <span className={s.tickerSymbol}>
            <i className={s.tickerSigil} aria-hidden="true">
              $
            </i>
            {TOKEN_SYMBOL}
          </span>
          <span className={s.tickerState} data-status={state}>
            <i aria-hidden="true" />
            {label}
          </span>
        </div>

        {cells.map((cell) => (
          /* Marked rather than positioned: the brand block is a sibling div,
             so any :first-of-type rule here would land on that instead. */
          <div
            key={cell.term}
            className={s.tickerCell}
            data-lead={cell.lead || undefined}
            data-wide={cell.wide || undefined}
            title={cell.note}
          >
            <span className={s.tickerTerm}>{cell.term}</span>
            {/* aria-live on the headline figure only: announcing every number
                on every poll would make the page unusable with a screen reader. */}
            <span className={s.tickerValue} aria-live={cell.lead ? "polite" : undefined}>
              {cell.value}
              {cell.lead && move.dir !== "flat" ? (
                <svg
                  key={move.tick}
                  className={s.tickerArrow}
                  data-dir={move.dir}
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d={ARROW[move.dir]}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
