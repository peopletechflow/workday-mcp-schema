import { z } from "zod";

/** Normalized Workday fault (REST error body or WWS SOAP fault). */
export const WorkdayFaultSchema = z.object({
  code: z.string(),
  message: z.string(),
  surface: z.enum(["RaaS", "REST", "WWS"]).optional(),
  httpStatus: z.number().int().optional(),
  validationErrors: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
});
export type WorkdayFault = z.infer<typeof WorkdayFaultSchema>;

export const McpErrorCodeSchema = z.enum([
  "SIGN_IN_REQUIRED",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "PREVIEW_INVALID",
  "CONFIRMATION_REQUIRED",
  "TOOL_DISABLED",
  "RATE_LIMITED",
  "WORKDAY_FAULT",
  "NOT_IMPLEMENTED",
  "COMMIT_UNCERTAIN",
  "INTERNAL",
]);
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;

/** User-readable error returned by tools (never contains tokens or raw PII). */
export const McpToolErrorSchema = z.object({
  error: McpErrorCodeSchema,
  message: z.string(),
  authorizeUrl: z.url().optional(),
  fault: WorkdayFaultSchema.optional(),
});
export type McpToolError = z.infer<typeof McpToolErrorSchema>;
