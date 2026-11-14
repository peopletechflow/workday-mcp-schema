import { z } from "zod";
import { OUTCOME_IDS } from "../../agent-ready/outcome-groups.js";
import {
  AbsenceTypeIdSchema,
  IdempotencyKeySchema,
  IsoDateSchema,
  PageInfoSchema,
  PageInputShape,
  PreviewTokenSchema,
  SupervisoryOrgIdSchema,
  TimeOffEntryIdSchema,
  TimeOffUnitSchema,
  UserConfirmedSchema,
} from "../common.js";
import {
  TimeOffBalanceSchema,
  TimeOffRequestResultSchema,
  TimeOffRequestSchema,
  TimeOffRequestStatusSchema,
} from "../absence.js";
import { WorkerSummarySchema, TeamMemberSchema } from "../worker.js";
import { BenefitEnrollmentSchema } from "../benefits.js";
import { PayStatementSummarySchema } from "../payroll.js";
import { SupervisoryOrgSchema } from "../organization.js";
import { defineTool } from "./contract.js";

const OutcomeIdSchema = z.enum(OUTCOME_IDS);

export const CompactOperationSchema = z.object({
  name: z.string().max(120),
  readOnly: z.boolean(),
  description: z.string().max(160),
  reason: z.string().max(240),
});

const findInput = {
  search: z.string().max(80).optional().describe("Match on operation name or description"),
  limit: z.number().int().min(1).max(20).default(10),
};

const commitInput = {
  previewToken: PreviewTokenSchema,
  idempotencyKey: IdempotencyKeySchema,
  userConfirmed: UserConfirmedSchema,
};

const previewEnvelope = {
  previewToken: PreviewTokenSchema,
  expiresInSeconds: z.number().int().positive(),
  summary: z.string().max(500),
  nextStep: z.string().max(400),
};

export const timeOffInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("balances"), asOf: IsoDateSchema.optional() }),
  z.object({
    action: z.literal("history"),
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    status: z.array(TimeOffRequestStatusSchema).max(5).optional(),
    ...PageInputShape,
  }),
  z.object({
    action: z.literal("team_history"),
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    status: z.array(TimeOffRequestStatusSchema).max(5).optional(),
    ...PageInputShape,
  }),
  z.object({
    action: z.literal("request_preview"),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    unit: TimeOffUnitSchema,
    quantity: z
      .number()
      .positive()
      .max(24 * 31),
    timeOffType: AbsenceTypeIdSchema,
    comment: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal("request_commit"), ...commitInput }),
  z.object({
    action: z.literal("cancel_preview"),
    requestId: TimeOffEntryIdSchema,
    reason: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal("cancel_commit"), ...commitInput }),
  z.object({
    action: z.literal("approve_preview"),
    requestId: TimeOffEntryIdSchema,
    comment: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal("approve_commit"), ...commitInput }),
  z.object({
    action: z.literal("deny_preview"),
    requestId: TimeOffEntryIdSchema,
    comment: z.string().min(1).max(256),
  }),
  z.object({ action: z.literal("deny_commit"), ...commitInput }),
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const timeOffOutput = z.object({
  action: z.string().max(40),
  balances: z.array(TimeOffBalanceSchema).max(50).optional(),
  requests: z.array(TimeOffRequestSchema).max(100).optional(),
  page: PageInfoSchema.optional(),
  ...previewEnvelope,
  previewToken: PreviewTokenSchema.optional(),
  expiresInSeconds: z.number().int().positive().optional(),
  summary: z.string().max(500).optional(),
  nextStep: z.string().max(400).optional(),
  willSubmit: z.record(z.string(), z.unknown()).optional(),
  replayed: z.boolean().optional(),
  submitted: z.boolean().optional(),
  reusedExisting: z.boolean().optional(),
  request: z.union([TimeOffRequestResultSchema, TimeOffRequestSchema]).optional(),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
});

export const timeOffTool = defineTool({
  name: "time_off",
  title: "Time off",
  description:
    "Time off for the signed-in worker: balances, history, request, or cancel. Managers can list, approve, or deny team requests. " +
    "Writes use preview, then commit with userConfirmed and an idempotency key. find_operation lists catalog operations for this goal.",
  toolClass: "read",
  input: {},
  output: {},
});

export const workerInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profile") }),
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const workerOutput = z.object({
  action: z.string().max(40),
  worker: WorkerSummarySchema.optional(),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
});

export const workerTool = defineTool({
  name: "worker",
  title: "Worker",
  description: "Signed-in worker profile, or find a catalog operation about worker and employment data. Read only.",
  toolClass: "read",
  input: {},
  output: {},
});

export const organizationInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("my_team"), includeInactive: z.boolean().default(false), ...PageInputShape }),
  z.object({ action: z.literal("supervisory_org"), orgId: SupervisoryOrgIdSchema }),
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const organizationOutput = z.object({
  action: z.string().max(40),
  members: z.array(TeamMemberSchema).max(100).optional(),
  org: SupervisoryOrgSchema.optional(),
  page: PageInfoSchema.optional(),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
});

