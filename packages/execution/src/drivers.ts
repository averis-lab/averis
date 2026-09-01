import type { ExitReason, OpenPosition } from "./plan";

/**
 * Execution drivers.
 *
 * The same default `SETTLEMENT_DRIVER` takes, for the same reason: it refuses to
 * act rather than pretending to. A no-op driver that reported success would fill
 * an automation's book with positions that do not exist, and its owner would
 * read the resulting equity curve as real.
 *
 * Unlike settlement, which now has an on-chain driver, there is deliberately
 * **no live driver** here. Writing an unrun swap path and shipping it beside
 * code that has never executed a trade is the most dangerous possible thing to
 * have here, because it looks ready.
 */

export interface OpenOrder {
  token: string;
  symbol: string;
  sizeUsd: number;
  /** Quoted price the decision was made against. */
  price: number;
}

export interface Fill {
  price: number;
  /** Chain signature for a real fill; null for paper. */
  signature: string | null;
}

export interface TradeDriver {
  readonly name: string;
  /** Read by the API before it will let an automation leave paper mode. */
  readonly spendsRealMoney: boolean;
  open(order: OpenOrder): Promise<Fill>;
  close(position: OpenPosition, price: number, reason: ExitReason): Promise<Fill>;
}

export class DriverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverRefusedError";
  }
}

/** The default. Refuses both directions, loudly. */
export class NoneDriver implements TradeDriver {
  readonly name = "none";
  readonly spendsRealMoney = false;

  async open(): Promise<Fill> {
    throw new DriverRefusedError(
      "No execution driver is configured. Set EXECUTION_DRIVER=paper to record simulated fills.",
    );
  }

  async close(): Promise<Fill> {
    throw new DriverRefusedError(
      "No execution driver is configured, so this position was never opened by one either.",
    );
  }
}

/**
 * Books fills at the quoted price and touches nothing else.
 *
 * No slippage or fee model, on purpose: a made-up one would be indistinguishable
 * from a measured one in the equity curve, and this exists to falsify the
 * cohort's calls, not to forecast net returns. What it produces is a resolvable
 * outcome per position — which is the whole point of running paper first.
 */
export class PaperDriver implements TradeDriver {
  readonly name = "paper";
  readonly spendsRealMoney = false;

  async open(order: OpenOrder): Promise<Fill> {
    if (!(order.price > 0)) {
      throw new DriverRefusedError(`Refusing to book a fill at a non-positive price for ${order.symbol}`);
    }
    return { price: order.price, signature: null };
  }

  async close(_position: OpenPosition, price: number): Promise<Fill> {
    if (!(price > 0)) {
      throw new DriverRefusedError("Refusing to book an exit at a non-positive price");
    }
    return { price, signature: null };
  }
}

export function resolveDriver(name: string | undefined): TradeDriver {
  switch ((name ?? "none").trim().toLowerCase()) {
    case "paper":
      return new PaperDriver();
    case "none":
    case "":
      return new NoneDriver();
    default:
      // An unknown driver name is a typo in a variable that decides whether
      // money moves. Falling back to `none` would hide it until the day the
      // typo is fixed and everything goes live at once.
      throw new Error(
        `Unknown EXECUTION_DRIVER "${name}". Known drivers: none, paper. There is no live driver.`,
      );
  }
}
