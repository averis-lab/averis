/**
 * Where an exit sweep gets a mark from.
 *
 * An interface rather than a hard-wired vendor because the honest default is
 * "none configured". A price source that guessed — last known, entry price,
 * zero — would mark a book to numbers nobody observed, and every equity curve
 * downstream would inherit the fiction.
 */
export interface PriceSource {
  readonly name: string;
  /** Returns null when the price could not be observed. Never a guess. */
  quote(mint: string): Promise<number | null>;
}

/** The default. Observes nothing, so nothing opens and nothing marks. */
export class NullPriceSource implements PriceSource {
  readonly name = "none";
  async quote(): Promise<number | null> {
    return null;
  }
}

export interface HttpPriceSourceOptions {
  /** URL template with `{mint}` substituted, e.g. `https://…/price?ids={mint}`. */
  url: string;
  /** Dotted path to the number inside the response, e.g. `data.{mint}.usdPrice`. */
  path: string;
  timeoutMs?: number;
  name?: string;
}

/**
 * Reads a mark from an HTTP quote endpoint.
 *
 * Kept vendor-neutral and configured by URL rather than importing a provider
 * SDK: this repository has never made a request to any specific price API, and
 * naming one in code would imply it has been exercised. Point it at whichever
 * endpoint you have actually verified, in `EXECUTION_PRICE_URL`.
 */
export class HttpPriceSource implements PriceSource {
  readonly name: string;

  constructor(private readonly options: HttpPriceSourceOptions) {
    this.name = options.name ?? "http";
  }

  async quote(mint: string): Promise<number | null> {
    const url = this.options.url.replaceAll("{mint}", encodeURIComponent(mint));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const raw = readPath(body, this.options.path.replaceAll("{mint}", mint));
      const value = typeof raw === "string" ? Number(raw) : raw;
      // A non-finite or non-positive mark is not a price. Returning it would
      // trip the stop loss on every open position at once.
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object" && key in node) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

export function resolvePriceSource(env: Record<string, string | undefined>): PriceSource {
  const url = env["EXECUTION_PRICE_URL"];
  if (!url) return new NullPriceSource();
  return new HttpPriceSource({
    url,
    path: env["EXECUTION_PRICE_PATH"] ?? "data.{mint}.usdPrice",
    ...(env["EXECUTION_PRICE_TIMEOUT_MS"]
      ? { timeoutMs: Number(env["EXECUTION_PRICE_TIMEOUT_MS"]) }
      : {}),
  });
}
