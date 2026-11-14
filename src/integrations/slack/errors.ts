/**
 * Map internal errors to short, actionable Slack replies. Never includes tokens, payloads,
 * or Workday fault bodies. Unknown errors return undefined (caller logs and says "internal error").
 */
import { ApprovalError } from "../approvals/workflow.js";
import { RbacDeniedError } from "../../rbac/enforce.js";
import { LinkRequiredError, TokenRefreshUnavailableError } from "../../auth/user-tokens.js";
import { ContractNotValidatedError } from "../../workday/client.js";

/** Form field (Slack block_id) an error belongs to, for modal `response_action: "errors"`. */
export type FormField = "start" | "end" | "type" | "days";

export function slackErrorMessage(e: unknown, commandName: string): { text: string; field: FormField } | undefined {
  if (e instanceof LinkRequiredError) {
    return {
      text: `Your Workday account is not linked or its sign-in expired. Run \`${commandName} link\`, then try again.`,
      field: "start",
    };
  }
  if (e instanceof TokenRefreshUnavailableError) return { text: e.message, field: "start" };
  if (e instanceof RbacDeniedError)
    return { text: "You are not allowed to do this. Ask your Workday security admin.", field: "start" };
  if (e instanceof ContractNotValidatedError)
    return { text: "Submitting to Workday is not enabled for this deployment yet.", field: "start" };
  if (e instanceof ApprovalError) {
    switch (e.code) {
      case "NO_POLICY":
      case "NO_APPROVER":
        return { text: "No approver is configured for this request. Ask an administrator.", field: "start" };
      case "UNKNOWN_TYPE":
        return { text: "This time-off type is not available.", field: "type" };
      case "BAD_RANGE":
        return { text: "End date must be on or after the start date.", field: "end" };
      case "INVALID_REQUEST":
        return { text: e.message, field: "days" };
      case "SELF_APPROVAL":
        return { text: "You cannot approve your own request.", field: "start" };
      case "NOT_APPROVER":
        return { text: "You are not an approver for this request.", field: "start" };
      case "NOT_REQUESTER":
        return { text: "Only the person who requested this can submit it.", field: "start" };
      case "HASH_MISMATCH":
      case "TAMPERED":
        return {
          text: "This request changed since it was sent for approval. Ask the requester to submit a new one.",
          field: "start",
        };
      case "NOT_FOUND":
        return { text: "Unknown request, or you are not involved in it.", field: "start" };
      case "NOT_PENDING":
      case "NOT_APPROVED":
      case "EXPIRED":
      case "COMMIT_UNCERTAIN":
      case "COMMIT_FAILED":
        return { text: e.message, field: "start" };
      default:
        return { text: `Not done: ${e.code}.`, field: "start" };
    }
  }
  return undefined;
}
