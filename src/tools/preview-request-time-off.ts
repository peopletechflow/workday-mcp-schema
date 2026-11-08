import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AbsenceTypeIdSchema,
  IsoDateSchema,
  TimeOffUnitSchema,
} from "../schemas/common.js";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import { assertToolAllowedForUser, type AssignmentStore, type Role } from "../rbac/index.js";
import type { AuditLogger } from "../safety/audit.js";
import type { PreviewStore } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { SignInRequiredError } from "../auth/oauth.js";
import { z } from "zod";
import { annotationsFor, markRegistered } from "./framework.js";
import { previewRequestTimeOff } from "../schemas/tools/self-service.js";
import { createTimeOffPreview } from "./time-off-core.js";

// Input contract lives in src/schemas/tools (schema-first).
const InputSchema = previewRequestTimeOff.input;

export function registerPreviewRequestTimeOff(
  server: McpServer,
  deps: {
    config: AppConfig;
    audit: AuditLogger;
    previewStore: PreviewStore;
    tokenStore: TokenStore;
    pendingPkce: Map<string, PkcePair>;
    resolveUserId: () => string;
    resolveUserRoles: () => Role[];
    /** User grants/denies; denies win over roles (fail closed). */
    assignments?: AssignmentStore;
  },
): void {
  const toolName = "preview_request_time_off";

  markRegistered(server, toolName);
  server.registerTool(
    toolName,
    {
      title: "Preview request time off",
      description:
        "Write preview (does not submit). Returns exactly what will change and a short-lived " +
        "preview token. Call commit_request_time_off with that token and an idempotency key " +
        "only after the user confirms. Who: authenticated worker requesting their own time off. Writes: no.",
      inputSchema: InputSchema,
      annotations: annotationsFor({ name: toolName, toolClass: "write-preview" }),
    },
    async (args) => {
      const started = Date.now();
      const userId = deps.resolveUserId();
      try {
        assertToolEnabled(deps.config, toolName);
        assertToolAllowedForUser({ userId, roles: deps.resolveUserRoles(), toolName, assignments: deps.assignments });
        const { previewToken, summary } = await createTimeOffPreview(deps, userId, args);

        const body = {
          previewToken,
          expiresInSeconds: 900,
          willSubmit: {
            startDate: args.startDate,
            endDate: args.endDate,
            unit: args.unit,
            quantity: args.quantity,
            timeOffType: args.timeOffType,
            comment: args.comment ?? null,
          },
          summary,
          nextStep:
            "Show the summary to the user. On explicit confirmation, call commit_request_time_off " +
            "with this previewToken and a fresh idempotencyKey.",
        };

        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: toolName,
          inputs: args,
          result: "ok",
          latencyMs: Date.now() - started,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        const message =
          err instanceof SignInRequiredError
            ? `${err.message}\nAuthorize URL: ${err.authorizeUrl}`
            : err instanceof Error
              ? err.message
              : "Unknown error";
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: toolName,
          inputs: args,
          result: err instanceof SignInRequiredError ? "denied" : "error",
          latencyMs: Date.now() - started,
          errorMessage: message,
        });
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}
