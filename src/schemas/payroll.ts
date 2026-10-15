import { z } from "zod";
import { CurrencyCodeSchema, IsoDateSchema, PayGroupIdSchema, PayStatementIdSchema } from "./common.js";

/**
 * READ-ONLY. There are intentionally no payroll mutation schemas in this package.
 * Excludes bank account, routing number, tax IDs, line-level deductions.
 */
export const PayStatementSummarySchema = z.object({
  statementId: PayStatementIdSchema,
  payGroup: z.object({ id: PayGroupIdSchema, name: z.string() }),
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
  payDate: IsoDateSchema,
  currency: CurrencyCodeSchema,
  grossAmount: z.number(), // PII: compensation
  netAmount: z.number(), // PII: compensation
});
export type PayStatementSummary = z.infer<typeof PayStatementSummarySchema>;

export const PayDateSchema = z.object({
  payDate: IsoDateSchema,
  periodStart: IsoDateSchema,
  periodEnd: IsoDateSchema,
});
export type PayDate = z.infer<typeof PayDateSchema>;
