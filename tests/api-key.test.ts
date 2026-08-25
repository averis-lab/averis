import { describe, expect, it, vi } from "vitest";
import {
  constantTimeEqual,
  generateApiKey,
  hashApiKey,
  isWellFormedKey,
  maskApiKey,
} from "../apps/api/src/api-key";
import { requesterScope, resolvePrincipal, type KeyLookup } from "../apps/api/src/auth";

const account = { id: "user_1", handle: "alice", email: "alice@example.com" };
const lookupFound: KeyLookup = async () => account;
const lookupMissing: KeyLookup = async () => null;

describe("api key format", () => {
  it("generates keys that pass its own validity check", () => {
    for (let i = 0; i < 50; i++) expect(isWellFormedKey(generateApiKey())).toBe(true);
  });

  it("generates a distinct key every time", () => {
    const keys = new Set(Array.from({ length: 200 }, generateApiKey));
    expect(keys.size).toBe(200);
  });

  it.each([
    ["", "empty"],
    ["dev-key-local", "a root-style key"],
    ["av_short", "too short"],
    [`av_${"a".repeat(200)}`, "too long"],
    [`av_${"a".repeat(40)}!`, "an illegal character"],
    [`AV_${"a".repeat(40)}`, "the wrong prefix case"],
  ])("rejects %j (%s)", (key) => {
    expect(isWellFormedKey(key)).toBe(false);
  });

  it("hashes deterministically and does not echo the key", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toHaveLength(64);
    expect(hashApiKey(key)).not.toContain(key.slice(3));
  });

  it("masks down to a fingerprint", () => {
    const key = generateApiKey();
    expect(maskApiKey(key)).toContain(key.slice(-6));
    expect(maskApiKey(key)).not.toContain(key.slice(3, 20));
  });
});

describe("constantTimeEqual", () => {
  it("matches only identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("resolvePrincipal", () => {
  it("resolves a configured root key without touching the database", async () => {
    const lookup = vi.fn(lookupFound);
    const principal = await resolvePrincipal("root-key", { rootKeys: ["other", "root-key"], lookup });

    expect(principal).toMatchObject({ scope: "root", userId: null, label: "root" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never puts the raw key in the principal id", async () => {
    const principal = await resolvePrincipal("root-key", { rootKeys: ["root-key"], lookup: lookupFound });
    expect(principal?.id).not.toContain("root-key");
  });

  it("resolves an account key to its user", async () => {
    const key = generateApiKey();
    const lookup = vi.fn(lookupFound);
    const principal = await resolvePrincipal(key, { rootKeys: [], lookup });

    expect(principal).toMatchObject({ scope: "user", userId: "user_1", label: "alice" });
    expect(lookup).toHaveBeenCalledWith(hashApiKey(key));
  });

  it("falls back to the email, then the id, for a label", async () => {
    const key = generateApiKey();
    const noHandle = await resolvePrincipal(key, {
      rootKeys: [],
      lookup: async () => ({ ...account, handle: null }),
    });
    const neither = await resolvePrincipal(key, {
      rootKeys: [],
      lookup: async () => ({ ...account, handle: null, email: null }),
    });

    expect(noHandle?.label).toBe("alice@example.com");
    expect(neither?.label).toBe("user_1");
  });

  it("rejects an unknown but well-formed key", async () => {
    expect(await resolvePrincipal(generateApiKey(), { rootKeys: [], lookup: lookupMissing })).toBeNull();
  });

  it("rejects a malformed key without spending a lookup", async () => {
    const lookup = vi.fn(lookupFound);
    expect(await resolvePrincipal("garbage", { rootKeys: ["root-key"], lookup })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not let a near-miss of a root key through", async () => {
    const lookup = vi.fn(lookupFound);
    expect(await resolvePrincipal("root-ke", { rootKeys: ["root-key"], lookup })).toBeNull();
    expect(await resolvePrincipal("root-keyy", { rootKeys: ["root-key"], lookup })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("requesterScope", () => {
  it("restricts an account principal to its own rows", () => {
    expect(requesterScope({ id: "u", userId: "u", label: "alice", scope: "user" })).toEqual({
      requesterId: "u",
    });
  });

  it("leaves root and anonymous requests unrestricted", () => {
    expect(requesterScope({ id: "root:abc", userId: null, label: "root", scope: "root" })).toEqual({});
    expect(requesterScope(null)).toEqual({});
  });
});