export const organizationTool = defineTool({
  name: "organization",
  title: "Organization",
  description:
    "Direct reports, a supervisory org, or a catalog operation for org chart and staffing structure. Read only.",
  toolClass: "read",
  input: {},
  output: {},
});

export const benefitsInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enrollments"), asOf: IsoDateSchema.optional() }),
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const benefitsOutput = z.object({
  action: z.string().max(40),
  enrollments: z.array(BenefitEnrollmentSchema).max(50).optional(),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
});

export const benefitsTool = defineTool({
  name: "benefits",
  title: "Benefits",
  description: "Signed-in worker benefit enrollments, or a catalog operation for benefits. Read only. No dependents.",
  toolClass: "read",
  input: {},
  output: {},
});

export const payInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("statements"),
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    ...PageInputShape,
  }),
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const payOutput = z.object({
  action: z.string().max(40),
  statements: z.array(PayStatementSummarySchema).max(100).optional(),
  page: PageInfoSchema.optional(),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
});

export const payTool = defineTool({
  name: "pay",
  title: "Pay",
  description:
    "Signed-in worker pay statement summaries, or a catalog operation for payroll reads. Never writes payroll.",
  toolClass: "read",
  input: {},
  output: {},
});

export const lookupInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("find_operation"), ...findInput }),
]);

export const lookupOutput = z.object({
  action: z.string().max(40),
  total: z.number().int().nonnegative(),
  operations: z.array(CompactOperationSchema).max(20),
});

export const catalogInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    query: z.string().max(80).optional(),
    outcome: OutcomeIdSchema.optional(),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  z.object({ action: z.literal("get"), name: z.string().min(1).max(120) }),
]);

export const catalogOutput = z.object({
  action: z.string().max(40),
  total: z.number().int().nonnegative().optional(),
  operations: z.array(CompactOperationSchema).max(20).optional(),
  operation: CompactOperationSchema.optional(),
  found: z.boolean().optional(),
});

export const jobTool = defineTool({
  name: "job",
  title: "Job",
  description: "Find a catalog operation for jobs, positions, or change job. This tool does not submit a job change.",
  toolClass: "read",
  input: {},
  output: {},
});

export const compensationTool = defineTool({
  name: "compensation",
  title: "Compensation",
  description: "Find a catalog operation for compensation reference data. Read only. No pay changes.",
  toolClass: "read",
  input: {},
  output: {},
});

export const talentTool = defineTool({
  name: "talent",
  title: "Talent",
  description: "Find a catalog operation for goals, performance, feedback, or learning. Does not submit those changes.",
  toolClass: "read",
  input: {},
  output: {},
});

export const recruitingTool = defineTool({
  name: "recruiting",
  title: "Recruiting",
  description: "Find a catalog operation for candidates, job requisitions, or postings. Read only.",
  toolClass: "read",
  input: {},
  output: {},
});

export const personalDataTool = defineTool({
  name: "personal_data",
  title: "Personal data",
  description:
    "Find a catalog operation for contact, personal information, or identifiers. Does not submit those changes.",
  toolClass: "read",
  input: {},
  output: {},
});

export const expensesTool = defineTool({
  name: "expenses",
  title: "Expenses",
  description: "Find a catalog operation for expense reports or lines. Read only.",
  toolClass: "read",
  input: {},
  output: {},
});

export const businessProcessTool = defineTool({
  name: "business_process",
  title: "Business process",
  description:
    "Find a catalog operation for inbox tasks, business process events, or approvals. Does not approve by itself.",
  toolClass: "read",
  input: {},
  output: {},
});

export const catalogTool = defineTool({
  name: "catalog",
  title: "Workday catalog",
  description:
    "Search or get one operation from the tenant catalog. Returns a short row, not a Workday call. Prefer the outcome tool for a goal.",
  toolClass: "read",
  input: {},
  output: {},
});

export const OUTCOME_TOOL_CONTRACTS = [
  timeOffTool,
  workerTool,
  organizationTool,
  jobTool,
  compensationTool,
  benefitsTool,
  payTool,
  talentTool,
  recruitingTool,
  personalDataTool,
  expensesTool,
  businessProcessTool,
  catalogTool,
] as const;

/** Real input and output schemas. The defineTool shapes stay empty because a discriminated union is not a raw shape. */
export const OUTCOME_SCHEMAS = {
  time_off: { input: timeOffInput, output: timeOffOutput },
  worker: { input: workerInput, output: workerOutput },
  organization: { input: organizationInput, output: organizationOutput },
  job: { input: lookupInput, output: lookupOutput },
  compensation: { input: lookupInput, output: lookupOutput },
  benefits: { input: benefitsInput, output: benefitsOutput },
  pay: { input: payInput, output: payOutput },
  talent: { input: lookupInput, output: lookupOutput },
  recruiting: { input: lookupInput, output: lookupOutput },
  personal_data: { input: lookupInput, output: lookupOutput },
  expenses: { input: lookupInput, output: lookupOutput },
  business_process: { input: lookupInput, output: lookupOutput },
  catalog: { input: catalogInput, output: catalogOutput },
} as const;
