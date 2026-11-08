#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildMcpServer } from "./mcp-server.js";
import { startLoopbackCallback } from "./auth/loopback-callback.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, deps } = buildMcpServer({ config });

  // Live mode: serve the OAuth redirect on loopback so SIGN_IN_REQUIRED can complete.
  if (!config.useFixtures) {
    startLoopbackCallback({
      config,
      tokenStore: deps.tokenStore,
      pendingPkce: deps.pendingPkce,
      resolveUserId: deps.resolveUserId,
    });
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
