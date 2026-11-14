import { z } from "zod";
import { IdempotencyKeySchema, PreviewTokenSchema, UserConfirmedSchema } from "../common.js";

export type ToolClass = "read" | "write-preview" | "write-commit";
export type WorkdaySurface = "RaaS" | "REST" | "WWS" | "catalog";
export type ToolAudience = "worker" | "manager";

/** Schema-first tool contract. Registration code consumes these; nothing else defines tool I/O. */
export type ToolContract<I extends z.ZodRawShape, O extends z.ZodRawShape> = {
  name: string;
  title: string;
  /** What it does, who can use it, read vs write. */
  description: string;
  toolClass: ToolClass;
  input: I;
  output: O;
};

export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  c: ToolContract<I, O>,
): ToolContract<I, O> {
  return c;
}

/** Input shared by every commit_* tool. */
export const CommitInputShape = {
  previewToken: PreviewTokenSchema,
  idempotencyKey: IdempotencyKeySchema,
  userConfirmed: UserConfirmedSchema,
};

/** Common preview_* output envelope; `willSubmit` is specialized per tool. */
export function previewOutput<W extends z.ZodType>(willSubmit: W) {
  return {
    previewToken: PreviewTokenSchema,
    expiresInSeconds: z.number().int().positive(),
    summary: z.string(),
    willSubmit,
    nextStep: z.string(),
  };
}

/** Common commit_* output envelope; `result` is specialized per tool. */
export function commitOutput<R extends z.ZodType>(result: R) {
  return {
    replayed: z.boolean(),
    submitted: z.boolean(),
    reusedExisting: z.boolean(),
    summary: z.string(),
    result,
  };
}
