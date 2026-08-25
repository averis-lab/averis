import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constantTimeEqual, hashApiKey, isWellFormedKey } from "./api-key";

/**
 * Who is making this request.
 *
 * `root` keys come from `API_KEYS` and see every tenant's work — the operator,
 * the workers and the demo run as root. `user` keys are minted per account
 * (`npm run key:create`), stored only as a hash, and see only their own jobs.
 */
export interface Principal {
  /** Stable identifier for logs and rate-limit buckets; never the raw key. */
  id: string;
  /** The account this key belongs to; null for a root key. */
  userId: string | null;
  label: string;
  scope: "root" | "user";
}

declare module "fastify" {
  interface FastifyRequest {
    /** Identity resolved from the API key, null when auth is disabled. */
    principal: Principal | null;
  }
}

/** Looks a hashed key up in the account registry. Injectable for tests. */
export type KeyLookup = (
  keyHash: string,
) => Promise<{ id: string; handle: string | null; email: string | null } | null>;

/**
 * Imported on first use, not at module load: constructing the Prisma client
 * requires DATABASE_URL, and the key primitives above have to stay testable
 * without a database behind them.
 */
const prismaLookup: KeyLookup = async (keyHash) => {
  const { prisma } = await import("@averis/db");
  return prisma.user.findUnique({
    where: { apiKeyHash: keyHash },
    select: { id: true, handle: true, email: true },
  });
};

export interface ResolveOptions {
  rootKeys: string[];
  lookup: KeyLookup;
}

/**
 * Resolves a presented key to a principal, or null if it matches nothing.
 *
 * Root keys are checked in constant time and first, so the common
 * infrastructure path never touches the database. A key that does not even
 * look like one of ours is rejected without a lookup.
 */
export async function resolvePrincipal(
  provided: string,
  { rootKeys, lookup }: ResolveOptions,
): Promise<Principal | null> {
  // `some` over a constant-time compare: the number of comparisons depends on
  // how many root keys are configured, never on how many bytes matched.
  if (rootKeys.some((key) => constantTimeEqual(key, provided))) {
    return {
      id: `root:${hashApiKey(provided).slice(0, 12)}`,
      userId: null,
      label: "root",
      scope: "root",
    };
  }

  if (!isWellFormedKey(provided)) return null;

  const user = await lookup(hashApiKey(provided));
  if (!user) return null;

  return {
    id: user.id,
    userId: user.id,
    label: user.handle ?? user.email ?? user.id,
    scope: "user",
  };
}

/**
 * The bearer token behind either accepted header.
 *
 * Takes a getter rather than a request so the x402 paywall, which only sees the
 * protocol's own request adapter, resolves keys exactly the way this hook does.
 */
export function extractKeyFrom(get: (name: string) => string | undefined): string | null {
  const header = get("authorization");
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  const alternate = get("x-api-key");
  return typeof alternate === "string" && alternate.length > 0 ? alternate : null;
}

/** The bearer token on a Fastify request. */
export function extractKey(request: FastifyRequest): string | null {
  return extractKeyFrom((name) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  });
}

/**
 * A short-lived cache of successful resolutions.
 *
 * Without it every request costs a lookup. Only hits are cached — a miss is
 * cheap to reject and caching it would let one bad request pin a 401 in place
 * for a key that was just minted. The TTL is also the revocation window: a
 * deleted key keeps working for at most this long.
 */
class PrincipalCache {
  private readonly entries = new Map<string, { principal: Principal; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  get(keyHash: string): Principal | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(keyHash);
      return null;
    }
    return entry.principal;
  }

  set(keyHash: string, principal: Principal): void {
    // Bounded so a stream of distinct valid keys cannot grow it without limit.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(keyHash, { principal, expiresAt: Date.now() + this.ttlMs });
  }
}

export interface AuthOptions {
  /** Overrides the account lookup; tests inject a stub here. */
  lookup?: KeyLookup;
  /** Resolution cache lifetime, and therefore the revocation window. */
  cacheTtlMs?: number;
  /**
   * Routes that may proceed without a key.
   *
   * Used by the x402 paywall: on a paid route the payment is the credential,
   * so a keyless request must reach the paywall rather than being turned away
   * here. It still arrives with no principal, and therefore no tenancy.
   */
  allowAnonymous?: (request: FastifyRequest) => boolean;
}

/**
 * API-key authentication.
 *
 * An empty `API_KEYS` disables authentication — intended for local development
 * only, and logged loudly at startup so it cannot be enabled in production by
 * accident. Even then a well-formed account key is still resolved, so tenancy
 * can be exercised locally without configuring a root key.
 */
export function registerAuth(
  app: FastifyInstance,
  keys: string[],
  options: AuthOptions = {},
): void {
  const enabled = keys.length > 0;
  const lookup = options.lookup ?? prismaLookup;
  const cache = new PrincipalCache(options.cacheTtlMs ?? 30_000);
  const allowAnonymous = options.allowAnonymous ?? (() => false);

  if (!enabled) {
    app.log.warn(
      "API_KEYS is empty — authentication is DISABLED. Never run this configuration in production.",
    );
  }

  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Health and docs stay reachable for probes.
    if (request.url === "/health" || request.url === "/" || request.method === "OPTIONS") return;

    const provided = extractKey(request);

    if (!provided) {
      if (!enabled || allowAnonymous(request)) {
        request.principal = null;
        return;
      }
      return reply.code(401).send({ error: "Unauthorized: provide a valid API key" });
    }

    const keyHash = hashApiKey(provided);
    const cached = cache.get(keyHash);
    if (cached) {
      request.principal = cached;
      return;
    }

    const principal = await resolvePrincipal(provided, { rootKeys: keys, lookup });

    if (!principal) {
      // With auth off an unrecognized key is not an error — it just carries no
      // identity, which is the same footing as sending no key at all.
      if (!enabled) {
        request.principal = null;
        return;
      }
      return reply.code(401).send({ error: "Unauthorized: provide a valid API key" });
    }

    cache.set(keyHash, principal);
    request.principal = principal;
  });
}

/**
 * The `where` fragment that limits a query to what this principal may read.
 *
 * Root and auth-disabled requests get `{}` — everything. An account key gets
 * its own rows only, and because it is a filter rather than a post-fetch check,
 * another tenant's job is indistinguishable from one that never existed.
 */
export function requesterScope(principal: Principal | null): { requesterId?: string } {
  return principal?.scope === "user" && principal.userId
    ? { requesterId: principal.userId }
    : {};
}
