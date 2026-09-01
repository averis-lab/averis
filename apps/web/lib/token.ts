/**
 * The $AVRS market snapshot, read from the chain itself.
 *
 * An earlier version of this took its price from a DEX aggregator's API. That
 * price is only as fresh as somebody else's indexer, which is exactly the
 * dependency this project exists to argue against — and in practice it lagged.
 * The pool is the authority on what the pool costs, so the price is derived
 * here from the Uniswap v4 pool's own storage, one `eth_call` away, and is
 * current as of whatever block answers.
 *
 * Only the dollar leg comes from off-chain, because the chain has no opinion
 * about what an ether is worth.
 */

/**
 * Written once, here.
 *
 * Case is left exactly as issued. On an EIP-55 address the capitalisation *is*
 * the checksum, so "tidying" it to upper or lower case throws away the one
 * check a reader has that it was transcribed correctly. An all-lowercase
 * address is the valid uncased form and stays that way.
 */
export const TOKEN_ADDRESS = "0xfe54eb048d38d3f2af223139d5e8ee5a275cc292";
export const TOKEN_SYMBOL = "AVRS";

/** Robinhood Chain (4663). The second is a fallback for when the first is down. */
const RPCS = ["https://rpc.mainnet.chain.robinhood.com", "https://rpc.arrowrpc.com"];

/** The Uniswap v4 singleton that custodies every pool on this chain. */
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/**
 * The ETH/AVRS pools, and where each one's state lives in the PoolManager.
 *
 * v4 keeps all pool state in one contract's storage rather than in a contract
 * per pair, so there is nothing to call — the values are read straight out of
 * the slots with `extsload`. The base key is
 * `keccak256(abi.encode(poolId, uint256(6)))`, where 6 is the `_pools`
 * mapping. Inside that struct `Slot0` is the first word and `liquidity` is the
 * fourth, so the second key is simply the base plus three. Every input is
 * constant, so the hashes are precomputed rather than recomputed on each
 * request; deriving them needs a keccak implementation this app otherwise has
 * no reason to carry.
 *
 * There is more than one, and that is the whole point of the list.
 *
 * AVRS launched on a bonding curve and then *graduated*, which minted a second
 * pool and left the first one behind holding a couple of dollars. An earlier
 * version of this file named the launch pool by its hash alone, so the moment
 * the market moved the page went on quoting a venue nobody trades on — a price
 * roughly a quarter of the real one. Reading every known pool and taking the
 * deepest makes that failure impossible to repeat: a drained pool can never
 * win, and the next migration is one line here rather than a wrong number
 * nobody notices.
 *
 * Verified against each pool's `Initialize` log and cross-checked: the price
 * the deepest one yields matches the venue's own quote to every published digit.
 */
const POOLS: { id: string; slot0Key: string }[] = [
  {
    // Graduated 2026-08-28. Carries effectively all of the liquidity and volume.
    id: "0xd69f7b8e7b0f07b9c784d5104840e68b570730b57a15a5690987de49006d02c7",
    slot0Key: "0x5e2fcad37ccd79f5cb033719eaf720685f9c2978220ad7a52f42e3305659cb02",
  },
  {
    // The pre-graduation launch pool. Kept only so a reading is still possible
    // if the pool above is ever drained in turn.
    id: "0xce5f0613a393ecf9dc19b85ab7abd12aa8c048d0b361d74469e04e15131751a5",
    slot0Key: "0xddb6708c30672da6024c67ceb07df9190bbb11fd1b07fe6e3585f44f5db5ee52",
  },
];

/** `_pools[id].liquidity` — the fourth word of the struct. */
const liquidityKey = (slot0Key: string): string =>
  `0x${(BigInt(slot0Key) + 3n).toString(16).padStart(64, "0")}`;

const SELECTOR = {
  /** `extsload(bytes32)` — reads one word of PoolManager storage. */
  extsload: "0x1e2eaeaf",
  /** `totalSupply()` */
  totalSupply: "0x18160ddd",
} as const;

