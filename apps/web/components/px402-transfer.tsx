"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
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

/**
 * Networks px402 does not reach yet.
 *
 * Kept out of `CHAINS` rather than flagged inside it, so `Chain` stays exactly
 * the union the SDK accepts and an unreachable network cannot be selected by
 * any path. It is shown rather than omitted for the reason the sidebar shows a
 * section that is not built yet: hiding it would suggest nobody intends to.
 *
 * Adding one here is not what makes it work. px402 compiles its pool,
 * paymaster and entry-point addresses per chain and ships no contract source,
 * so a network arrives only when they deploy and release it.
 */
const SOON = ["Robinhood Chain"] as const;

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

/**
 * Proves the note can be saved, before anything is deposited.
 *
 * The worst outcome this component can produce is a deposit that succeeds
 * followed by a note that cannot be stored: the funds are then in the pool
 * with nothing able to spend them, and no server holds a copy to recover from.
 * A browser in private mode, or one with site data blocked, does exactly that.
 * Writing and reading back a throwaway value first turns that from a loss into
 * a refusal.
 */
function storageWorks(): boolean {
  const probe = `${STORAGE_KEY}.probe`;
  try {
    window.localStorage.setItem(probe, "1");
    const ok = window.localStorage.getItem(probe) === "1";
    window.localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
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
  const [showBackup, setShowBackup] = useState(false);
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
      if (!stored) throw new Error("No note yet. Deposit first.");
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
      if (!password) throw new Error("Choose a password first. It encrypts the note.");
      if (!storageWorks()) {
        throw new Error(
          "This browser will not keep the note, so a deposit could not be spent afterwards. " +
            "Allow site data for this page, or use a normal window instead of a private one.",
        );
      }
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

  const field =
    "w-full rounded-xl border border-line bg-background/40 px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted/60 focus:border-accent/50";
  const chip = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
      on ? "border-accent/60 bg-accent/10 text-foreground" : "border-line text-muted hover:bg-line/30"
    }`;

  return (
    <section className="space-y-3">
      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-7">
        {/* Heading and the one number that matters, on one line — the balance
            is what someone opens this page to see. */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Send privately</h2>
            <p className="mt-1 text-sm text-muted">
              Deposit once, then spend without the payment pointing back at you.
            </p>
          </div>
          <div className="text-right">
            {/* An unchecked balance is not a zero balance, and showing one as
                the other is the sort of small lie a wallet must never tell. */}
            {balance === null ? (
              <p className="font-mono text-sm text-muted">not checked</p>
            ) : (
              <p className="font-mono text-2xl leading-none text-accent">{balance}</p>
            )}
            <p className="mt-1 font-mono text-[11px] text-muted">private balance · USDC</p>
          </div>
        </div>

        {!wallet.connected ? (
          <div className="mt-6">
            <p className="text-sm leading-relaxed text-muted">
              Connect a wallet to deposit. It signs the deposit and is never asked for a key.
              After that, payments come from the note and are not linked to it.
            </p>
            <button
              type="button"
              onClick={wallet.connect}
              disabled={!ready}
              className="mt-4 w-full rounded-xl bg-accent-strong px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Connect wallet
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 font-mono text-[11px] tracking-wide text-muted">Network</span>
              {CHAINS.map((c) => (
                <button key={c.id} type="button" onClick={() => setChain(c.id)} className={chip(chain === c.id)}>
                  {c.label}
                </button>
              ))}
              {SOON.map((label) => (
                <span
                  key={label}
                  aria-disabled="true"
                  title="px402 has no pool on this network yet"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 font-mono text-[11px] text-muted/60"
                >
                  {label}
                  <span className="tracking-[0.1em] uppercase">soon</span>
                </span>
              ))}
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[11px] tracking-wide text-muted">
                Note password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="encrypts the note in this browser"
                className={field}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="font-mono text-[11px] tracking-wide text-muted">
                  Deposit, USDC
                </span>
                {/* Said once here rather than repeated on five chips. */}
                <span className="font-mono text-[11px] text-muted/70">fixed sizes only</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {AMOUNTS.map((a) => (
                  <button key={a} type="button" onClick={() => setAmount(a)} className={chip(amount === a)}>
                    {a}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={deposit}
                  disabled={busy !== null}
                  className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm transition-colors hover:bg-line/30 disabled:opacity-50"
                >
                  {busy === "depositing" ? "Depositing…" : "Deposit"}
                </button>
              </div>
            </div>

            <div className="space-y-2 border-t border-line pt-5">
              <label className="block font-mono text-[11px] tracking-wide text-muted">
                Send to
              </label>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                className={`${field} font-mono text-[12px]`}
              />
              <input
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                inputMode="decimal"
                placeholder="amount, USDC"
                className={field}
              />
            </div>

            {/* One primary action, full width — the reason the page exists. */}
            <button
              type="button"
              onClick={send}
              disabled={busy !== null || !stored}
              className="w-full rounded-xl bg-accent-strong px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy === "sending" ? "Sending…" : "Send privately"}
            </button>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted">
              <span className="font-mono">{stored ? "note saved in this browser" : "no note yet, deposit first"}</span>
              <div className="flex items-center gap-4">
                {stored ? (
                  <button
                    type="button"
                    onClick={() => setShowBackup((v) => !v)}
                    className="font-mono underline-offset-2 hover:underline"
                  >
                    {showBackup ? "hide backup" : "back up note"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={check}
                  disabled={busy !== null || !stored}
                  className="font-mono underline-offset-2 hover:underline disabled:opacity-40"
                >
                  {busy === "loading" ? "checking…" : "refresh balance"}
                </button>
              </div>
            </div>

            {/* One browser is one copy, and clearing site data is a thing
                people do without thinking about it. The text below is already
                encrypted with the password above, so it is safe to keep
                somewhere else and useless to anyone without it. */}
            {showBackup && stored ? (
              <div>
                <p className="mb-1.5 font-mono text-[11px] tracking-wide text-muted">
                  Encrypted note. Keep a copy somewhere other than this browser.
                </p>
                <textarea
                  readOnly
                  rows={3}
                  value={stored}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full resize-none rounded-xl border border-line bg-background/40 px-3.5 py-2.5 font-mono text-[11px] break-all outline-none"
                />
              </div>
            ) : null}
          </div>
        )}

        {error ? (
          <p className="mt-4 rounded-xl border border-accent/30 bg-accent/5 px-3.5 py-2.5 text-sm leading-relaxed text-accent">
            {error}
          </p>
        ) : null}
        {receipt ? (
          <p className="mt-4 rounded-xl border border-line bg-background/40 px-3.5 py-2.5 font-mono text-[12px] break-all text-emerald-500">
            {receipt}
          </p>
        ) : null}
      </div>

      {/* The three facts worth knowing before sending, as a strip rather than
          paragraphs — they are constraints, not prose. */}
      <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
        {[
          ["Custody", "Yours alone"],
          ["Networks", "Base · Polygon"],
          ["Recovery", "None. Keep the note"],
        ].map(([label, value]) => (
          <div key={label} className="bg-surface px-4 py-3.5">
            <p className="font-mono text-[10px] tracking-[0.12em] text-muted uppercase">{label}</p>
            <p className="mt-1 text-sm">{value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
