/**
 * Per-user Workday access tokens from the durable encrypted store. Refresh runs under a row
 * lock so concurrent instances do not race a rotating refresh token. No shared token fallback.
 */
import type { AppConfig } from "../config.js";
import type { Db } from "../store/db.js";
import type { DbTokenStore } from "../store/repos.js";
import { refreshAccessToken } from "./oauth.js";

export class LinkRequiredError extends Error {
  constructor() {
    super("Workday sign-in required. Run the link command to connect your Workday account.");
    this.name = "LinkRequiredError";
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
      try {
        const next = await refreshAccessToken(config, t.refreshToken, fetchImpl);
        await store.set(userId, next, q);
        return next.accessToken;
      } catch {
        await store.delete(userId, q);
        throw new LinkRequiredError();
      }
    }).catch(async (e) => {
      // tx rolled back on LinkRequired after delete; delete again outside tx so revocation sticks.
      if (e instanceof LinkRequiredError) await store.delete(userId).catch(() => {});
      throw e;
    });
  };
}
