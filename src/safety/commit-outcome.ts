/**
 * Shared commit outcome classification for the MCP idempotency store and the
 * HTTP approval ledger. Definitive success and definitive 4xx are safe to pin.
 * Timeouts, 5xx, 408, 409, 429, and network failures are unknown: record them
 * and reconcile before any retry. Do not resubmit automatically.
 */
import { ContractNotValidatedError, WorkdayApiError, WorkdayRequestValidationError } from "../workday/client.js";

export type CommitRecordState = "ok" | "error" | "unknown";

/** Thrown when a previous submit did not confirm and must not be sent again. */
export class CommitUncertainError extends Error {
  constructor(
    message = "Workday did not confirm the result. It will not be resubmitted automatically. Reconcile the record, then retry.",
  ) {
    super(message);
    this.name = "CommitUncertainError";
  }
}

const APPLICATION_ERROR_NAMES = new Set([
  "ToolUserError",
  "NativeWriteGuardError",
  "RbacDeniedError",
  "AgentReadyDeniedError",
  "AgentReadyWriteDeniedError",
  "ApprovalError",
]);

/**
 * Same rule as the approval ledger for Workday results: validation and definitive
 * 4xx are errors. Timeouts, 5xx, 408, 409, 429, parse failures on a 2xx write, and
 * network errors are unknown. Named application errors are definitive because they
 * are raised by this server before an ambiguous Workday result.
 */
export function classifyCommitFailure(error: unknown): "error" | "unknown" {
  const definitiveClientError =
    error instanceof ContractNotValidatedError || error instanceof WorkdayRequestValidationError;
  const definitiveHttp =
    error instanceof WorkdayApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status);
  const applicationError = error instanceof Error && APPLICATION_ERROR_NAMES.has(error.name);
  return definitiveClientError || definitiveHttp || applicationError ? "error" : "unknown";
}
