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
  /** Epoch ms; pending sign-ins older than PKCE_TTL_MS are discarded. */
  createdAt: number;
};

export const PKCE_TTL_MS = 10 * 60 * 1000;
const PKCE_MAX_PENDING = 20;
export const OAUTH_HTTP_TIMEOUT_MS = 15_000;

/**
 * Token endpoint failure. `definitive` is true when the grant itself was refused
 * (HTTP 400/401, e.g. invalid_grant): the stored refresh token is dead and the user must
 * sign in again. Otherwise (5xx, 429, network error, timeout) the token may still be valid.
 */
export class OAuthTokenError extends Error {
  constructor(readonly status: number | undefined, readonly definitive: boolean, message: string) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

/** Remember a pending sign-in, dropping expired entries and capping the map size. */
export function rememberPkce(pending: Map<string, PkcePair>, pkce: PkcePair, now = Date.now()): void {
  for (const [state, p] of pending) if (now - p.createdAt > PKCE_TTL_MS) pending.delete(state);
  while (pending.size >= PKCE_MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  pending.set(pkce.state, pkce);
}

/** Take (single use) a pending sign-in by state. Undefined when unknown or expired. */
export function takePkce(pending: Map<string, PkcePair>, state: string, now = Date.now()): PkcePair | undefined {
  const p = pending.get(state);
  pending.delete(state);
  return p && now - p.createdAt <= PKCE_TTL_MS ? p : undefined;
}

/**
 * Per-user OAuth 2.0 authorization code + PKCE helpers.
 * No shared service-account fallback — missing token means sign-in required.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  return { codeVerifier, codeChallenge, state, createdAt: Date.now() };
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

async function postTokenEndpoint(
  config: AppConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  what: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(config.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new OAuthTokenError(undefined, false, `${what} failed: token endpoint unreachable or timed out.`);
  }
  if (!res.ok) {
    const definitive = res.status === 400 || res.status === 401;
    throw new OAuthTokenError(res.status, definitive, `${what} failed: HTTP ${res.status}.`);
  }
  return (await res.json()) as Record<string, unknown>;
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
  return normalizeTokenResponse(await postTokenEndpoint(config, body, fetchImpl, "OAuth token exchange"));
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
  const tokens = normalizeTokenResponse(await postTokenEndpoint(config, body, fetchImpl, "OAuth refresh"));
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