/**
 * Both legs of this pool are 18-decimal, so the raw ratio needs no rescaling.
 *
 * Currency0 is native ether (the zero address) and currency1 is AVRS, which is
 * also what fixes the direction of the division below.
 */
const DECIMALS = 18;

const TIMEOUT_MS = 4_000;

/** How long a snapshot is served before the chain is asked again. */
export const SNAPSHOT_TTL_SECONDS = 15;
/** How often the browser asks this origin for a fresher snapshot. */
export const POLL_INTERVAL_MS = 20_000;

/**
 * Every field is nullable on purpose.
 *
 * The two legs fail independently: the chain can answer while the dollar quote
 * is unreachable, which leaves a real ether price and no USD one. A missing
 * figure renders as "—", never as zero, which would be a claim the data does
 * not make.
 */
export interface TokenSnapshot {
  /** USD per AVRS. Null when no exchange would quote an ether. */
  priceUsd: number | null;
  /** ETH per AVRS, straight from the pool. The chain's own number. */
  priceEth: number | null;
  /** Circulating supply × price. Exact, because supply is read on-chain too. */
  marketCap: number | null;
  /** The block the pool was read at, so the reading can be checked. */
  block: number | null;
  ethUsd: number | null;
  fetchedAt: number;
  /** The highest price AVRS has ever traded at, in USD. */
  athPriceUsd: number | null;
  /** That price against today's supply. See `fetchAth` for what it does mean. */
  athMarketCap: number | null;
  /** When the high was set, as a unix millisecond stamp. */
  athAt: number | null;
  /**
   * True when this is a remembered reading rather than a fresh one, because
   * neither the chain nor a fallback answered in time. The rail says so; a
   * stale price presented as live is the one failure worth avoiding here.
   */
  stale?: boolean;
}

/* ─── Chain ──────────────────────────────────────────────────────────────── */

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * One batched JSON-RPC round trip, tried against each endpoint in turn.
 *
 * Batching matters more than it looks: the price and the supply have to
 * describe the same instant to be worth multiplying together, and three
 * separate requests can straddle a block. Returns null if no endpoint answers.
 */
/** One batched round trip to one endpoint. Throws unless it answers whole. */
async function rpcOnce(url: string, body: string, expected: number): Promise<unknown[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(String(response.status));

  const payload = (await response.json()) as { id: number; result?: unknown; error?: unknown }[] | null;
  if (!Array.isArray(payload) || payload.length !== expected) throw new Error("shape");

  // A batch comes back unordered, and a single failed call inside an otherwise
  // fine batch would otherwise be read as another call's value.
  const out = new Array<unknown>(expected);
  for (const entry of payload) {
    if (entry.error !== undefined || entry.result === undefined) throw new Error("partial");
    out[entry.id] = entry.result;
  }
  return out;
}

/**
 * One batched JSON-RPC round trip, raced across the endpoints.
 *
 * Raced rather than tried in turn, because trying in turn means the slowest
 * endpoint sets the deadline: two endpoints and two passes at a six-second
 * timeout is nearly half a minute of a reader watching a dash where the price
 * goes. Raced, the same four attempts finish in the time the *fastest* healthy
 * endpoint takes, and the second pass exists only because these nodes drop the
 * occasional connection and answer perfectly a moment later.
 *
 * Batching matters for correctness rather than speed: the price and the supply
 * have to describe the same instant to be worth multiplying together, and
 * separate requests can straddle a block.
 */
async function rpcBatch(calls: RpcCall[]): Promise<unknown[] | null> {
  const body = JSON.stringify(calls.map((call, i) => ({ jsonrpc: "2.0", id: i, ...call })));

  for (let pass = 0; pass < 2; pass++) {
    try {
      return await Promise.any(RPCS.map((url) => rpcOnce(url, body, calls.length)));
    } catch {
      // Every endpoint failed this pass; fall through and try them once more.
    }
  }
  return null;
}

