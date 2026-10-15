import { z } from "zod";
import { BenefitPlanIdSchema, IsoDateSchema } from "./common.js";

export const CoverageLevelSchema = z.enum([
  "EMPLOYEE_ONLY",
  "EMPLOYEE_PLUS_SPOUSE",
  "EMPLOYEE_PLUS_CHILDREN",
  "FAMILY",
  "WAIVED",
]);

/**
 * Read-shaped enrollment summary. Excludes dependents/beneficiaries (names, DOB),
 * health data, and per-paycheck cost. Coverage level is sensitive (implies family status).
 */
export const BenefitEnrollmentSchema = z.object({
  planId: BenefitPlanIdSchema,
  planName: z.string().max(256),
  planType: z.enum(["MEDICAL", "DENTAL", "VISION", "LIFE", "DISABILITY", "RETIREMENT", "OTHER"]),
  coverageLevel: CoverageLevelSchema, // sensitive
  coverageBeginDate: IsoDateSchema,
  coverageEndDate: IsoDateSchema.nullable(),
});
export type BenefitEnrollment = z.infer<typeof BenefitEnrollmentSchema>;
