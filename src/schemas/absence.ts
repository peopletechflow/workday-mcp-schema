import { z } from "zod";
import {
  AbsenceTypeIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  RefSchema,
  TimeOffEntryIdSchema,
  TimeOffUnitSchema,
  WorkdayIdSchema,
} from "./common.js";

export const TimeOffTypeSchema = z.object({
  id: AbsenceTypeIdSchema,
  name: z.string().max(256),
  unit: TimeOffUnitSchema,
});
export type TimeOffType = z.infer<typeof TimeOffTypeSchema>;

/** Kept field-compatible with the original get_my_time_off_balance output. */
export const TimeOffBalanceSchema = z.object({
  timeOffType: WorkdayIdSchema,
  timeOffTypeName: z.string().min(1).max(256),
  unit: TimeOffUnitSchema,
  available: z.number(),
  pending: z.number(),
  asOf: IsoDateSchema,
});
export type TimeOffBalance = z.infer<typeof TimeOffBalanceSchema>;

/**
 * Live absenceManagement balance row. Required fields only. Missing unit, amount,
 * name, or date fails the parse. Callers must not fill defaults.
 */
export const LiveBalanceRowSchema = z
  .object({
    timeOffTypeId: z.string().min(1).max(128).optional(),
    id: z.string().min(1).max(128).optional(),
    timeOffTypeName: z.string().min(1).max(256).optional(),
    descriptor: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    unit: TimeOffUnitSchema,
    available: z.number().optional(),
    balance: z.number().optional(),
    pending: z.number(),
    asOf: IsoDateSchema,
  })
  .superRefine((row, ctx) => {
    if (!(row.timeOffTypeId ?? row.id)) {
      ctx.addIssue({ code: "custom", message: "Balance row needs timeOffTypeId or id." });
    }
    if (!(row.timeOffTypeName ?? row.descriptor ?? row.name)) {
      ctx.addIssue({ code: "custom", message: "Balance row needs a type name." });
    }
    if (row.available === undefined && row.balance === undefined) {
      ctx.addIssue({ code: "custom", message: "Balance row needs available or balance." });
    }
  });

export const LiveBalanceListSchema = z.object({
  data: z.array(LiveBalanceRowSchema).max(500),
});

/** One row from GET timeOffDetails. Unknown extra fields are kept for filtering only after this parse. */
export const LiveTimeOffDetailSchema = z
  .object({
    id: z.string().min(1).max(128),
    date: z.string().min(10).max(40),
    timeOffType: z.object({ id: z.string().min(1).max(128) }),
    status: z.union([z.object({ descriptor: z.string().max(128) }), z.string().max(128)]),
  })
  .loose();

export const LiveTimeOffDetailListSchema = z.object({
  data: z.array(LiveTimeOffDetailSchema).max(500),
});

/** POST requestTimeOff success body. An empty object is valid JSON and still has no id. */
export const LiveCreateTimeOffResponseSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    businessProcess: z.object({ id: z.string().min(1).max(128) }).optional(),
  })
  .loose();

export const LiveFaultBodySchema = z
  .object({
    error: z.string().max(2000).optional(),
    message: z.string().max(2000).optional(),
    code: z.string().max(120).optional(),
  })
  .loose();

export const TimeOffRequestStatusSchema = z.enum(["SUBMITTED", "IN_PROGRESS", "APPROVED", "DENIED", "CANCELED"]);
export type TimeOffRequestStatus = z.infer<typeof TimeOffRequestStatusSchema>;

export const ApprovalActionSchema = z.enum(["APPROVE", "DENY"]);

export const TimeOffRequestInputSchema = z.object({
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  unit: TimeOffUnitSchema,
  quantity: z
    .number()
    .positive()
    .max(24 * 31),
  timeOffType: AbsenceTypeIdSchema,
  comment: z.string().max(500).optional(), // may contain free-text PII; redact in logs
});
export type TimeOffRequestInput = z.infer<typeof TimeOffRequestInputSchema>;

export const TimeOffRequestResultSchema = z.object({
  workdayEventId: z.string().min(1).max(128),
  status: z.enum(["SUBMITTED", "IN_PROGRESS", "APPROVED", "DENIED"]),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  quantity: z.number(),
  unit: TimeOffUnitSchema,
  timeOffType: WorkdayIdSchema,
});
export type TimeOffRequestResult = z.infer<typeof TimeOffRequestResultSchema>;

export const TimeOffRequestSchema = z.object({
  requestId: TimeOffEntryIdSchema,
  worker: RefSchema.optional(), // PII: name; only present in manager views
  timeOffType: WorkdayIdSchema,
  timeOffTypeName: z.string().max(256).optional(),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  quantity: z.number(),
  unit: TimeOffUnitSchema,
  status: TimeOffRequestStatusSchema,
  submittedAt: IsoDateTimeSchema.optional(),
  awaitingAction: RefSchema.nullable().optional(), // current BP step / approver
});
export type TimeOffRequest = z.infer<typeof TimeOffRequestSchema>;
