"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { Card, SectionHead } from "@/components/ui";
import { useWallet } from "@/components/wallet";

/**
 * Private transfers, entirely in the browser.
 *
 * Three rules shape this component, and each of them costs something.
 *
 *  1. **No private key is ever asked for.** The SDK's recommended deposit
 *     takes a raw key; this uses the deprecated `connect()` + `depositLegacy`
 *     path instead, so the user signs in their own wallet. Averis promises
 *     identity, not custody, and a field asking for a key is the shape of a
 *     phishing page whatever the surrounding copy says.
 *  2. **The note never leaves the browser.** It carries the secret and
 *     nullifier that spend the balance — whoever holds it holds the money. It
 *     is encrypted with a password the user chooses before it is written to
 *     `localStorage`, and nothing here posts it anywhere.
 *  3. **The SDK loads only when used.** It pulls in a proving library and its
 *     dependency tree; importing it at module scope would put that in every
 *     page's bundle for a feature most visitors never open.
 */

/** Fixed denominations, so a deposit amount is not a fingerprint. */
const AMOUNTS = [0.01, 0.1, 1, 10, 100] as const;
const CHAINS = [
  { id: "base", label: "Base" },
  { id: "polygon", label: "Polygon" },
] as const;

const STORAGE_KEY = "averis.px402.note";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The saved note, read as the external store it is.
 *
 * `localStorage` is not React state, and mirroring it into state on mount is
 * both a cascading render and a lie about where the value lives. Reading it
 * through `useSyncExternalStore` also gives the right answer during server
 * rendering — there is no note there, and saying so is not a hydration
 * mismatch.
 */
const listeners = new Set<() => void>();

function readNote(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // A browser refusing storage is not worth blocking on. The note then does
    // not survive a reload, which the copy below already warns about.
    return null;
  }
}

function writeNote(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* see readNote */
  }
  for (const listener of listeners) listener();
}

