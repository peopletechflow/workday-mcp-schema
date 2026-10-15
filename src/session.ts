import type { AppConfig } from "./config.js";
import {
  SignInRequiredError,
  buildAuthorizeUrl,
  createPkcePair,
  refreshAccessToken,
  type OAuthTokens,
  type PkcePair,
} from "./auth/oauth.js";
import type { TokenStore } from "./auth/token-store.js";

/**
 * Resolve a usable access token for the caller.
 * Never falls back to a shared service account.
 */
export async function requireUserAccessToken(
  config: AppConfig,
  tokenStore: TokenStore,
  userId: string,
  pendingPkce: Map<string, PkcePair>,
): Promise<string> {
  const existing = await tokenStore.get(userId);
  if (!existing) {
    const pkce = createPkcePair();
    pendingPkce.set(pkce.state, pkce);
    throw new SignInRequiredError(buildAuthorizeUrl(config, pkce));
  }

  if (existing.expiresAt > Date.now() + 60_000) {
    return existing.accessToken;
  }

  if (!existing.refreshToken) {
    await tokenStore.delete(userId);
    const pkce = createPkcePair();
    pendingPkce.set(pkce.state, pkce);
    throw new SignInRequiredError(buildAuthorizeUrl(config, pkce));
  }

  const refreshed: OAuthTokens = await refreshAccessToken(config, existing.refreshToken);
  await tokenStore.set(userId, refreshed);
  return refreshed.accessToken;
}

/**
 * Dev helper: when using fixtures, seed a short-lived fake token so tools
 * are exercisable without a live OAuth dance.
 */
export async function ensureFixtureSession(
  config: AppConfig,
  tokenStore: TokenStore,
  userId: string,
): Promise<void> {
  if (!config.useFixtures) return;
  const existing = await tokenStore.get(userId);
  if (existing && existing.expiresAt > Date.now()) return;
  await tokenStore.set(userId, {
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    tokenType: "Bearer",
    scope: config.oauthScopes,
  });
}
