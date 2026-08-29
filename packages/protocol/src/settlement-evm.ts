import type {
  SettlementDriver,
  SettlementInstruction,
  SettlementReceipt,
} from "./settlement-plan";

/**
 * On-chain settlement, as an ERC-20 transfer.
 *
 * This is the half of the protocol that was missing: `settlement.ts` decided
 * what was owed and made sure it could be paid at most once, but every driver
 * behind it either refused (`none`) or recorded a payment somebody had already
 * made elsewhere (`ledger`). Nothing signed.
 *
 * Three things shape what is written here.
 *
 *  1. **Nothing is hardcoded.** The chain id, the RPC and the token contract
 *     come from the environment, and the driver refuses to start without all
 *     three — the same rule the paywall applies on the way in, for the same
 *     reason: a wrong token address is not a misconfiguration, it is funds sent
 *     somewhere nobody controls.
 *  2. **It refuses before it broadcasts.** Every transfer is simulated first,
 *     so an insufficient balance or a paused token is an error that costs
 *     nothing and returns the reward to `PENDING`, rather than a reverted
 *     transaction that costs gas.
 *  3. **`CONFIRMED` means observed.** The status is only reported after the
 *     receipt is read back and the transaction is seen to have succeeded. A
 *     broadcast that has not confirmed within the timeout is reported as
 *     `BROADCAST` with its hash, which is what the engine's `BROADCAST` state
 *     already exists to hold: the debt stays owed until something sees it land.
 *
 * `viem` is imported inside {@link connect} rather than at module scope, so an
 * operator running `SETTLEMENT_DRIVER=none` — the default — never loads a chain
 * library, and `settlement-plan.ts` keeps the property that its rules can be
 * tested without a chain, a database or money.
 */

/** 0x followed by 20 bytes. The only payee shape this driver can pay. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** 0x followed by 32 bytes. Checked by shape only; never logged or echoed. */
const EVM_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** USDC is six decimals on every EVM chain; overridable for a different token. */
const DEFAULT_DECIMALS = 6;

/**
 * The `transfer` entry of ERC-20, written out rather than parsed.
 *
 * A literal keeps this module free of a runtime `viem` import at load time,
 * which is the whole reason the chain library can stay lazy.
 */
const ERC20_TRANSFER = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export class SettlementConfigError extends Error {}

export interface EvmSettlementConfig {
  rpcUrl: string;
  chainId: number;
  /** Token contract payments are made in. */
  asset: string;
  assetDecimals: number;
  /** The currency rewards are denominated in; a mismatch is refused, not converted. */
  currency: string;
  /** Signs the transfers. Held in memory only. */
  privateKey: string;
  confirmations: number;
  confirmationTimeoutMs: number;
}

/**
 * Reads the environment into a driver configuration.
 *
 * Throws rather than defaulting on all four values that decide where money
 * goes. There is no table of known networks here for the same reason the
 * paywall has none: an entry with a wrong token contract is indistinguishable
 * from a working one until the funds are gone.
 */
export function evmSettlementConfigFrom(
  env: NodeJS.ProcessEnv = process.env,
): EvmSettlementConfig {
  const rpcUrl = (env["SETTLEMENT_RPC_URL"] ?? "").trim();
  if (!rpcUrl) {
    throw new SettlementConfigError(
      "SETTLEMENT_DRIVER=evm requires SETTLEMENT_RPC_URL, the endpoint transfers are sent to.",
    );
  }

  const chainId = Number(env["SETTLEMENT_CHAIN_ID"]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new SettlementConfigError(
      "SETTLEMENT_DRIVER=evm requires SETTLEMENT_CHAIN_ID, the EVM chain id transfers settle on.",
    );
  }

  const asset = (env["SETTLEMENT_ASSET"] ?? "").trim();
  if (!EVM_ADDRESS.test(asset)) {
    throw new SettlementConfigError(
      "SETTLEMENT_DRIVER=evm requires SETTLEMENT_ASSET, the token contract payouts are made in, " +
        "as 0x followed by 40 hex characters.",
    );
  }

  const privateKey = (env["SETTLEMENT_PRIVATE_KEY"] ?? "").trim();
  if (!EVM_PRIVATE_KEY.test(privateKey)) {
    // The value is never quoted back, here or anywhere else in this module.
    throw new SettlementConfigError(
      "SETTLEMENT_DRIVER=evm requires SETTLEMENT_PRIVATE_KEY, the key that signs payouts, " +
        "as 0x followed by 64 hex characters.",
    );
  }

  return {
    rpcUrl,
    chainId,
    asset,
    assetDecimals: positive(env["SETTLEMENT_ASSET_DECIMALS"], DEFAULT_DECIMALS),
    currency: (env["SETTLEMENT_CURRENCY"] ?? "USDC").trim().toUpperCase(),
    privateKey,
    confirmations: positive(env["SETTLEMENT_CONFIRMATIONS"], 1),
    confirmationTimeoutMs: positive(env["SETTLEMENT_CONFIRMATION_TIMEOUT_MS"], 120_000),
  };
}

/**
 * Opens the chain connection and proves it is the configured chain.
 *
 * The chain id is checked against the one the RPC actually serves before any
 * transfer is built. `SETTLEMENT_RPC_URL` and `SETTLEMENT_CHAIN_ID` are two
 * independent claims about the same chain, and a testnet RPC configured under a
 * mainnet id would otherwise pay out real rewards in worthless tokens without
 * anything looking wrong.
 */
