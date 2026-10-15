import { z } from "zod";
import { IsoDateSchema } from "../common.js";
import { BenefitEnrollmentSchema } from "../benefits.js";
import { defineTool } from "./contract.js";

export const getMyBenefitsEnrollments = defineTool({
  name: "get_my_benefits_enrollments",
  title: "Get my benefits enrollments",
  description:
    "Read-only. Returns the signed-in worker's current benefit elections (plan, coverage level, dates). No dependents or costs. Who: any authenticated worker.",
  toolClass: "read",
  input: { asOf: IsoDateSchema.optional() },
  output: { enrollments: z.array(BenefitEnrollmentSchema) },
});
