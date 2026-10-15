import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IdempotencyKeySchema, PreviewTokenSchema } from "../schemas/common.js";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import type { WorkdayClient } from "../workday/client.js";
import { WorkdayApiError } from "../workday/client.js";
import type { AuditLogger } from "../safety/audit.js";
import type { IdempotencyStore } from "../safety/idempotency.js";
import type { PreviewStore } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { SignInRequiredError } from "../auth/oauth.js";
import { ensureFixtureSession, requireUserAccessToken } from "../session.js";
import { z } from "zod";

const InputSchema = {
  previewToken: PreviewTokenSchema,
  idempotencyKey: IdempotencyKeySchema,
  userConfirmed: z
    .literal(true)
    .describe("Must be true — explicit confirmation that the user approved the preview summary"),
};

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
  },
): void {
  const toolName = "commit_request_time_off";

  server.registerTool(
    toolName,
    {
      title: "Commit request time off",
      description:
        "Write. Submits a time-off request through the Workday business process using a prior " +
        "preview token. Requires userConfirmed=true and an idempotencyKey. Retries with the same " +
        "key return the stored result and do not duplicate. Who: authenticated worker. Writes: yes.",
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: false,
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
        if (args.userConfirmed !== true) {
          throw new Error("userConfirmed must be true before committing a write.");
        }

        const cached = deps.idempotency.get(userId, toolName, args.idempotencyKey);
        if (cached) {
          await deps.audit.log({
            ts: new Date().toISOString(),
            userId,
            tool: toolName,
            inputs: { idempotencyKey: args.idempotencyKey, replay: true },
            result: cached.status === "ok" ? "ok" : "error",
            workdayEventId: cached.workdayEventId,
            latencyMs: Date.now() - started,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { replayed: true, ...((cached.body as object) ?? {}) },
                  null,
                  2,
                ),
              },
            ],
            isError: cached.status === "error",
          };
        }

        const preview = deps.previewStore.consume(args.previewToken, userId, "request_time_off");
        await ensureFixtureSession(deps.config, deps.tokenStore, userId);
        const accessToken = await requireUserAccessToken(
          deps.config,
          deps.tokenStore,
          userId,
          deps.pendingPkce,
        );

        const input = {
          startDate: preview.startDate,
          endDate: preview.endDate,
          unit: preview.unit,
          quantity: preview.quantity,
          timeOffType: {
            type: preview.timeOffType.type as
              | "WID"
              | "Employee_ID"
              | "Contingent_Worker_ID"
              | "Absence_Table_ID"
              | "Time_Off_Type_ID"
              | "Time_Off_Entry_ID",
            value: preview.timeOffType.value,
          },
          comment: preview.comment,
        };

        // Check Workday for an existing matching request before submitting.
        const existing = await deps.client.findMatchingTimeOffRequest(accessToken, input);
        const result =
          existing ?? (await deps.client.submitTimeOffRequest(accessToken, input));

        const body = {
          submitted: !existing,
          reusedExisting: Boolean(existing),
          request: result,
          summary: preview.summary,
        };

        deps.idempotency.set(userId, toolName, args.idempotencyKey, {
          status: "ok",
          body,
          workdayEventId: result.workdayEventId,
        });

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

        deps.idempotency.set(userId, toolName, args.idempotencyKey, {
          status: "error",
          body: { error: message },
        });

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
