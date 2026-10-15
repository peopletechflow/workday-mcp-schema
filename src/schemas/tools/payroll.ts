import { z } from "zod";
import { IsoDateSchema, PageInfoSchema, PageInputShape } from "../common.js";
import { PayStatementSummarySchema } from "../payroll.js";
import { defineTool } from "./contract.js";

/** Payroll is READ-ONLY. Never add preview_/commit_ payroll tools. */
export const listMyPayStatements = defineTool({
  name: "list_my_pay_statements",
  title: "List my pay statements",
  description:
    "Read-only. Lists the signed-in worker's pay statement summaries (pay date, period, gross/net). No bank or tax details. Never writes payroll. Who: any authenticated worker.",
  toolClass: "read",
  input: {
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    ...PageInputShape,
  },
  output: { statements: z.array(PayStatementSummarySchema), page: PageInfoSchema },
});
