import { z } from "zod";

/** ISO calendar date YYYY-MM-DD (no time component). */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected ISO date YYYY-MM-DD")
  .describe("ISO calendar date (YYYY-MM-DD)");

/** ISO 8601 timestamp with offset or Z. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true }).describe("ISO 8601 timestamp");

export const WorkdayIdTypeSchema = z.enum([
  "WID",
  "Employee_ID",
  "Contingent_Worker_ID",
  "Position_ID",
  "Organization_Reference_ID",
  "Supervisory_Organization_ID",
  "Cost_Center_Reference_ID",
  "Location_ID",
  "Job_Profile_ID",
  "Benefit_Plan_ID",
  "Pay_Group_ID",
  "Pay_Statement_ID",
  "Absence_Table_ID",
  "Time_Off_Type_ID",
  "Time_Off_Entry_ID",
  "Business_Process_Event_ID",
]);
export type WorkdayIdType = z.infer<typeof WorkdayIdTypeSchema>;

/** Typed Workday identifier: type + value, never a bare opaque string in tool inputs. */
export const WorkdayIdSchema = z
  .object({
    type: WorkdayIdTypeSchema,
    value: z.string().min(1).max(128),
  })
  .describe("Workday ID with explicit type (e.g. Employee_ID or WID)");
export type WorkdayId = z.infer<typeof WorkdayIdSchema>;

/** WorkdayId restricted to specific ID types (WID always accepted). */
export function typedId(...types: [WorkdayIdType, ...WorkdayIdType[]]) {
  const allowed = new Set<WorkdayIdType>([...types, "WID"]);
  return WorkdayIdSchema.refine((id) => allowed.has(id.type), {
    message: `ID type must be one of: ${[...allowed].join(", ")}`,
  });
}

export const WorkerIdSchema = typedId("Employee_ID", "Contingent_Worker_ID").brand<"WorkerId">();
export type WorkerId = z.infer<typeof WorkerIdSchema>;
export const PositionIdSchema = typedId("Position_ID").brand<"PositionId">();
export type PositionId = z.infer<typeof PositionIdSchema>;
export const OrganizationIdSchema = typedId("Organization_Reference_ID").brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;
export const SupervisoryOrgIdSchema = typedId(
  "Supervisory_Organization_ID",
  "Organization_Reference_ID",
).brand<"SupervisoryOrgId">();
export type SupervisoryOrgId = z.infer<typeof SupervisoryOrgIdSchema>;
export const CostCenterIdSchema = typedId(
  "Cost_Center_Reference_ID",
  "Organization_Reference_ID",
).brand<"CostCenterId">();
export type CostCenterId = z.infer<typeof CostCenterIdSchema>;
export const LocationIdSchema = typedId("Location_ID").brand<"LocationId">();
export type LocationId = z.infer<typeof LocationIdSchema>;
export const JobProfileIdSchema = typedId("Job_Profile_ID").brand<"JobProfileId">();
export type JobProfileId = z.infer<typeof JobProfileIdSchema>;
export const BenefitPlanIdSchema = typedId("Benefit_Plan_ID").brand<"BenefitPlanId">();
export type BenefitPlanId = z.infer<typeof BenefitPlanIdSchema>;
export const PayGroupIdSchema = typedId("Pay_Group_ID").brand<"PayGroupId">();
export type PayGroupId = z.infer<typeof PayGroupIdSchema>;
export const PayStatementIdSchema = typedId("Pay_Statement_ID").brand<"PayStatementId">();
export type PayStatementId = z.infer<typeof PayStatementIdSchema>;
export const TimeOffEntryIdSchema = typedId("Time_Off_Entry_ID", "Business_Process_Event_ID").brand<"TimeOffEntryId">();
export type TimeOffEntryId = z.infer<typeof TimeOffEntryIdSchema>;
export const BusinessProcessEventIdSchema = typedId("Business_Process_Event_ID").brand<"BusinessProcessEventId">();
export type BusinessProcessEventId = z.infer<typeof BusinessProcessEventIdSchema>;

/** Reference to another object: ID + descriptor (descriptor is PII when it names a person). */
export const RefSchema = z.object({
  id: WorkdayIdSchema,
  descriptor: z.string().max(256).describe("Workday display descriptor"),
});
export type Ref = z.infer<typeof RefSchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Idempotency key must be alphanumeric with . _ : -")
  .describe("Client-generated idempotency key for write commits");

export const PreviewTokenSchema = z
  .string()
  .min(16)
  .max(256)
  .describe("Opaque token returned by a preview_* tool; required to commit");

export const UserConfirmedSchema = z
  .literal(true)
  .describe("Must be true, explicit confirmation that the user approved the preview summary");

export const TimeOffUnitSchema = z.enum(["HOURS", "DAYS"]);
export type TimeOffUnit = z.infer<typeof TimeOffUnitSchema>;

export const AbsenceTypeIdSchema = WorkdayIdSchema.refine(
  (id) => id.type === "Time_Off_Type_ID" || id.type === "Absence_Table_ID" || id.type === "WID",
  { message: "Absence type must be Time_Off_Type_ID, Absence_Table_ID, or WID" },
).brand<"TimeOffTypeId">();
export type TimeOffTypeId = z.infer<typeof AbsenceTypeIdSchema>;

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");

/** Per-call record guardrail for list reads. */
export const MAX_RECORDS_PER_CALL = 100;
export const PageInputShape = {
  limit: z.number().int().min(1).max(MAX_RECORDS_PER_CALL).default(25).describe("Max rows (<=100)"),
  offset: z.number().int().min(0).default(0).describe("Row offset"),
};
export const PageInfoSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int(),
  offset: z.number().int(),
});
