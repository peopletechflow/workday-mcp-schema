import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
};

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
};

/**
 * Per-user OAuth 2.0 authorization code + PKCE helpers.
 * No shared service-account fallback — missing token means sign-in required.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthorizeUrl(config: AppConfig, pkce: PkcePair): string {
  const url = new URL(config.oauthAuthorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.oauthClientId);
  url.searchParams.set("redirect_uri", config.oauthRedirectUri);
  url.searchParams.set("scope", config.oauthScopes);
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: AppConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.oauthRedirectUri,
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    code_verifier: codeVerifier,
  });

  const res = await fetchImpl(config.oauthTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return normalizeTokenResponse(json);
}

export async function refreshAccessToken(
  config: AppConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
  });

  const res = await fetchImpl(config.oauthTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`OAuth refresh failed: HTTP ${res.status}. User must sign in again.`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const tokens = normalizeTokenResponse(json);
  if (!tokens.refreshToken) {
    tokens.refreshToken = refreshToken;
  }
  return tokens;
}

function normalizeTokenResponse(json: Record<string, unknown>): OAuthTokens {
  const accessToken = String(json.access_token ?? "");
  if (!accessToken) {
    throw new Error("OAuth response missing access_token");
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken,
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: String(json.token_type ?? "Bearer"),
    scope: json.scope ? String(json.scope) : undefined,
  };
}

/** Thrown when the caller has no usable token — MCP clients should prompt sign-in. */
export class SignInRequiredError extends Error {
  readonly authorizeUrl: string;

  constructor(authorizeUrl: string) {
    super("Workday sign-in required. Complete OAuth as the user; no shared account fallback.");
    this.name = "SignInRequiredError";
    this.authorizeUrl = authorizeUrl;
  }
}
