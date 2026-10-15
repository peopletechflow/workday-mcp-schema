import { z } from "zod";
import { IsoDateSchema, PageInfoSchema, PageInputShape, TimeOffEntryIdSchema } from "../common.js";
import { TeamMemberSchema } from "../worker.js";
import { ApprovalActionSchema, TimeOffRequestSchema, TimeOffRequestStatusSchema } from "../absence.js";
import { CommitInputShape, commitOutput, defineTool, previewOutput } from "./contract.js";

export const listMyTeam = defineTool({
  name: "list_my_team",
  title: "List my team",
  description:
    "Read-only. Lists the signed-in manager's direct reports with minimal fields (ID, preferred name, title, status). " +
    "Who: managers; Workday security decides visibility.",
  toolClass: "read",
  input: {
    includeInactive: z.boolean().default(false),
    ...PageInputShape,
  },
  output: { members: z.array(TeamMemberSchema), page: PageInfoSchema },
});

export const listTeamTimeOffRequests = defineTool({
  name: "list_team_time_off_requests",
  title: "List team time-off requests",
  description:
    "Read-only. Lists time-off requests from the manager's team (default: open, awaiting action). Who: managers.",
  toolClass: "read",
  input: {
    status: z.array(TimeOffRequestStatusSchema).max(5).default(["SUBMITTED", "IN_PROGRESS"]),
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    ...PageInputShape,
  },
  output: { requests: z.array(TimeOffRequestSchema), page: PageInfoSchema },
});

export const DecisionWill = z.object({
  action: ApprovalActionSchema,
  request: TimeOffRequestSchema,
  comment: z.string().nullable(),
});

const decisionInput = {
  requestId: TimeOffEntryIdSchema.describe("Request / BP event awaiting the manager's action"),
  comment: z.string().max(500).optional(),
};

export const previewApproveTimeOff = defineTool({
  name: "preview_approve_time_off",
  title: "Preview approve time off",
  description:
    "Write preview (does not approve). Shows the team request and the BP approval step that would be completed. Who: the assigned approver.",
  toolClass: "write-preview",
  input: decisionInput,
  output: previewOutput(DecisionWill),
});

export const commitApproveTimeOff = defineTool({
  name: "commit_approve_time_off",
  title: "Commit approve time off",
  description:
    "Write. Approves the previewed request through the Workday business process inbox step. Requires preview token, userConfirmed, idempotencyKey. Who: the assigned approver.",
  toolClass: "write-commit",
  input: CommitInputShape,
  output: commitOutput(TimeOffRequestSchema),
});

export const previewDenyTimeOff = defineTool({
  name: "preview_deny_time_off",
  title: "Preview deny time off",
  description:
    "Write preview (does not deny). Shows the team request that would be denied/sent back. Who: the assigned approver.",
  toolClass: "write-preview",
  input: { ...decisionInput, comment: z.string().min(1).max(500).describe("Reason shown to the worker (required)") },
  output: previewOutput(DecisionWill),
});

export const commitDenyTimeOff = defineTool({
  name: "commit_deny_time_off",
  title: "Commit deny time off",
  description:
    "Write. Denies the previewed request through the Workday business process. Requires preview token, userConfirmed, idempotencyKey. Who: the assigned approver.",
  toolClass: "write-commit",
  input: CommitInputShape,
  output: commitOutput(TimeOffRequestSchema),
});
