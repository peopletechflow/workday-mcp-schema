import { z } from "zod";
import {
  IsoDateSchema,
  PageInfoSchema,
  PageInputShape,
  TimeOffEntryIdSchema,
  TimeOffUnitSchema,
  AbsenceTypeIdSchema,
} from "../common.js";
import { WorkerSummarySchema } from "../worker.js";
import { TimeOffBalanceSchema, TimeOffRequestSchema, TimeOffRequestStatusSchema } from "../absence.js";
import { CommitInputShape, commitOutput, defineTool, previewOutput } from "./contract.js";

export const getMyWorkerProfile = defineTool({
  name: "get_my_worker_profile",
  title: "Get my worker profile",
  description:
    "Read-only. Returns the signed-in worker's minimal profile (preferred name, worker type, " +
    "hire/termination dates, supervisory org, manager). No SSN, bank, or home address. Who: any authenticated worker.",
  toolClass: "read",
  input: {},
  output: { worker: WorkerSummarySchema },
});

export const getMyTimeOffBalance = defineTool({
  name: "get_my_time_off_balance",
  title: "Get my time-off balance",
  description:
    "Read-only. Returns the signed-in user's time-off balances (available and pending). " +
    "Who: any authenticated worker with Absence self-view. Does not write.",
  toolClass: "read",
  input: {
    asOf: IsoDateSchema.optional().describe(
      "Optional as-of date (ISO YYYY-MM-DD). Defaults to today in the tenant timezone.",
    ),
  },
  output: { balances: z.array(TimeOffBalanceSchema) },
});

export const listMyTimeOffRequests = defineTool({
  name: "list_my_time_off_requests",
  title: "List my time-off requests",
  description:
    "Read-only. Lists the signed-in worker's own time-off requests in a date window, optionally by status. Who: any authenticated worker.",
  toolClass: "read",
  input: {
    from: IsoDateSchema.optional().describe("Window start (ISO)"),
    to: IsoDateSchema.optional().describe("Window end (ISO)"),
    status: z.array(TimeOffRequestStatusSchema).max(5).optional(),
    ...PageInputShape,
  },
  output: { requests: z.array(TimeOffRequestSchema), page: PageInfoSchema },
});

const RequestTimeOffWill = z.object({
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  unit: TimeOffUnitSchema,
  quantity: z.number(),
  timeOffType: AbsenceTypeIdSchema,
  comment: z.string().nullable(),
});

export const previewRequestTimeOff = defineTool({
  name: "preview_request_time_off",
  title: "Preview request time off",
  description:
    "Write preview (does not submit). Returns exactly what will change and a short-lived preview token. " +
    "Call commit_request_time_off only after the user confirms. Who: authenticated worker for their own time off.",
  toolClass: "write-preview",
  input: {
    startDate: IsoDateSchema.describe("First day of absence (ISO YYYY-MM-DD)"),
    endDate: IsoDateSchema.describe("Last day of absence (ISO YYYY-MM-DD)"),
    unit: TimeOffUnitSchema.describe("Unit for quantity (HOURS or DAYS)"),
    quantity: z
      .number()
      .positive()
      .max(24 * 31)
      .describe("Amount of time off in the given unit"),
    timeOffType: AbsenceTypeIdSchema.describe("Workday time-off / absence type ID"),
    comment: z.string().max(500).optional().describe("Optional comment on the request"),
  },
  output: previewOutput(RequestTimeOffWill),
});

export const commitRequestTimeOff = defineTool({
  name: "commit_request_time_off",
  title: "Commit request time off",
  description:
    "Write. Submits a time-off request through the Workday business process using a prior preview token. " +
    "Requires userConfirmed=true and an idempotencyKey; retries return the stored result. Who: authenticated worker.",
  toolClass: "write-commit",
  input: CommitInputShape,
  output: commitOutput(TimeOffRequestSchema.partial({ requestId: true })),
});

export const CancelTimeOffWill = z.object({
  requestId: TimeOffEntryIdSchema,
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  currentStatus: TimeOffRequestStatusSchema,
  reason: z.string().nullable(),
});

export const previewCancelTimeOff = defineTool({
  name: "preview_cancel_time_off",
  title: "Preview cancel time off",
  description:
    "Write preview (does not cancel). Shows which of the caller's own time-off requests would be canceled via the " +
    "Cancel business process and returns a preview token. Who: authenticated worker, own requests only.",
  toolClass: "write-preview",
  input: {
    requestId: TimeOffEntryIdSchema.describe("Time_Off_Entry_ID or BP event ID of the request"),
    reason: z.string().max(500).optional(),
  },
  output: previewOutput(CancelTimeOffWill),
});

export const commitCancelTimeOff = defineTool({
  name: "commit_cancel_time_off",
  title: "Commit cancel time off",
  description:
    "Write. Cancels the previewed time-off request through the Workday business process. " +
    "Requires preview token, userConfirmed=true, idempotencyKey. Who: authenticated worker.",
  toolClass: "write-commit",
  input: CommitInputShape,
  output: commitOutput(TimeOffRequestSchema),
});
