/**
 * Loopback OAuth redirect listener for the stdio MCP server (live mode only).
 *
 * The sign-in URL returned with SIGN_IN_REQUIRED points Workday back to
 * WORKDAY_OAUTH_REDIRECT_URI. This listener serves that path on a loopback address, checks the
 * single-use state against the pending PKCE map, exchanges the code, and stores the tokens
 * for the local MCP user. It refuses non-loopback redirect URIs: a remote callback belongs to
 * the integration runtime (src/server), not to a desktop stdio process.
 * Logs go to stderr only (stdout is the MCP channel).
 */
import { createServer, type Server } from "node:http";
import type { AppConfig } from "../config.js";
import type { TokenStore } from "./token-store.js";
import { exchangeAuthorizationCode, takePkce, type PkcePair } from "./oauth.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackRedirect(redirectUri: string): boolean {
  const u = new URL(redirectUri);
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && u.port !== "";
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Workday sign-in</title><p>${message.replace(/[<>&]/g, "")}</p>`;

export function createLoopbackCallbackServer(opts: {
  config: AppConfig;
  tokenStore: TokenStore;
  pendingPkce: Map<string, PkcePair>;
  resolveUserId: () => string;
  fetchImpl?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
}): Server {
  const redirect = new URL(opts.config.oauthRedirectUri);
  const log = opts.log ?? ((l) => process.stderr.write(`${JSON.stringify({ src: "oauth-callback", ...l })}\n`));
  const server = createServer(async (req, res) => {
    const reply = (status: number, message: string) =>
      void res
        .writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(page(message));
    try {
      const u = new URL(req.url ?? "/", redirect.origin);
      if (req.method !== "GET" || u.pathname !== redirect.pathname) return reply(404, "Not found.");
      if (u.searchParams.get("error")) return reply(400, "Sign-in was cancelled or denied.");
      const state = u.searchParams.get("state") ?? "";
      const code = u.searchParams.get("code") ?? "";
      if (!state || !code || code.length > 2048) return reply(400, "Invalid sign-in response.");
      const pkce = takePkce(opts.pendingPkce, state);
      if (!pkce) return reply(400, "Sign-in link expired or already used. Ask the assistant to try again.");
      const tokens = await exchangeAuthorizationCode(opts.config, code, pkce.codeVerifier, opts.fetchImpl);
      await opts.tokenStore.set(opts.resolveUserId(), tokens);
      log({ evt: "signed_in" });
      return reply(200, "Signed in to Workday. You can close this window and retry your request.");
    } catch (e) {
      log({ evt: "callback_error", err: e instanceof Error ? e.name : "error" });
      if (!res.headersSent) reply(502, "Workday sign-in failed. Try again.");
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

/** Start listening on the redirect URI's loopback host/port. Returns undefined when not applicable. */
export function startLoopbackCallback(opts: Parameters<typeof createLoopbackCallbackServer>[0]): Server | undefined {
  if (!isLoopbackRedirect(opts.config.oauthRedirectUri)) {
    process.stderr.write(
      `${JSON.stringify({ src: "oauth-callback", evt: "skipped", reason: "WORKDAY_OAUTH_REDIRECT_URI is not an http loopback URI with a port" })}\n`,
    );
    return undefined;
  }
  const u = new URL(opts.config.oauthRedirectUri);
  const server = createLoopbackCallbackServer(opts);
  server.on("error", (e) =>
    process.stderr.write(
      `${JSON.stringify({ src: "oauth-callback", evt: "listen_failed", err: (e as NodeJS.ErrnoException).code ?? e.name })}\n`,
    ),
  );
  server.listen(Number(u.port), u.hostname.replace(/^\[|\]$/g, ""));
  server.unref();
  return server;
}
