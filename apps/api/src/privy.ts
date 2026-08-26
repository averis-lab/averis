/**
 * Wallet identity, verified rather than asserted.
 *
 * The browser presents a Privy **identity token** and the gateway checks its
 * signature before believing a single field in it. That distinction is the
 * whole design: a wallet address sent as a parameter is a claim anyone can
 * make, and an endpoint that trusts one has authentication in name only —
 * knowing someone's address would be enough to act as them.
 *
 * What is verified here is only *who*. Nothing in this file can sign, spend or
 * move anything: Averis holds no keys, and connecting a wallet grants identity,
 * not custody.
 */

export interface PrivyConfig {
  appId: string;
  appSecret: string;
}

export interface VerifiedWallet {
  /** Privy DID — stable across wallet changes. */
  privyId: string;
  /** The address the identity token says this person controls. */
  walletAddress: string;
}

export type WalletVerifier = (token: string) => Promise<VerifiedWallet | null>;

/**
 * Reads the Privy configuration, or null when wallet login is off.
 *
 * Both halves are required together. An app id without a secret cannot verify
 * anything, and starting with a login button that leads to a gateway which
 * rejects every token is worse than not offering the button.
 */
export function resolvePrivyConfig(env: Record<string, string | undefined>): PrivyConfig | null {
  const appId = env["PRIVY_APP_ID"]?.trim();
  const appSecret = env["PRIVY_APP_SECRET"]?.trim();

  if (!appId && !appSecret) return null;
  if (!appId || !appSecret) {
    throw new Error(
      "Privy is half-configured: PRIVY_APP_ID and PRIVY_APP_SECRET must both be set, or neither.",
    );
  }
  return { appId, appSecret };
}

/**
 * A JWT-shaped bearer token.
 *
 * Checked before anything expensive so an ordinary API key never reaches the
 * Privy path, and a malformed token never reaches the verifier.
 */
export function isJwtShaped(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

/**
 * Builds the verifier.
 *
 * The SDK is imported dynamically, so an installation with wallet login off
 * never loads `@privy-io/server-auth` and never pays for its dependency tree at
 * startup — the same reason the x402 SDK is imported the way it is.
 *
 * `getUser({ idToken })` parses and verifies the token locally. The alternative,
 * `getUserById`, is an authenticated round trip to Privy on every request and is
 * rate limited; putting it in the auth hook would make Privy's availability a
 * dependency of every read this gateway serves.
 */
export function createWalletVerifier(config: PrivyConfig): WalletVerifier {
  let clientPromise: Promise<{ getUser(props: { idToken: string }): Promise<unknown> }> | null =
    null;

  const client = async () => {
    if (!clientPromise) {
      clientPromise = import("@privy-io/server-auth").then(
        ({ PrivyClient }) =>
          new PrivyClient(config.appId, config.appSecret) as unknown as {
            getUser(props: { idToken: string }): Promise<unknown>;
          },
      );
    }
    return clientPromise;
  };

  return async (token: string): Promise<VerifiedWallet | null> => {
    if (!isJwtShaped(token)) return null;

    try {
      const privy = await client();
      const user = (await privy.getUser({ idToken: token })) as {
        id?: string;
        wallet?: { address?: string };
      };

      const privyId = user.id;
      const walletAddress = user.wallet?.address;

      // An account with no linked wallet is a valid Privy user and still not
      // someone this gateway can identify: automations are owned by a wallet.
      // Returning null here surfaces as a plain 401 rather than an account with
      // no address that later fails somewhere less obvious.
      if (!privyId || !walletAddress) return null;

      return { privyId, walletAddress };
    } catch {
      // An expired, forged or wrong-app token all land here and are all the
      // same answer: this is not someone we can identify.
      return null;
    }
  };
}