async function connect(config: EvmSettlementConfig) {
  const { createPublicClient, createWalletClient, defineChain, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const chain = defineChain({
    id: config.chainId,
    name: `eip155:${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  let served: number;
  try {
    served = await publicClient.getChainId();
  } catch (error) {
    throw new Error(
      `SETTLEMENT_RPC_URL (${config.rpcUrl}) could not be reached: ${asMessage(error)}`,
    );
  }

  if (served !== config.chainId) {
    throw new Error(
      `SETTLEMENT_CHAIN_ID is ${config.chainId} but the RPC at ${config.rpcUrl} serves chain ` +
        `${served}. One of the two is wrong, and paying against the wrong one is not reversible.`,
    );
  }

  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport });

  return { chain, account, publicClient, walletClient };
}

type Connection = Awaited<ReturnType<typeof connect>>;

/**
 * Pays rewards by transferring an ERC-20 token on an EVM chain.
 *
 * One transfer per instruction, awaited to its receipt before the next begins.
 * That is deliberately unbatched and deliberately serial: it keeps nonces in
 * order without a nonce manager, and it keeps the mapping from a reward to a
 * transaction hash one-to-one, which is what makes a sweep auditable after the
 * fact.
 */
export class EvmSettlementDriver implements SettlementDriver {
  readonly name = "evm";

  private readonly config: EvmSettlementConfig;
  /** Opened once and reused; the chain-id check runs on the first payment. */
  private connection: Promise<Connection> | null = null;

  constructor(config: EvmSettlementConfig) {
    this.config = config;
  }

  /**
   * Whether an address is one this driver could pay.
   *
   * Asked during planning, so a payee this driver cannot pay is reported as a
   * skip with a reason rather than as a failure partway through a sweep. The
   * case this exists for is real: agent payees come from the wallet a user
   * connected through Privy, which is not guaranteed to be an EVM address.
   */
  acceptsPayee(payee: string): boolean {
    return EVM_ADDRESS.test(payee.trim());
  }

  async settle(instruction: SettlementInstruction): Promise<SettlementReceipt> {
    const payee = instruction.payee.trim();

    if (!this.acceptsPayee(payee)) {
      throw new Error(
        `${payee} is not an EVM address; this driver cannot pay it. ` +
          "The agent's owner registered a wallet on another chain.",
      );
    }

    if (instruction.currency.toUpperCase() !== this.config.currency) {
      // Refused rather than converted: a driver that guesses an exchange rate
      // is a driver that pays the wrong amount.
      throw new Error(
        `reward is denominated in ${instruction.currency} but this driver pays ` +
          `${this.config.currency}; no conversion is attempted.`,
      );
    }

    const amount = toBaseUnits(instruction.amount, this.config.assetDecimals);
    if (amount <= 0n) {
      throw new Error(
        `${instruction.amount} ${instruction.currency} is below what ${this.config.assetDecimals} ` +
          "decimals can express; there is nothing to send.",
      );
    }

    const { account, chain, publicClient, walletClient } = await this.connect();

    // Simulated first. A revert here — insufficient balance, a paused token, a
    // contract that is not ERC-20 — costs nothing and leaves the reward
    // retryable, instead of burning gas on a transaction that was never going
    // to land.
    const { request } = await publicClient.simulateContract({
      address: this.config.asset as `0x${string}`,
      abi: ERC20_TRANSFER,
      functionName: "transfer",
      args: [payee as `0x${string}`, amount],
      account,
      chain,
    });

    const hash = await walletClient.writeContract(request);

    const detail = {
      hash,
      chainId: this.config.chainId,
      asset: this.config.asset,
      amount: amount.toString(),
      decimals: this.config.assetDecimals,
      payee,
      from: account.address,
    };

    // Past this point the transaction is public. Everything below reports what
    // happened to it; nothing below may swallow the hash, because the hash is
    // the only handle anyone has on money that has already left.
    let receipt: Awaited<ReturnType<Connection["publicClient"]["waitForTransactionReceipt"]>>;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.config.confirmations,
        timeout: this.config.confirmationTimeoutMs,
      });
    } catch (error) {
      // Not a failure: a transaction that has not been observed confirming is
      // exactly what BROADCAST means. The reward stays APPROVED and unpaid
      // until something sees this hash land, which is the safe direction —
      // the unsafe one would be settling a debt on a transaction that may
      // still revert.
      return {
        reference: hash,
        status: "BROADCAST",
        detail: { ...detail, unconfirmed: asMessage(error) },
      };
    }

    if (receipt.status !== "success") {
      throw new Error(
        `transfer ${hash} reverted on chain ${this.config.chainId}; no tokens moved, ` +
          "so the reward returns to PENDING.",
      );
    }

    return {
      reference: hash,
      status: "CONFIRMED",
      detail: {
        ...detail,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      },
    };
  }

  private connect(): Promise<Connection> {
    // Cached as the promise, not the result, so concurrent first calls share
    // one connection and one chain-id check. A rejection is dropped so a
    // transient RPC failure at startup does not poison every later sweep.
    if (!this.connection) {
      this.connection = connect(this.config).catch((error: unknown) => {
        this.connection = null;
        throw error;
      });
    }
    return this.connection;
  }
}

/**
 * Decimal amount → integer base units, without floating point.
 *
 * `0.07 * 1e6` is 70000.00000000001 in IEEE-754, and a transfer that is one
 * unit off is still a transfer of the wrong amount. Amounts finer than the
 * asset can express are rounded to its precision, which is the most it can
 * carry; anything that rounds to zero is refused by the caller.
 */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const [whole = "0", fraction = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
