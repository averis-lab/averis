"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { PrivyProvider, useIdentityToken, usePrivy } from "@privy-io/react-auth";

/**
 * Wallet identity for the product surface.
 *
 * Connecting a wallet here grants **identity, not custody**. Averis never asks
 * for a key, never holds one, and cannot sign anything — the address is used to
 * decide whose automations these are and nothing else.
 *
 * One context regardless of whether Privy is configured, so no component ever
 * has to call a hook conditionally. With no app id the provider still renders
 * and reports `enabled: false`, and the UI says so rather than showing a login
 * button that leads nowhere.
 */

interface WalletState {
  enabled: boolean;
  ready: boolean;
  connected: boolean;
  address: string | null;
  connect: () => void;
  disconnect: () => void;
}

const DISABLED: WalletState = {
  enabled: false,
  ready: true,
  connected: false,
  address: null,
  connect: () => {},
  disconnect: () => {},
};

const WalletContext = createContext<WalletState>(DISABLED);

export function useWallet(): WalletState {
  return useContext(WalletContext);
}

export function WalletProvider({
  appId,
  children,
}: {
  appId: string | null;
  children: React.ReactNode;
}) {
  if (!appId) {
    return <WalletContext.Provider value={DISABLED}>{children}</WalletContext.Provider>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Wallets only. Averis identifies an operator by the address that owns
        // their automations, and an email login with no wallet would produce an
        // account the gateway cannot identify.
        loginMethods: ["wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#e5484d",
          walletChainType: "solana-only",
        },
        // No embedded wallet is created. Averis has no use for one it would be
        // responsible for, and creating a wallet as a side effect of signing in
        // is how a product that holds nothing starts holding something.
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
      }}
    >
      <WalletBridge>{children}</WalletBridge>
    </PrivyProvider>
  );
}

/**
 * Publishes Privy's state into the context, and mirrors the identity token into
 * an HttpOnly cookie so Server Components can read who is viewing.
 */
function WalletBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const synced = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;

    // Only on change, because this writes a cookie and every write invalidates
    // the server-rendered pages that read it.
    const next = authenticated ? identityToken : null;
    if (synced.current === next) return;
    synced.current = next;

    const controller = new AbortController();
    if (next) {
      void fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: next }),
        signal: controller.signal,
      }).then(() => {
        // The pages that list automations are rendered server-side from this
        // cookie, so they have to be re-fetched now that it exists.
        window.location.reload();
      });
    } else {
      void fetch("/api/session", { method: "DELETE", signal: controller.signal });
    }

    return () => controller.abort();
  }, [ready, authenticated, identityToken]);

  const address = user?.wallet?.address ?? null;

  return (
    <WalletContext.Provider
      value={{
        enabled: true,
        ready,
        connected: ready && authenticated,
        address,
        connect: login,
        disconnect: () => {
          synced.current = null;
          void logout();
        },
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Connect / disconnect, sized for the sidebar footer. */
export function WalletButton() {
  const wallet = useWallet();

  if (!wallet.enabled) {
    return (
      <p className="px-2.5 py-1.5 text-[10px] leading-snug text-muted/70">
        Wallet login is off. Set <span className="font-mono">PRIVY_APP_ID</span> to own automations
        by wallet.
      </p>
    );
  }

  if (!wallet.ready) {
    return <div className="mx-2.5 my-1.5 h-7 animate-pulse rounded-lg bg-surface" />;
  }

  if (!wallet.connected) {
    return (
      <button
        type="button"
        onClick={wallet.connect}
        className="w-full rounded-lg border border-line px-2.5 py-1.5 text-xs transition-colors hover:border-accent hover:text-foreground"
      >
        Connect wallet
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-line px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="truncate font-mono text-[11px]">
          {wallet.address ? shortAddress(wallet.address) : "connected"}
        </span>
        <button
          type="button"
          onClick={wallet.disconnect}
          className="ml-auto shrink-0 text-[10px] text-muted transition-colors hover:text-foreground"
        >
          disconnect
        </button>
      </div>
    </div>
  );
}

/**
 * Shown in place of the automation pages when nobody has connected.
 *
 * The pages are not rendered with the app's shared key and then hidden: they
 * are not fetched at all. An automation is owned by the wallet that deployed
 * it, and rendering someone's book to whoever opens the page would make that
 * ownership decorative.
 */
export function ConnectGate() {
  const wallet = useWallet();

  return (
    <div className="rounded-xl border border-line bg-surface p-8 text-center">
      <p className="text-sm font-medium">Connect a wallet to continue</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted">
        An automation is owned by the wallet that deployed it, so this page has
        nothing to show until Averis knows who you are.
      </p>
      {wallet.enabled ? (
        <button
          type="button"
          onClick={wallet.connect}
          disabled={!wallet.ready}
          className="mt-4 rounded-lg bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {wallet.ready ? "Connect wallet" : "Loading…"}
        </button>
      ) : (
        <p className="mt-4 text-xs text-muted">
          Wallet login is not configured on this installation.
        </p>
      )}
      <p className="mx-auto mt-4 max-w-md border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
        Connecting proves which address is yours. Averis never asks for a key,
        holds none, and cannot sign or move anything — the address decides whose
        automations these are, and nothing else.
      </p>
    </div>
  );
}
