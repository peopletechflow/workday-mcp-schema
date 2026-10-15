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
import { registerScaffoldTools } from "./tools/scaffold-tools.js";
import { registerAgentReadyCatalog } from "./tools/agent-ready-catalog.js";
import { TOOL_REGISTRY, assertRegistryInvariants } from "./tools/registry.js";
import { FixtureWorkdayDomainClient } from "./workday/domain-fixtures.js";
import { HttpWorkdayDomainClient } from "./workday/domain.js";
import { resolveRolesFromEnv } from "./rbac/index.js";

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
  const domain = config.useFixtures
    ? new FixtureWorkdayDomainClient()
    : new HttpWorkdayDomainClient(config);

  // MCP stdio sessions are typically single-user; override via WORKDAY_USER_ID.
  const resolveUserId = (): string => process.env.WORKDAY_USER_ID?.trim() || "local-user";

  // Fixture/dev: roles from WORKDAY_USER_ROLES. Production: derive from Workday security groups.
  const userRoles = resolveRolesFromEnv();
  const resolveUserRoles = () => userRoles;

  const server = new McpServer({
    name: "workday-mcp-schema",
    version: "0.1.0",
  });

  const deps = {
    config,
    client,
    domain,
    audit,
    previewStore,
    idempotency,
    tokenStore,
    pendingPkce,
    resolveUserId,
    resolveUserRoles,
  };

  // Track every registration so the registry invariant check sees the real surface.
  const registeredNames: string[] = [];
  const originalRegister = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (...a: unknown[]) => {
    registeredNames.push(String(a[0]));
    return originalRegister(...a);
  };

  registerGetMyTimeOffBalance(server, deps);
  registerPreviewRequestTimeOff(server, deps);
  registerCommitRequestTimeOff(server, deps);
  registerScaffoldTools(server, deps);
  registerAgentReadyCatalog(server, deps);

  // Fail closed if registered tools drift from the registry (no passthrough, no payroll writes).
  assertRegistryInvariants(registeredNames);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
