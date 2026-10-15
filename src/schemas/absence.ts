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
  timeOffTypeName: z.string(),
  unit: TimeOffUnitSchema,
  available: z.number(),
  pending: z.number(),
  asOf: IsoDateSchema,
});
export type TimeOffBalance = z.infer<typeof TimeOffBalanceSchema>;

export const TimeOffRequestStatusSchema = z.enum([
  "SUBMITTED",
  "IN_PROGRESS",
  "APPROVED",
  "DENIED",
  "CANCELED",
]);
export type TimeOffRequestStatus = z.infer<typeof TimeOffRequestStatusSchema>;

export const ApprovalActionSchema = z.enum(["APPROVE", "DENY"]);

export const TimeOffRequestInputSchema = z.object({
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  unit: TimeOffUnitSchema,
  quantity: z.number().positive().max(24 * 31),
  timeOffType: AbsenceTypeIdSchema,
  comment: z.string().max(500).optional(), // may contain free-text PII; redact in logs
});

export const TimeOffRequestSchema = z.object({
  requestId: TimeOffEntryIdSchema,
  worker: RefSchema.optional(), // PII: name; only present in manager views
  timeOffType: WorkdayIdSchema,
  timeOffTypeName: z.string().optional(),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  quantity: z.number(),
  unit: TimeOffUnitSchema,
  status: TimeOffRequestStatusSchema,
  submittedAt: IsoDateTimeSchema.optional(),
  awaitingAction: RefSchema.nullable().optional(), // current BP step / approver
});
export type TimeOffRequest = z.infer<typeof TimeOffRequestSchema>;
