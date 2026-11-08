/**
 * Builds the stdio MCP server (tools, RBAC, stores). Split from index.ts so checks can
 * construct the exact server surface without a stdio transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenStoreSecret, workdayClientOptions, type AppConfig } from "./config.js";
import { TokenStore } from "./auth/token-store.js";
import type { PkcePair } from "./auth/oauth.js";
import { AuditLogger } from "./safety/audit.js";
import { IdempotencyStore } from "./safety/idempotency.js";
import { PreviewStore } from "./safety/preview-store.js";
import { HttpWorkdayClient, type WorkdayClient } from "./workday/client.js";
import { FixtureWorkdayClient } from "./workday/fixtures.js";
import { registerGetMyTimeOffBalance } from "./tools/get-my-time-off-balance.js";
import { registerPreviewRequestTimeOff } from "./tools/preview-request-time-off.js";
import { registerCommitRequestTimeOff } from "./tools/commit-request-time-off.js";
import { registerScaffoldTools } from "./tools/scaffold-tools.js";
import { registerAgentReadyCatalog } from "./tools/agent-ready-catalog.js";
import { assertRegistryInvariants } from "./tools/registry.js";
import { registeredToolNames } from "./tools/framework.js";
import { FixtureWorkdayDomainClient } from "./workday/domain-fixtures.js";
import { HttpWorkdayDomainClient, type WorkdayDomainClient } from "./workday/domain.js";
import { createAssignmentStore, resolveRolesFromEnv, type Role } from "./rbac/index.js";

export type McpServerOptions = {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
  client?: WorkdayClient;
  domain?: WorkdayDomainClient;
};

export function buildMcpServer(opts: McpServerOptions) {
  const { config } = opts;
  const env = opts.env ?? process.env;
  const tokenStore = new TokenStore(config.tokenStorePath, tokenStoreSecret(config, env));
  const audit = new AuditLogger(config.auditLogPath);
  const previewStore = new PreviewStore();
  const idempotency = new IdempotencyStore();
  const pendingPkce = new Map<string, PkcePair>();
  const client =
    opts.client ?? (config.useFixtures ? new FixtureWorkdayClient() : new HttpWorkdayClient(config, workdayClientOptions(config)));
  const domain = opts.domain ?? (config.useFixtures ? new FixtureWorkdayDomainClient() : new HttpWorkdayDomainClient(config));

  // MCP stdio sessions are typically single-user; override via WORKDAY_USER_ID.
  const resolveUserId = (): string => env.WORKDAY_USER_ID?.trim() || "local-user";

  // Fixture/dev: roles from WORKDAY_USER_ROLES. Production: derive from Workday security groups.
  const userRoles = resolveRolesFromEnv(env);
  // Lowest-level user grants/denies (JSON file + WORKDAY_USER_GRANTS / WORKDAY_USER_DENIES).
  const assignments = createAssignmentStore(env);
  const resolveUserRoles = (): Role[] => {
    const a = assignments.get(resolveUserId());
    if (a?.roles?.length) return a.roles;
    return userRoles;
  };

  const server = new McpServer({ name: "workday-mcp-schema", version: "0.1.0" });

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
    assignments,
  };

  registerGetMyTimeOffBalance(server, deps);
  registerPreviewRequestTimeOff(server, deps);
  registerCommitRequestTimeOff(server, deps);
  registerScaffoldTools(server, deps);
  registerAgentReadyCatalog(server, deps);

  // Fail closed if registered tools drift from the registry (no passthrough, no payroll writes).
  assertRegistryInvariants(registeredToolNames(server));

  return { server, deps };
}
