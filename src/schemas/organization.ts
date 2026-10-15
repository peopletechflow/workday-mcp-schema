import { z } from "zod";
import { CostCenterIdSchema, RefSchema, SupervisoryOrgIdSchema } from "./common.js";

export const CostCenterRefSchema = z.object({
  id: CostCenterIdSchema,
  code: z.string().max(64),
  name: z.string().max(256),
});
export type CostCenterRef = z.infer<typeof CostCenterRefSchema>;

export const SupervisoryOrgSchema = z.object({
  orgId: SupervisoryOrgIdSchema,
  name: z.string().max(256),
  manager: RefSchema.nullable(), // PII: manager name in descriptor
  superiorOrg: RefSchema.nullable(),
  subordinateOrgCount: z.number().int().min(0),
  memberCount: z.number().int().min(0),
  costCenter: CostCenterRefSchema.nullable(),
  location: RefSchema.nullable(),
});
export type SupervisoryOrg = z.infer<typeof SupervisoryOrgSchema>;
