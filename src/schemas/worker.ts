import { z } from "zod";
import { IsoDateSchema, RefSchema, WorkerIdSchema } from "./common.js";

export const WorkerTypeSchema = z.enum(["EMPLOYEE", "CONTINGENT_WORKER"]);
export const WorkerStatusSchema = z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]);

/**
 * Minimal worker summary. Deliberately excludes SSN/national ID, DOB, bank details,
 * home address, personal email/phone, compensation.
 */
export const WorkerSummarySchema = z.object({
  workerId: WorkerIdSchema,
  preferredName: z.string().max(256), // PII: name
  workerType: WorkerTypeSchema,
  status: WorkerStatusSchema,
  businessTitle: z.string().max(256).optional(),
  hireDate: IsoDateSchema, // PII (low): employment date
  terminationDate: IsoDateSchema.nullable(), // PII (low)
  supervisoryOrg: RefSchema,
  manager: RefSchema.nullable(), // PII: manager name in descriptor
  location: RefSchema.optional(),
  jobProfile: RefSchema.optional(),
});
export type WorkerSummary = z.infer<typeof WorkerSummarySchema>;

/** Team member row for manager views, even smaller than the profile. */
export const TeamMemberSchema = WorkerSummarySchema.pick({
  workerId: true,
  preferredName: true, // PII: name
  workerType: true,
  status: true,
  businessTitle: true,
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;
