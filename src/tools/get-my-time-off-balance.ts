import { z } from "zod";
import { getMyTimeOffBalance } from "../schemas/tools/self-service.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IsoDateSchema } from "../schemas/common.js";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import type { WorkdayClient } from "../workday/client.js";
import { WorkdayApiError } from "../workday/client.js";
import type { AuditLogger } from "../safety/audit.js";
import { SignInRequiredError } from "../auth/oauth.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { ensureFixtureSession, requireUserAccessToken } from "../session.js";

// Input contract lives in src/schemas/tools (schema-first).
const InputSchema = getMyTimeOffBalance.input;

export function registerGetMyTimeOffBalance(
  server: McpServer,
  deps: {
    config: AppConfig;
    client: WorkdayClient;
    audit: AuditLogger;
    tokenStore: TokenStore;
    pendingPkce: Map<string, PkcePair>;
    resolveUserId: () => string;
  },
): void {
  const toolName = "get_my_time_off_balance";

  server.registerTool(
    toolName,
    {
      title: "Get my time-off balance",
      description:
        "Read-only. Returns the signed-in user's time-off balances (available and pending) " +
        "as flattened JSON. Uses the caller's OAuth token so Workday security groups apply. " +
        "Who: any authenticated worker with Absence self-view. Does not write.",
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const started = Date.now();
      const userId = deps.resolveUserId();
      try {
        assertToolEnabled(deps.config, toolName);
        await ensureFixtureSession(deps.config, deps.tokenStore, userId);
        const accessToken = await requireUserAccessToken(
          deps.config,
          deps.tokenStore,
          userId,
          deps.pendingPkce,
        );
        const balances = await deps.client.getMyTimeOffBalances(accessToken, args.asOf);
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: toolName,
          inputs: args,
          result: "ok",
          latencyMs: Date.now() - started,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ balances }, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err, deps.audit, userId, toolName, args, started);
      }
    },
  );
}

async function handleToolError(
  err: unknown,
  audit: AuditLogger,
  userId: string,
  tool: string,
  inputs: unknown,
  started: number,
) {
  const message =
    err instanceof SignInRequiredError
      ? `${err.message}\nAuthorize URL: ${err.authorizeUrl}`
      : err instanceof WorkdayApiError
        ? `Workday error (${err.fault.code}): ${err.fault.message}`
        : err instanceof Error
          ? err.message
          : "Unknown error";

  await audit.log({
    ts: new Date().toISOString(),
    userId,
    tool,
    inputs,
    result: err instanceof SignInRequiredError ? "denied" : "error",
    latencyMs: Date.now() - started,
    errorMessage: message,
  });

  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export const GetMyTimeOffBalanceInputZod = z.object(InputSchema);