const asBigInt = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length < 3) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/**
 * ETH per AVRS, from the pool's square-root price.
 *
 * v4 stores `sqrt(token1/token0) * 2^96` in the low 160 bits of Slot0. Here
 * token0 is ether and token1 is AVRS, so squaring that ratio gives AVRS per
 * ether and the answer wanted is its reciprocal.
 *
 * The conversion to a float loses precision below the 53rd bit of a 112-bit
 * integer, which is about fifteen significant figures — four orders of
 * magnitude more than the four digits ever displayed.
 */
function priceFromSlot0(slot0: bigint): number | null {
  const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
  if (sqrtPriceX96 === 0n) return null;

  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const avrsPerEth = ratio * ratio;
  if (!Number.isFinite(avrsPerEth) || avrsPerEth <= 0) return null;

  return 1 / avrsPerEth;
}

/* ─── Dollars ────────────────────────────────────────────────────────────── */

/**
 * What an ether costs, from whichever venue answers first.
 *
 * Three keyless public endpoints, raced rather than tried in turn: each one is
 * individually unreliable — rate limits, regional blocks, the occasional
 * timeout — but they are rarely all unreachable at once, and racing them means
 * one slow venue does not decide how long this takes.
 */
/** Walks a JSON path without trusting any of it to exist. */
function dig(value: unknown, ...path: (string | number)[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

const ETH_USD_SOURCES: { url: string; read: (payload: unknown) => unknown }[] = [
  { url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", read: (p) => dig(p, "data", "amount") },
  {
    // Kraken keys the result by its own pair name ("XETHZUSD"), so the one
    // entry is taken positionally rather than by a name that may be renamed.
    url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD",
    read: (p) => dig(Object.values((dig(p, "result") as object) ?? {})[0], "c", 0),
  },
  {
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    read: (p) => dig(p, "ethereum", "usd"),
  },
];

/**
 * The last rate that was successfully quoted, and when.
 *
 * Module scope, so it survives between requests on one server instance and is
 * simply absent on a cold start — a best-effort memory, never a source of
 * truth. It exists because the dollar leg is the least reliable part of this
 * and the most visible: without it the headline price disappears entirely,
 * while a reference rate a couple of minutes old moves the last displayed
 * digit at most.
 */
let lastEthUsd: { value: number; at: number } | null = null;
const ETH_USD_GRACE_MS = 5 * 60_000;

async function fetchEthUsd(): Promise<number | null> {
  const attempts = ETH_USD_SOURCES.map(async ({ url, read }) => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: SNAPSHOT_TTL_SECONDS },
    });
    if (!response.ok) throw new Error(String(response.status));

    const price = Number(read(await response.json()));
    // A venue that answers with a zero, a string of nonsense, or an ether
    // priced at eight cents has not answered; rejecting hands the race to the
    // next one rather than publishing the bad figure.
    if (!Number.isFinite(price) || price <= 1) throw new Error("implausible");
    return price;
  });

  try {
    const value = await Promise.any(attempts);
    lastEthUsd = { value, at: Date.now() };
    return value;
  } catch {
    if (lastEthUsd && Date.now() - lastEthUsd.at < ETH_USD_GRACE_MS) return lastEthUsd.value;
    return null;
  }
}

/* ─── All-time high ──────────────────────────────────────────────────────── */

/**
 * The highest AVRS has ever traded, which the chain cannot answer.
 *
 * Everything else here is read from the pool on principle, and this is the one
 * figure that genuinely cannot be: an all-time high is a fact about every
 * block since launch, and this chain's public nodes are pruned. Reconstructing
 * it would mean replaying swap logs nobody still serves. So it comes from an
 * indexer that was watching at the time, and it is the only number on the rail
 * that does.
 *
 * Daily candles, not hourly or minute ones. A candle's high is the highest
 * price inside it however long it is, so a daily series gives exactly the same
 * maximum as a minute series — while one request at `limit=1000` covers about
 * three years instead of seventeen hours. Coarser candles cost nothing here
 * because only the extreme is wanted, never the shape.
 */
