import { SupervisoryOrgIdSchema } from "../common.js";
import { SupervisoryOrgSchema } from "../organization.js";
import { defineTool } from "./contract.js";

export const getSupervisoryOrg = defineTool({
  name: "get_supervisory_org",
  title: "Get supervisory organization",
  description:
    "Read-only. Returns a supervisory org summary (name, manager, superior org, counts, cost center) by Workday ID. Who: workers/managers per Workday security.",
  toolClass: "read",
  input: { orgId: SupervisoryOrgIdSchema.describe("Supervisory_Organization_ID or WID") },
  output: { org: SupervisoryOrgSchema },
});
