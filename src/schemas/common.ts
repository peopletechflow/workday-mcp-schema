import { z } from "zod";

/** ISO calendar date YYYY-MM-DD (no time component). */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected ISO date YYYY-MM-DD")
  .describe("ISO calendar date (YYYY-MM-DD)");

export const WorkdayIdTypeSchema = z.enum([
  "WID",
  "Employee_ID",
  "Contingent_Worker_ID",
  "Absence_Table_ID",
  "Time_Off_Type_ID",
  "Time_Off_Entry_ID",
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

export const TimeOffUnitSchema = z.enum(["HOURS", "DAYS"]);

export const AbsenceTypeIdSchema = WorkdayIdSchema.refine(
  (id) => id.type === "Time_Off_Type_ID" || id.type === "Absence_Table_ID" || id.type === "WID",
  { message: "Absence type must be Time_Off_Type_ID, Absence_Table_ID, or WID" },
);
