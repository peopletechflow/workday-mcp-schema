import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AbsenceTypeIdSchema,
  IsoDateSchema,
  TimeOffUnitSchema,
} from "../schemas/common.js";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import type { PreviewStore } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { SignInRequiredError } from "../auth/oauth.js";
import { ensureFixtureSession, requireUserAccessToken } from "../session.js";
import { z } from "zod";
import { previewRequestTimeOff } from "../schemas/tools/self-service.js";

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
  },
): void {
  const toolName = "preview_request_time_off";

  server.registerTool(
    toolName,
    {
      title: "Preview request time off",
      description:
        "Write preview (does not submit). Returns exactly what will change and a short-lived " +
        "preview token. Call commit_request_time_off with that token and an idempotency key " +
        "only after the user confirms. Who: authenticated worker requesting their own time off. Writes: no.",
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const started = Date.now();
      const userId = deps.resolveUserId();
      try {
        assertToolEnabled(deps.config, toolName);
        if (args.endDate < args.startDate) {
          throw new Error("endDate must be on or after startDate");
        }
        await ensureFixtureSession(deps.config, deps.tokenStore, userId);
        // Ensure the user is signed in before we mint a preview (no anonymous previews).
        await requireUserAccessToken(deps.config, deps.tokenStore, userId, deps.pendingPkce);

        const summary =
          `Request ${args.quantity} ${args.unit.toLowerCase()} of ` +
          `${args.timeOffType.type}:${args.timeOffType.value} ` +
          `from ${args.startDate} to ${args.endDate}` +
          (args.comment ? ` (comment: ${args.comment.slice(0, 80)})` : "");

        const previewToken = deps.previewStore.create({
          kind: "request_time_off",
          userId,
          startDate: args.startDate,
          endDate: args.endDate,
          unit: args.unit,
          quantity: args.quantity,
          timeOffType: args.timeOffType,
          comment: args.comment,
          summary,
        });

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
