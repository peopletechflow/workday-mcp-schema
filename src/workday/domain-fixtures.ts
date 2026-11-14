import { TeamMemberSchema, WorkerSummarySchema, type TeamMember, type WorkerSummary } from "../schemas/worker.js";
import { TimeOffRequestSchema, type TimeOffRequest, type TimeOffRequestStatus } from "../schemas/absence.js";
import { BenefitEnrollmentSchema, type BenefitEnrollment } from "../schemas/benefits.js";
import { PayStatementSummarySchema, type PayStatementSummary } from "../schemas/payroll.js";
import { SupervisoryOrgSchema, type SupervisoryOrg } from "../schemas/organization.js";
import type { WorkdayId } from "../schemas/common.js";
import type { DateWindow, WorkdayDomainClient } from "./domain.js";

/** PII-scrubbed synthetic fixtures. Names are fake. */
const ORG_REF = {
  id: { type: "Supervisory_Organization_ID" as const, value: "SUP_ENG_01" },
  descriptor: "Engineering (Fixture)",
};
const MGR_REF = { id: { type: "Employee_ID" as const, value: "E1000" }, descriptor: "Fixture Manager" };

const inWindow = (r: { startDate: string; endDate: string }, w: DateWindow) =>
  (!w.from || r.endDate >= w.from) && (!w.to || r.startDate <= w.to);

const asRequest = (row: unknown): TimeOffRequest => TimeOffRequestSchema.parse(row);

export class FixtureWorkdayDomainClient implements WorkdayDomainClient {
  private myRequests: TimeOffRequest[] = [
    asRequest({
      requestId: { type: "Time_Off_Entry_ID", value: "TOE_MY_1" },
      timeOffType: { type: "Time_Off_Type_ID", value: "PTO" },
      timeOffTypeName: "Paid Time Off",
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      quantity: 2,
      unit: "DAYS",
      status: "SUBMITTED",
      submittedAt: "2026-10-10T09:00:00Z",
      awaitingAction: MGR_REF,
    }),
  ];
  private teamRequests: TimeOffRequest[] = [
    asRequest({
      requestId: { type: "Time_Off_Entry_ID", value: "TOE_TEAM_1" },
      worker: { id: { type: "Employee_ID", value: "E2001" }, descriptor: "Fixture Report A" },
      timeOffType: { type: "Time_Off_Type_ID", value: "PTO" },
      timeOffTypeName: "Paid Time Off",
      startDate: "2026-11-09",
      endDate: "2026-11-13",
      quantity: 5,
      unit: "DAYS",
      status: "SUBMITTED",
      submittedAt: "2026-10-12T08:30:00Z",
      awaitingAction: MGR_REF,
    }),
  ];

