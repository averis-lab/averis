import { createHash, randomBytes } from "node:crypto";

/**
 * API key primitives.
 *
 * Keys are shown to their owner exactly once and stored only as a SHA-256
 * digest, so a database dump cannot be replayed against the gateway. The
 * prefix and fixed alphabet are not decoration: an unrecognizable string is
 * rejected before it reaches the database, which keeps a flood of invented
 * keys from turning into a lookup per request.
 */

export const API_KEY_PREFIX = "av_";

/** 32 bytes of entropy, base64url so the whole key stays header-safe. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cheap syntactic gate applied before any lookup. */
export function isWellFormedKey(key: string): boolean {
  return /^av_[A-Za-z0-9_-]{40,86}$/.test(key);
}

/** Last 6 characters, enough to tell two of your own keys apart. */
export function maskApiKey(key: string): string {
  return `${API_KEY_PREFIX}…${key.slice(-6)}`;
}

/**
 * Constant-time comparison; length is compared without an early return so a
 * timing side channel cannot recover a key one byte at a time.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
