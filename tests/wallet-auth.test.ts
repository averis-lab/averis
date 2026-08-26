import { describe, expect, it, vi } from "vitest";
import {
  resolvePrincipal,
  type KeyLookup,
  type WalletLookup,
} from "../apps/api/src/auth";
import { isJwtShaped, resolvePrivyConfig } from "../apps/api/src/privy";

const lookup: KeyLookup = async () => null;

// A JWT-shaped string. Never parsed here — the verifier is what decides
// whether it means anything, and in these tests the verifier is a stub.
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJkaWQ6cHJpdnk6MSJ9.c2ln";

const verified = { privyId: "did:privy:abc", walletAddress: "So11111111111111111111111111111111111111112" };

const walletLookup: WalletLookup = async ({ privyId, walletAddress }) => ({
  id: "user_wallet",
  handle: null,
  walletAddress,
  privyId,
}) as never;

describe("token shape", () => {
  it("recognises a JWT and rejects everything else", () => {
    expect(isJwtShaped(TOKEN)).toBe(true);
    for (const bad of ["", "a.b", "a.b.c.d", "av_livekey", "dev-key-local", "a.b.$"]) {
      expect(isJwtShaped(bad)).toBe(false);
    }
  });
});

describe("privy configuration", () => {
  it("is off when neither half is set", () => {
    expect(resolvePrivyConfig({})).toBeNull();
    expect(resolvePrivyConfig({ PRIVY_APP_ID: "  ", PRIVY_APP_SECRET: "" })).toBeNull();
  });

  it("refuses to start half-configured", () => {
    // An app id with no secret would render a login button whose tokens the
    // gateway then rejects one at a time — worse than no button at all.
    expect(() => resolvePrivyConfig({ PRIVY_APP_ID: "app" })).toThrow(/half-configured/);
    expect(() => resolvePrivyConfig({ PRIVY_APP_SECRET: "s" })).toThrow(/half-configured/);
  });
});

describe("wallet principals", () => {
  it("resolves a verified token to the wallet's account", async () => {
    const principal = await resolvePrincipal(TOKEN, {
      rootKeys: [],
      lookup,
      verifyWallet: async () => verified,
      walletLookup,
    });

    expect(principal).toMatchObject({
      userId: "user_wallet",
      scope: "user",
      walletAddress: verified.walletAddress,
    });
    // Labelled by a truncated address, so logs never carry a full one verbatim.
    expect(principal?.label).toBe("So11…1112");
  });

  it("rejects a token the verifier will not vouch for", async () => {
    const verifyWallet = vi.fn(async () => null);
    expect(
      await resolvePrincipal(TOKEN, { rootKeys: [], lookup, verifyWallet, walletLookup }),
    ).toBeNull();
    expect(verifyWallet).toHaveBeenCalledOnce();
  });

  it("never reaches the account lookup when the token is unverified", async () => {
    const spy = vi.fn(walletLookup);
    await resolvePrincipal(TOKEN, {
      rootKeys: [],
      lookup,
      verifyWallet: async () => null,
      walletLookup: spy,
    });
    // The order matters: a forged token must not be able to create an account.
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a JWT outright when wallet login is off", async () => {
    // No verifier configured. The token must not fall through to the API-key
    // path and must not be trusted for lack of anything to check it against.
    const spy = vi.fn(walletLookup);
    expect(
      await resolvePrincipal(TOKEN, { rootKeys: [], lookup, walletLookup: spy }),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("still lets a root key through, and never treats one as a wallet", async () => {
    const verifyWallet = vi.fn(async () => verified);
    const principal = await resolvePrincipal("dev-key-local", {
      rootKeys: ["dev-key-local"],
      lookup,
      verifyWallet,
      walletLookup,
    });

    expect(principal?.scope).toBe("root");
    expect(principal?.walletAddress).toBeUndefined();
    // Root is matched first, so the infrastructure path never calls Privy.
    expect(verifyWallet).not.toHaveBeenCalled();
  });
});
