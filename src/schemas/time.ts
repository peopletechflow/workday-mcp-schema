import { z } from "zod";
import { IsoDateSchema, RefSchema } from "./common.js";

/** Summary only, no clock-in geolocation, device, or punch-level detail. */
export const TimeEntrySummarySchema = z.object({
  worker: RefSchema, // PII: name
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
  reportedHours: z.number().min(0),
  scheduledHours: z.number().min(0),
  status: z.enum(["NOT_SUBMITTED", "SUBMITTED", "APPROVED", "SENT_BACK"]),
});
export type TimeEntrySummary = z.infer<typeof TimeEntrySummarySchema>;

export const WorkScheduleSummarySchema = z.object({
  name: z.string().max(256),
  weeklyHours: z.number().min(0).max(168),
});
export type WorkScheduleSummary = z.infer<typeof WorkScheduleSummarySchema>;
