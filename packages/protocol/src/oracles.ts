import { OracleUnavailableError, type PendingPrediction, type ResolutionOracle } from "@averis/types";
import type { Logger } from "./context";

/**
 * Resolution oracles that read the world rather than this protocol's own state.
 *
 * `CurationOracle` (in `resolution.ts`) answers from the data network Averis
 * already reads. These two answer from outside it: a market price, and a value
 * on a chain. They are what make an agent's forecast falsifiable against
 * something nobody in this system controls, which is the whole point of
 * scoring accuracy at all.
 *
 * Both share three rules, and each one exists because the alternative would
 * quietly corrupt an agent's track record:
 *
 *  1. **Refuse rather than guess.** Returning `null` marks a prediction
 *     UNRESOLVABLE, which is excluded from scoring. A wrong observation is far
 *     worse than a missing one: it moves accuracy and calibration in a
 *     direction the agent did not earn.
 *  2. **Observations are spot readings, so they expire.** Neither a price API
 *     nor a pruned RPC node can be asked what something was last Tuesday. If
 *     the sweep reaches a prediction long after its deadline, the honest
 *     answer is that the moment was missed — not the value as of now.
 *  3. **Venues that disagree do not get averaged.** Two sources differing by
 *     more than a hair means at least one is wrong, and picking either is a
 *     coin flip dressed as a measurement.
 */

/** Beyond this, a spot reading no longer describes the deadline it is scoring. */
const DEFAULT_MAX_LAG_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Whether a spot reading taken now can still stand for the deadline.
 *
 * The sweep runs on a timer, so it normally arrives within a minute of a
 * deadline and this is a formality. It stops mattering as a formality exactly
 * when it matters most: after an outage, when the worker comes back up holding
 * a backlog of predictions whose moments have all passed.
 */
