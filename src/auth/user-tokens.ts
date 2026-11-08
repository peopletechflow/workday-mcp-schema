/**
 * Per-user Workday access tokens from the durable encrypted store. Refresh runs under a row
 * lock so concurrent instances do not race a rotating refresh token. No shared token fallback.
 */
import type { AppConfig } from "../config.js";
import type { Db } from "../store/db.js";
import type { DbTokenStore } from "../store/repos.js";
import { OAuthTokenError, refreshAccessToken } from "./oauth.js";

export class LinkRequiredError extends Error {
  constructor() {
    super("Workday sign-in required. Run the link command to connect your Workday account.");
    this.name = "LinkRequiredError";
  }
}

/** Token endpoint unreachable / 5xx / timeout. The stored token is kept; retry later. */
export class TokenRefreshUnavailableError extends Error {
  constructor() {
    super("Workday sign-in service is temporarily unavailable. Try again in a few minutes.");
    this.name = "TokenRefreshUnavailableError";
  }
}

export type AccessTokenProvider = (userId: string) => Promise<string>;

export function durableAccessTokens(db: Db, store: DbTokenStore, config: AppConfig, fetchImpl: typeof fetch = fetch): AccessTokenProvider {
  return async (userId) => {
    const fresh = await store.get(userId);
    if (!fresh) throw new LinkRequiredError();
    if (fresh.expiresAt > Date.now() + 60_000) return fresh.accessToken;
    return db.tx(async (q) => {
      const t = await store.get(userId, q, true);
      if (!t) throw new LinkRequiredError();
      if (t.expiresAt > Date.now() + 60_000) return t.accessToken; // another instance refreshed
      if (!t.refreshToken) {
        await store.delete(userId, q);
        throw new LinkRequiredError();
      }
      let next;
      try {
        next = await refreshAccessToken(config, t.refreshToken, fetchImpl); // bounded by OAUTH_HTTP_TIMEOUT_MS
      } catch (e) {
        // Only a refused grant (400/401, e.g. invalid_grant) means the link is dead.
        // Outages and timeouts keep the token so a blip does not force a re-link.
        if (e instanceof OAuthTokenError && e.definitive) {
          await store.delete(userId, q);
          throw new LinkRequiredError();
        }
        throw new TokenRefreshUnavailableError();
      }
      await store.set(userId, next, q);
      return next.accessToken;
    }).catch(async (e) => {
      // tx rolled back on LinkRequired after delete; delete again outside tx so revocation sticks.
      if (e instanceof LinkRequiredError) await store.delete(userId).catch(() => {});
      throw e;
    });
  };
}