  async getMyWorker(): Promise<WorkerSummary> {
    return WorkerSummarySchema.parse({
      workerId: { type: "Employee_ID", value: "E1234" },
      preferredName: "Fixture Worker",
      workerType: "EMPLOYEE",
      status: "ACTIVE",
      businessTitle: "Software Engineer",
      hireDate: "2022-03-01",
      terminationDate: null,
      supervisoryOrg: ORG_REF,
      manager: MGR_REF,
    });
  }
  async listMyTimeOffRequests(_t: string, w: DateWindow, status?: TimeOffRequestStatus[]) {
    return this.myRequests.filter((r) => inWindow(r, w) && (!status || status.includes(r.status)));
  }
  async getTimeOffRequest(_t: string, id: WorkdayId) {
    return [...this.myRequests, ...this.teamRequests].find((r) => r.requestId.value === id.value);
  }
  async cancelTimeOffRequest(_t: string, id: WorkdayId) {
    const r = this.myRequests.find((x) => x.requestId.value === id.value);
    if (!r) throw new Error("Time-off request not found or not yours.");
    r.status = "CANCELED";
    r.awaitingAction = null;
    return r;
  }
  async listMyTeam(_t: string, includeInactive: boolean): Promise<TeamMember[]> {
    const all: TeamMember[] = [
      {
        workerId: { type: "Employee_ID", value: "E2001" },
        preferredName: "Fixture Report A",
        workerType: "EMPLOYEE",
        status: "ACTIVE",
        businessTitle: "Engineer",
      },
      {
        workerId: { type: "Contingent_Worker_ID", value: "C3001" },
        preferredName: "Fixture Contractor B",
        workerType: "CONTINGENT_WORKER",
        status: "ACTIVE",
        businessTitle: "Contractor",
      },
      {
        workerId: { type: "Employee_ID", value: "E2002" },
        preferredName: "Fixture Report C",
        workerType: "EMPLOYEE",
        status: "TERMINATED",
      },
    ].map((row) => TeamMemberSchema.parse(row));
    return includeInactive ? all : all.filter((m) => m.status !== "TERMINATED");
  }
  async listTeamTimeOffRequests(_t: string, w: DateWindow, status: TimeOffRequestStatus[]) {
    return this.teamRequests.filter((r) => inWindow(r, w) && status.includes(r.status));
  }
  async decideTimeOffRequest(_t: string, id: WorkdayId, action: "APPROVE" | "DENY") {
    const r = this.teamRequests.find((x) => x.requestId.value === id.value);
    if (!r) throw new Error("Request not found in your approval inbox.");
    r.status = action === "APPROVE" ? "APPROVED" : "DENIED";
    r.awaitingAction = null;
    return r;
  }
  async getMyBenefitEnrollments(): Promise<BenefitEnrollment[]> {
    return [
      {
        planId: { type: "Benefit_Plan_ID", value: "MED_PPO" },
        planName: "Medical PPO (Fixture)",
        planType: "MEDICAL",
        coverageLevel: "EMPLOYEE_ONLY",
        coverageBeginDate: "2026-01-01",
        coverageEndDate: null,
      },
      {
        planId: { type: "Benefit_Plan_ID", value: "DEN_BASIC" },
        planName: "Dental Basic (Fixture)",
        planType: "DENTAL",
        coverageLevel: "EMPLOYEE_ONLY",
        coverageBeginDate: "2026-01-01",
        coverageEndDate: null,
      },
    ].map((row) => BenefitEnrollmentSchema.parse(row));
  }
  async listMyPayStatements(_t: string, w: DateWindow): Promise<PayStatementSummary[]> {
    const rows: PayStatementSummary[] = ["2026-08-31", "2026-09-30"].map((d, i) =>
      PayStatementSummarySchema.parse({
        statementId: { type: "Pay_Statement_ID", value: `PS_${i + 1}` },
        payGroup: { id: { type: "Pay_Group_ID", value: "PG_MONTHLY" }, name: "Monthly (Fixture)" },
        periodStart: `${d.slice(0, 8)}01`,
        periodEnd: d,
        payDate: d,
        currency: "EUR",
        grossAmount: 5000,
        netAmount: 3200,
      }),
    );
    return rows.filter((r) => (!w.from || r.payDate >= w.from) && (!w.to || r.payDate <= w.to));
  }
  async getSupervisoryOrg(_t: string, id: WorkdayId): Promise<SupervisoryOrg | undefined> {
    if (id.value !== ORG_REF.id.value) return undefined;
    return SupervisoryOrgSchema.parse({
      orgId: ORG_REF.id,
      name: "Engineering (Fixture)",
      manager: MGR_REF,
      superiorOrg: {
        id: { type: "Supervisory_Organization_ID", value: "SUP_TECH" },
        descriptor: "Technology (Fixture)",
      },
      subordinateOrgCount: 0,
      memberCount: 3,
      costCenter: { id: { type: "Cost_Center_Reference_ID", value: "CC_100" }, code: "CC100", name: "R&D" },
      location: null,
    });
  }
}