function withinLag(deadline: Date, now: Date, maxLagMs: number): boolean {
  return now.getTime() - deadline.getTime() <= maxLagMs;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Walks a JSON path without trusting any of it to exist. */
function dig(value: unknown, ...path: (string | number)[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/* ─── Price ──────────────────────────────────────────────────────────────── */

interface PriceVenue {
  name: string;
  /** Null when this venue cannot express the pair at all. */
  url(base: string, quote: string): string | null;
  read(payload: unknown): unknown;
}

/**
 * Two venues, both keyless and both quoting symbol pairs directly.
 *
 * Deliberately not a long list. Every venue added is another API whose outage
 * or schema change becomes this protocol's problem, and beyond two the
 * marginal one buys very little: the disagreement check below is what provides
 * the safety, and it needs two sources rather than many.
 */
const PRICE_VENUES: PriceVenue[] = [
  {
    name: "coinbase",
    url: (base, quote) => `https://api.coinbase.com/v2/prices/${base}-${quote}/spot`,
    read: (p) => dig(p, "data", "amount"),
  },
  {
    name: "kraken",
    url: (base, quote) => `https://api.kraken.com/0/public/Ticker?pair=${base}${quote}`,
    // Kraken keys the result by its own pair name ("XETHZUSD"), so the one
    // entry is taken positionally rather than by a name it may rename.
    read: (p) => dig(Object.values((dig(p, "result") as object) ?? {})[0], "c", 0),
  },
];

export interface PriceOracleOptions {
  maxLagMs?: number;
  timeoutMs?: number;
  /**
   * How far two venues may differ, as a fraction of the median, before the
   * reading is refused. One percent is wide enough for the ordinary spread
   * between two spot venues and narrow enough that a stale or broken feed on
   * one of them cannot pass unnoticed.
   */
  maxSpread?: number;
  venues?: PriceVenue[];
  fetchImpl?: typeof fetch;
  logger?: Logger | undefined;
}

/**
 * Resolves predictions against a spot market price.
 *
 * Source locator: `price:<BASE>-<QUOTE>`, e.g. `price:ETH-USD`. The metric
 * names what about the pair is being asked for, and `spot` is the only thing
 * a spot endpoint can honestly answer.
 */
export class PriceOracle implements ResolutionOracle {
  readonly name = "price";

  private readonly maxLagMs: number;
  private readonly timeoutMs: number;
  private readonly maxSpread: number;
  private readonly venues: PriceVenue[];
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: PriceOracleOptions = {}) {
    this.maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxSpread = options.maxSpread ?? 0.01;
    this.venues = options.venues ?? PRICE_VENUES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  supports(source: string): boolean {
    return source.startsWith("price:");
  }

  async observe(prediction: PendingPrediction, now: Date = new Date()): Promise<number | null> {
    const { metric, source } = prediction.criteria;

    if (metric !== "spot" && metric !== "price") {
      this.logger?.warn("price oracle asked for a metric it cannot observe", { metric });
      return null;
    }
    if (!withinLag(prediction.deadline, now, this.maxLagMs)) {
      this.logger?.warn("price oracle reached a prediction too late to observe", {
        predictionId: prediction.id,
        deadline: prediction.deadline.toISOString(),
        lagMs: now.getTime() - prediction.deadline.getTime(),
      });
      return null;
    }

    const pair = source.slice("price:".length).toUpperCase();
    const [base, quote] = pair.split("-");
    if (!base || !quote) {
      this.logger?.warn("price oracle could not parse a pair", { source });
      return null;
    }

    const quotes = await this.collect(base, quote);
    if (quotes.length === 0) {
      // Every venue failed. That is an outage on this side, not a fact about
      // the pair, so the prediction is left for the next sweep rather than
      // being scored away.
      throw new OracleUnavailableError(this.name, `no venue quoted ${pair}`);
    }

    const value = median(quotes.map((q) => q.price));

    // One venue is taken on trust because there is nothing to check it
    // against; two that disagree are not.
    if (quotes.length >= 2 && value > 0) {
      const prices = quotes.map((q) => q.price);
      const spread = (Math.max(...prices) - Math.min(...prices)) / value;
      if (spread > this.maxSpread) {
        this.logger?.warn("price venues disagree; refusing to resolve", {
          pair,
          spread,
          quotes: quotes.map((q) => `${q.venue}=${q.price}`),
        });
        return null;
      }
    }

    return value;
  }

  /** Every venue is asked at once; the ones that fail are simply absent. */
  private async collect(base: string, quote: string): Promise<{ venue: string; price: number }[]> {
    const settled = await Promise.allSettled(
      this.venues.map(async (venue) => {
        const url = venue.url(base, quote);
        if (url === null) throw new Error(`${venue.name} cannot quote ${base}-${quote}`);

        const price = Number(venue.read(await getJson(this.fetchImpl, url, this.timeoutMs)));
        // A venue answering with zero, a null, or unparseable text has not
        // answered. Letting that through as a number would drag the median.
        if (!Number.isFinite(price) || price <= 0) throw new Error(`${venue.name} gave no price`);
        return { venue: venue.name, price };
      }),
    );

    return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }
}

/* ─── Chain ──────────────────────────────────────────────────────────────── */

/** `balanceOf(address)`, `totalSupply()`, `decimals()`. */
const SELECTOR = {
  balanceOf: "0x70a08231",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
} as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface ChainOracleOptions {
  /** Chain id to RPC endpoints. A chain absent from this map is unsupported. */
  endpoints: Record<number, string[]>;
  maxLagMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger | undefined;
}

/**
 * Resolves predictions against a value read from an EVM chain.
 *
 * Source locator: `chain:<chainId>` or `chain:<chainId>:<address>`.
 * Metrics:
 *
 *   `block_number`             — the chain's head.
 *   `native_balance`           — the source address's balance, in whole units.
 *   `erc20_total_supply`       — the source contract's supply, decimal-adjusted.
 *   `erc20_balance_of:<addr>`  — that holder's balance of the source contract.
 *
 * A deliberate limitation: this reads `latest`, not the state as of the
 * deadline. The public nodes for most chains are pruned — a historical
 * `eth_call` comes back as a missing-state error rather than an answer — so
 * pinning to a block would fail on precisely the endpoints an operator is
 * likely to configure. The lag guard is what keeps `latest` meaning what the
 * prediction asked about; an operator with an archive node still gets a
 * correct answer, just not a cheaper one.
 */
export class ChainOracle implements ResolutionOracle {
  readonly name = "chain";

  private readonly endpoints: Record<number, string[]>;
  private readonly maxLagMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: ChainOracleOptions) {
    this.endpoints = options.endpoints;
    this.maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  supports(source: string): boolean {
    if (!source.startsWith("chain:")) return false;
    const chainId = Number(source.split(":")[1]);
    // Claiming support for a chain with no endpoint would turn a configuration
    // gap into a stream of resolution errors instead of a clean "no oracle".
    return Number.isInteger(chainId) && (this.endpoints[chainId]?.length ?? 0) > 0;
  }

  async observe(prediction: PendingPrediction, now: Date = new Date()): Promise<number | null> {
    const { metric, source } = prediction.criteria;

    if (!withinLag(prediction.deadline, now, this.maxLagMs)) {
      this.logger?.warn("chain oracle reached a prediction too late to observe", {
        predictionId: prediction.id,
        deadline: prediction.deadline.toISOString(),
        lagMs: now.getTime() - prediction.deadline.getTime(),
      });
      return null;
    }

    const [, rawChainId, rawAddress] = source.split(":");
    const chainId = Number(rawChainId);
    const urls = this.endpoints[chainId] ?? [];
    if (urls.length === 0) return null;

    try {
      if (metric === "block_number") {
        const head = await this.call(urls, "eth_blockNumber", []);
        return this.toNumber(head, 0);
      }

      if (!rawAddress || !ADDRESS.test(rawAddress)) {
        this.logger?.warn("chain oracle needs an address for this metric", { source, metric });
        return null;
      }

      if (metric === "native_balance") {
        const wei = await this.call(urls, "eth_getBalance", [rawAddress, "latest"]);
        return this.toNumber(wei, 18);
      }

      if (metric === "erc20_total_supply") {
        const [supply, decimals] = await Promise.all([
          this.call(urls, "eth_call", [{ to: rawAddress, data: SELECTOR.totalSupply }, "latest"]),
          this.decimalsOf(urls, rawAddress),
        ]);
        return decimals === null ? null : this.toNumber(supply, decimals);
      }

      if (metric.startsWith("erc20_balance_of:")) {
        const holder = metric.slice("erc20_balance_of:".length);
        if (!ADDRESS.test(holder)) {
          this.logger?.warn("chain oracle got a malformed holder address", { metric });
          return null;
        }
        const [balance, decimals] = await Promise.all([
          this.call(urls, "eth_call", [
            { to: rawAddress, data: SELECTOR.balanceOf + holder.slice(2).toLowerCase().padStart(64, "0") },
            "latest",
          ]),
          this.decimalsOf(urls, rawAddress),
        ]);
        return decimals === null ? null : this.toNumber(balance, decimals);
      }

      this.logger?.warn("chain oracle asked for a metric it cannot observe", { metric });
      return null;
    } catch (error) {
      // Every endpoint for this chain failed. Same reasoning as the price
      // oracle: an unreachable node says nothing about the value, so the
      // prediction stays pending instead of being burned.
      throw new OracleUnavailableError(
        this.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async decimalsOf(urls: string[], token: string): Promise<number | null> {
    const raw = await this.call(urls, "eth_call", [
      { to: token, data: SELECTOR.decimals },
      "latest",
    ]);
    const decimals = Number(BigInt(raw));
    // A contract that does not answer `decimals()` is not one this oracle can
    // scale, and guessing 18 would be wrong by orders of magnitude for USDC.
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
  }

  /**
   * One RPC call, raced across the chain's endpoints.
   *
   * Raced rather than tried in turn, because trying in turn lets the slowest
   * endpoint set the deadline for the whole sweep.
   */
  private async call(urls: string[], method: string, params: unknown[]): Promise<string> {
    const attempts = urls.map(async (url) => {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`${response.status} on ${method}`);

      const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? `${method} was refused`);
      if (typeof payload.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(payload.result)) {
        throw new Error(`${method} returned no quantity`);
      }
      return payload.result;
    });

    return Promise.any(attempts);
  }

  /**
   * A hex quantity as a decimal number, scaled by the token's decimals.
   *
   * The division happens in BigInt down to a fixed number of fractional
   * digits before the conversion, so a supply too large for a double does not
   * lose its integer part on the way through.
   */
  private toNumber(hex: string, decimals: number): number | null {
    let raw: bigint;
    try {
      raw = BigInt(hex);
    } catch {
      return null;
    }
    if (decimals === 0) return Number(raw);

    const scale = 10n ** BigInt(decimals);
    const precision = 1_000_000n;
    return Number((raw * precision) / scale) / Number(precision);
  }
}

/* ─── Wiring ─────────────────────────────────────────────────────────────── */

/**
 * Reads `ORACLE_RPC_<chainId>` out of the environment.
 *
 * One variable per chain, each a comma-separated list of endpoints, e.g.
 * `ORACLE_RPC_4663=https://rpc.mainnet.chain.robinhood.com,https://rpc.arrowrpc.com`.
 * A chain with no variable is simply not supported, which is what keeps
 * `supports()` honest rather than optimistic.
 */
export function chainEndpointsFromEnv(env: NodeJS.ProcessEnv): Record<number, string[]> {
  const endpoints: Record<number, string[]> = {};

  for (const [key, value] of Object.entries(env)) {
    const match = /^ORACLE_RPC_(\d+)$/.exec(key);
    if (!match || !value) continue;

    const urls = value
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.startsWith("https://") || url.startsWith("http://"));

    if (urls.length > 0) endpoints[Number(match[1])] = urls;
  }

  return endpoints;
}

/**
 * The optional oracles a deployment has configured.
 *
 * Only the ones that reach outside this protocol live here, and the split from
 * `createOracles` is deliberate rather than cosmetic: curation needs a Prisma
 * client, and importing one into this module would pull a database dependency
 * into every consumer of it — including the tests that exist precisely to run
 * without infrastructure. This half is pure, so the configuration rules below
 * are testable on their own.
 *
 * Each is registered only when configured. An oracle claiming a source it
 * cannot reach turns a missing setting into a run of failed resolutions, where
 * leaving it out produces the correct and legible "no oracle supports this
 * source" instead.
 */
export function optionalOracles(
  env: NodeJS.ProcessEnv,
  logger?: Logger | undefined,
): ResolutionOracle[] {
  const oracles: ResolutionOracle[] = [];

  // Opt-in because it reaches public market APIs, which an offline or
  // air-gapped deployment should not start doing silently.
  if (env["ORACLE_PRICE_ENABLED"] === "true") {
    oracles.push(new PriceOracle({ logger }));
  }

  const endpoints = chainEndpointsFromEnv(env);
  if (Object.keys(endpoints).length > 0) {
    oracles.push(new ChainOracle({ endpoints, logger }));
  }

  return oracles;
}