const ATH_POOL = POOLS[0].id;
const ATH_URL =
  `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${ATH_POOL}` +
  `/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=base`;

/**
 * A high does not go stale the way a price does.
 *
 * It changes at most once a day, and only upward, so it is read on its own
 * slower clock rather than on every fifteen-second poll of the price — and
 * because the live price ratchets it below, a new high shows on the rail
 * immediately regardless of when this last ran.
 */
const ATH_TTL_SECONDS = 300;
const ATH_GRACE_MS = 6 * 60 * 60_000;

/** Module scope, so one instance keeps the last good high across requests. */
let lastAth: { price: number; at: number | null; fetchedAt: number } | null = null;

/**
 * Highest daily high on record, with the moment it was set.
 *
 * Returns null only when the indexer is unreachable *and* nothing is
 * remembered — which the rail draws as a dash, not as a zero.
 */
async function fetchAth(): Promise<{ price: number; at: number | null } | null> {
  try {
    const response = await fetch(ATH_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: ATH_TTL_SECONDS },
    });
    if (!response.ok) throw new Error(String(response.status));

    // [timestamp, open, high, low, close, volume] per candle, newest first.
    const candles = dig(await response.json(), "data", "attributes", "ohlcv_list");
    if (!Array.isArray(candles)) throw new Error("shape");

    let price = 0;
    let at: number | null = null;
    for (const candle of candles) {
      if (!Array.isArray(candle)) continue;
      const high = Number(candle[2]);
      if (Number.isFinite(high) && high > price) {
        price = high;
        const seconds = Number(candle[0]);
        at = Number.isFinite(seconds) ? seconds * 1000 : null;
      }
    }
    if (price <= 0) throw new Error("empty");

    lastAth = { price, at, fetchedAt: Date.now() };
    return { price, at };
  } catch {
    if (lastAth && Date.now() - lastAth.fetchedAt < ATH_GRACE_MS) {
      return { price: lastAth.price, at: lastAth.at };
    }
    return null;
  }
}

/* ─── Snapshot ───────────────────────────────────────────────────────────── */

/**
 * Reads the live snapshot, or returns null.
 *
 * Null means the chain could not be reached at all. It is deliberately
 * distinct from a snapshot carrying nulls, which means the chain answered and
 * something else — the dollar quote — did not. The UI says different things
 * about the two.
 */
