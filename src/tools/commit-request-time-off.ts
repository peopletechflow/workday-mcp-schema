import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IdempotencyKeySchema, PreviewTokenSchema } from "../schemas/common.js";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import { assertToolAllowedForUser, type AssignmentStore, type Role } from "../rbac/index.js";
import type { WorkdayClient } from "../workday/client.js";
import { WorkdayApiError } from "../workday/client.js";
import type { AuditLogger } from "../safety/audit.js";
import type { IdempotencyStore } from "../safety/idempotency.js";
import type { PreviewStore } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { SignInRequiredError } from "../auth/oauth.js";
import { z } from "zod";
import { annotationsFor, markRegistered } from "./framework.js";
import { commitRequestTimeOff } from "../schemas/tools/self-service.js";
import { commitTimeOffPreview } from "./time-off-core.js";

// Input contract lives in src/schemas/tools (schema-first).
const InputSchema = commitRequestTimeOff.input;

export function registerCommitRequestTimeOff(
  server: McpServer,
  deps: {
    config: AppConfig;
    client: WorkdayClient;
    audit: AuditLogger;
    previewStore: PreviewStore;
    idempotency: IdempotencyStore;
    tokenStore: TokenStore;
    pendingPkce: Map<string, PkcePair>;
    resolveUserId: () => string;
    resolveUserRoles: () => Role[];
    /** User grants/denies; denies win over roles (fail closed). */
    assignments?: AssignmentStore;
  },
): void {
  const toolName = "commit_request_time_off";

  markRegistered(server, toolName);
  server.registerTool(
    toolName,
    {
      title: "Commit request time off",
      description:
        "Write. Submits a time-off request through the Workday business process using a prior " +
        "preview token. Requires userConfirmed=true and an idempotencyKey. Retries with the same " +
        "key return the stored result and do not duplicate. Who: authenticated worker. Writes: yes.",
      inputSchema: InputSchema,
      annotations: annotationsFor({ name: toolName, toolClass: "write-commit" }),
    },
    async (args) => {
      const started = Date.now();
      const userId = deps.resolveUserId();
      try {
        assertToolEnabled(deps.config, toolName);
        assertToolAllowedForUser({ userId, roles: deps.resolveUserRoles(), toolName, assignments: deps.assignments });
        if (args.userConfirmed !== true) {
          throw new Error("userConfirmed must be true before committing a write.");
        }

        const outcome = await commitTimeOffPreview(deps, userId, args.previewToken, args.idempotencyKey);
        if (outcome.replayed) {
          await deps.audit.log({
            ts: new Date().toISOString(),
            userId,
            tool: toolName,
            inputs: { idempotencyKey: args.idempotencyKey, replay: true },
            result: outcome.status,
            workdayEventId: outcome.workdayEventId,
            latencyMs: Date.now() - started,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ replayed: true, ...((outcome.body as object) ?? {}) }, null, 2) }],
            isError: outcome.status === "error",
          };
        }
        const { body, preview } = outcome;
        const result = body.request;

        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: toolName,
          inputs: {
            idempotencyKey: args.idempotencyKey,
            startDate: preview.startDate,
            endDate: preview.endDate,
            timeOffType: preview.timeOffType,
          },
          result: "ok",
          workdayEventId: result.workdayEventId,
          latencyMs: Date.now() - started,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        const message =
          err instanceof SignInRequiredError
            ? `${err.message}\nAuthorize URL: ${err.authorizeUrl}`
            : err instanceof WorkdayApiError
              ? `Workday error (${err.fault.code}): ${err.fault.message}`
              : err instanceof Error
                ? err.message
                : "Unknown error";

        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: toolName,
          inputs: { idempotencyKey: args.idempotencyKey },
          result: err instanceof SignInRequiredError ? "denied" : "error",
          latencyMs: Date.now() - started,
          errorMessage: message,
        });

        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}
