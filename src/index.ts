#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { TokenStore } from "./auth/token-store.js";
import type { PkcePair } from "./auth/oauth.js";
import { AuditLogger } from "./safety/audit.js";
import { IdempotencyStore } from "./safety/idempotency.js";
import { PreviewStore } from "./safety/preview-store.js";
import { HttpWorkdayClient } from "./workday/client.js";
import { FixtureWorkdayClient } from "./workday/fixtures.js";
import { registerGetMyTimeOffBalance } from "./tools/get-my-time-off-balance.js";
import { registerPreviewRequestTimeOff } from "./tools/preview-request-time-off.js";
import { registerCommitRequestTimeOff } from "./tools/commit-request-time-off.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const tokenStore = new TokenStore(config.tokenStorePath);
  const audit = new AuditLogger(config.auditLogPath);
  const previewStore = new PreviewStore();
  const idempotency = new IdempotencyStore();
  const pendingPkce = new Map<string, PkcePair>();
  const client = config.useFixtures
    ? new FixtureWorkdayClient()
    : new HttpWorkdayClient(config);

  // MCP stdio sessions are typically single-user; override via WORKDAY_USER_ID.
  const resolveUserId = (): string => process.env.WORKDAY_USER_ID?.trim() || "local-user";

  const server = new McpServer({
    name: "workday-mcp-schema",
    version: "0.1.0",
  });

  const deps = {
    config,
    client,
    audit,
    previewStore,
    idempotency,
    tokenStore,
    pendingPkce,
    resolveUserId,
  };

  registerGetMyTimeOffBalance(server, deps);
  registerPreviewRequestTimeOff(server, deps);
  registerCommitRequestTimeOff(server, deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