function subscribeNote(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type Chain = (typeof CHAINS)[number]["id"];
type Busy = null | "loading" | "depositing" | "sending";

export function Px402Transfer() {
  const wallet = useWallet();
  const { ready } = usePrivy();
  const { wallets } = useWallets();

  const [chain, setChain] = useState<Chain>("base");
  const [password, setPassword] = useState("");
  const stored = useSyncExternalStore(subscribeNote, readNote, () => null);
  const [balance, setBalance] = useState<number | null>(null);
  const [amount, setAmount] = useState<number>(1);
  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  /** The SDK, its wallet connection, and the decrypted note. */
  const open = useCallback(
    async (needNote: boolean) => {
      const { PrivacySDK, decryptNote } = await import("@prxvt/sdk");
      const sdk = new PrivacySDK({ chain });

      const connected = wallets[0];
      if (!connected) throw new Error("No wallet connected.");

      const provider = await connected.getEthereumProvider();
      const { createWalletClient, custom } = await import("viem");
      const { base, polygon } = await import("viem/chains");
      await sdk.connect(
        createWalletClient({
          account: connected.address as `0x${string}`,
          chain: chain === "base" ? base : polygon,
          transport: custom(provider),
        }),
      );

      if (!needNote) return { sdk, note: null };
      if (!stored) throw new Error("No note yet — deposit first.");
      if (!password) throw new Error("Enter the password this note was saved with.");
      const note = await decryptNote(JSON.parse(stored), password);
      return { sdk, note };
    },
    [chain, wallets, stored, password],
  );

  const run = async (kind: Busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setReceipt(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const deposit = () =>
    run("depositing", async () => {
      if (!password) throw new Error("Choose a password first — it encrypts the note.");
      const { encryptNote } = await import("@prxvt/sdk");
      const { sdk } = await open(false);
      // `depositLegacy` is the only path that does not want a raw private key.
      const note = await sdk.depositLegacy(amount);
      const encrypted = await encryptNote(note, password);
      writeNote(JSON.stringify(encrypted));
      setBalance(null);
    });

  const check = () =>
    run("loading", async () => {
      const { sdk, note } = await open(true);
      setBalance(await sdk.getBalance(note!));
    });

  const send = () =>
    run("sending", async () => {
      const to = recipient.trim();
      if (!EVM_ADDRESS.test(to)) throw new Error("Recipient must be 0x followed by 40 hex characters.");
      const value = Number(sendAmount);
      if (!Number.isFinite(value) || value <= 0) throw new Error("Enter an amount above zero.");

      const { encryptNote } = await import("@prxvt/sdk");
      const { sdk, note } = await open(true);
      const result = await sdk.makePayment(note!, to, value);

      // The note is consumed and replaced by its change. Failing to save the
      // new one would lose the remaining balance, so this is written before
      // anything else is reported.
      const updated = sdk.getUpdatedNote();
      if (updated) writeNote(JSON.stringify(await encryptNote(updated, password)));
      setBalance(null);
      setReceipt(
        (result as { txHash?: string; hash?: string })?.txHash ??
          (result as { hash?: string })?.hash ??
          "sent",
      );
    });

  if (!wallet.enabled) return null;

  return (
    <section>
      <SectionHead aside={stored ? "note saved" : "no note"}>Send privately</SectionHead>

      <Card className="divide-y divide-line overflow-hidden">
        {!wallet.connected ? (
          <div className="px-4 py-4">
            <p className="text-sm leading-relaxed text-muted">
              Connect a wallet to deposit. The wallet signs the deposit and is never asked for a
              key — after that, payments are made from the note and are not linked to it.
            </p>
            <button
              type="button"
              onClick={wallet.connect}
              disabled={!ready}
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm transition-colors hover:bg-line/40 disabled:opacity-50"
            >
              Connect wallet
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <span className="font-mono text-[11px] tracking-wide text-muted">Chain</span>
              {CHAINS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setChain(c.id)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                    chain === c.id ? "border-fg/40 text-fg" : "border-line text-muted hover:bg-line/40"
                  }`}
                >
                  {c.label}
                </button>
              ))}
              <span className="ml-auto font-mono text-[11px] text-muted">
                px402 settles on these two only
              </span>
            </div>

            <div className="px-4 py-3.5">
              <label className="block font-mono text-[11px] tracking-wide text-muted">
                Note password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="encrypts the note in this browser"
                className="mt-1.5 w-full rounded-lg border border-line bg-transparent px-3 py-1.5 text-sm outline-none focus:border-fg/40"
              />
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                The note is the money: whoever holds it can spend the balance. It is encrypted
                with this password and kept in this browser only — never sent to Averis. Lose the
                browser or the password and the balance is gone, and nobody can restore it.
              </p>
            </div>

            <div className="px-4 py-3.5">
              <p className="font-mono text-[11px] tracking-wide text-muted">
                Deposit — fixed amounts, so the size is not a fingerprint
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {AMOUNTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(a)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                      amount === a ? "border-fg/40 text-fg" : "border-line text-muted hover:bg-line/40"
                    }`}
                  >
                    {a} USDC
                  </button>
                ))}
                <button
                  type="button"
                  onClick={deposit}
                  disabled={busy !== null}
                  className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm transition-colors hover:bg-line/40 disabled:opacity-50"
                >
                  {busy === "depositing" ? "Depositing…" : "Deposit"}
                </button>
              </div>
            </div>

            <div className="px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-mono text-[11px] tracking-wide text-muted">Private balance</p>
                <button
                  type="button"
                  onClick={check}
                  disabled={busy !== null || !stored}
                  className="font-mono text-[11px] text-muted underline-offset-2 hover:underline disabled:opacity-40"
                >
                  {busy === "loading" ? "checking…" : "check"}
                </button>
              </div>
              <p className="mt-1.5 font-mono text-sm">
                {balance === null ? "—" : `${balance} USDC`}
              </p>
            </div>

            <div className="px-4 py-3.5">
              <p className="font-mono text-[11px] tracking-wide text-muted">Send</p>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x… recipient"
                className="mt-2 w-full rounded-lg border border-line bg-transparent px-3 py-1.5 font-mono text-[12px] outline-none focus:border-fg/40"
              />
              <div className="mt-2 flex gap-2">
                <input
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="amount in USDC"
                  className="flex-1 rounded-lg border border-line bg-transparent px-3 py-1.5 text-sm outline-none focus:border-fg/40"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={busy !== null || !stored}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm transition-colors hover:bg-line/40 disabled:opacity-50"
                >
                  {busy === "sending" ? "Sending…" : "Send privately"}
                </button>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                The payment leaves a fresh wallet with no history, so it is not linked to the one
                you deposited from. What remains becomes a new note, saved here in its place.
              </p>
            </div>
          </>
        )}

        {error ? (
          <p className="px-4 py-3 text-sm leading-relaxed text-amber-500">{error}</p>
        ) : null}
        {receipt ? (
          <p className="px-4 py-3 font-mono text-[12px] break-all text-emerald-500">{receipt}</p>
        ) : null}
      </Card>
    </section>
  );
}