export async function fetchTokenSnapshot(): Promise<TokenSnapshot | null> {
  const read = (to: string, data: string): RpcCall => ({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  const extsload = (key: string): RpcCall =>
    read(POOL_MANAGER, SELECTOR.extsload + key.slice(2));

  const [chain, ethUsd, ath] = await Promise.all([
    rpcBatch([
      { method: "eth_blockNumber", params: [] },
      read(TOKEN_ADDRESS, SELECTOR.totalSupply),
      // Two words per pool — its price and its depth — so the depth that picks
      // the pool is read at the same block as the price it picks.
      ...POOLS.flatMap((pool) => [extsload(pool.slot0Key), extsload(liquidityKey(pool.slot0Key))]),
    ]),
    fetchEthUsd(),
    fetchAth(),
  ]);

  if (!chain) return null;

  const [blockRaw, supplyRaw, ...poolRaw] = chain;
  const blockBig = asBigInt(blockRaw);
  const supply = asBigInt(supplyRaw);

  /*
   * The deepest pool wins.
   *
   * Both candidates quote AVRS against native ether at 18 decimals, so their
   * `liquidity` figures are in the same unit and directly comparable. A pool
   * that has been drained reports a price as confidently as a live one — the
   * ratio in its Slot0 is whatever the last trade left behind — so depth, not
   * the presence of a number, is what decides which reading is the market's.
   */
  let priceEth: number | null = null;
  let depth = 0n;
  for (const [index] of POOLS.entries()) {
    const slot0 = asBigInt(poolRaw[index * 2]);
    const liquidity = asBigInt(poolRaw[index * 2 + 1]);
    if (slot0 === null || liquidity === null || liquidity <= depth) continue;

    const candidate = priceFromSlot0(slot0);
    if (candidate === null) continue;

    priceEth = candidate;
    depth = liquidity;
  }
  if (priceEth === null) return null;

  const priceUsd = ethUsd !== null ? priceEth * ethUsd : null;

  const circulating = supply === null ? null : Number(supply) / 10 ** DECIMALS;
  const usable = circulating !== null && Number.isFinite(circulating) ? circulating : null;
  const marketCap = priceUsd !== null && usable !== null ? priceUsd * usable : null;

  /*
   * The high ratchets against the live price.
   *
   * The indexer's series is only granular to the day and is fetched on a five
   * minute clock, so a record set in the last few minutes is not in it yet.
   * Taking the larger of the two means the rail can never show an all-time
   * high beneath the price printed next to it, which is the one way this
   * figure could read as obviously wrong.
   */
  const athPriceUsd =
    ath === null ? priceUsd : priceUsd === null ? ath.price : Math.max(ath.price, priceUsd);
  const athAt = ath !== null && priceUsd !== null && priceUsd > ath.price ? Date.now() : (ath?.at ?? null);

  return {
    priceUsd,
    priceEth,
    marketCap,
    block: blockBig === null ? null : Number(blockBig),
    ethUsd,
    fetchedAt: Date.now(),
    athPriceUsd,
    athMarketCap: athPriceUsd !== null && usable !== null ? athPriceUsd * usable : null,
    athAt,
  };
}

/* ─── Formatting ─────────────────────────────────────────────────────────── */

export const DASH = "—";

/**
 * A price in full, never abbreviated.
 *
 * Sub-cent tokens are usually printed with the leading zeros collapsed into a
 * subscript (`$0.0₅1694`). That notation is compact and routinely misread by a
 * factor of ten, so the digits are all written out here. `maximumSignificantDigits`
 * keeps four figures of precision at any magnitude, and Intl never falls back
 * to exponent notation, so the string is always something a reader can compare
 * against a block explorer character by character.
 */
export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return DASH;
  return value.toLocaleString("en-US",
    value >= 1
      ? { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }
      : { style: "currency", currency: "USD", maximumSignificantDigits: 4 },
  );
}

/** The ether leg, written the same way and with no currency symbol to borrow. */
export function formatEth(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return DASH;
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/**
 * The figures read at a glance: $1.7M, $842, $1.73, $0.0042.
 *
 * Precision is traded away only where it cannot change how a figure reads.
 * Dropping the cents off $1,695 loses nothing; dropping them off $1.73 turns
 * it into "$2", which is a different number — and on a pair this new, the
 * numbers that matter most are exactly the small ones. Below a dollar the cap
 * moves to significant digits, so $0.0042 does not collapse to $0.00.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;

  const base = { style: "currency", currency: "USD" } as const;
  const magnitude =
    value >= 10_000
      ? ({ notation: "compact", maximumFractionDigits: 2 } as const)
      : value >= 1_000
        ? ({ maximumFractionDigits: 0 } as const)
        : value >= 1
          ? ({ minimumFractionDigits: 2, maximumFractionDigits: 2 } as const)
          : ({ maximumSignificantDigits: 2 } as const);

  return value.toLocaleString("en-US", { ...base, ...magnitude });
}

export type Direction = "up" | "down" | "flat";

/** Which way the last reading moved. Not a 24h change: this chain's public
 *  nodes are pruned, so there is no yesterday to compare against. */
export function compare(next: number | null, previous: number | null): Direction {
  if (next === null || previous === null || next === previous) return "flat";
  return next > previous ? "up" : "down";
}
