import type { WorkerSummary, TeamMember } from "../schemas/worker.js";
import type { TimeOffRequest, TimeOffRequestStatus } from "../schemas/absence.js";
import type { BenefitEnrollment } from "../schemas/benefits.js";
import type { PayStatementSummary } from "../schemas/payroll.js";
import type { SupervisoryOrg } from "../schemas/organization.js";
import type { WorkdayId } from "../schemas/common.js";
import type { AppConfig } from "../config.js";

export type DateWindow = { from?: string; to?: string };

/**
 * Task-shaped Workday reads/writes beyond the original time-off trio.
 * Every method takes the caller's access token — there is no service-account variant.
 * Surface per method is documented in src/tools/registry.ts.
 */
export interface WorkdayDomainClient {
  getMyWorker(accessToken: string): Promise<WorkerSummary>;
  listMyTimeOffRequests(accessToken: string, w: DateWindow, status?: TimeOffRequestStatus[]): Promise<TimeOffRequest[]>;
  getTimeOffRequest(accessToken: string, id: WorkdayId): Promise<TimeOffRequest | undefined>;
  cancelTimeOffRequest(accessToken: string, id: WorkdayId, reason?: string): Promise<TimeOffRequest>;
  listMyTeam(accessToken: string, includeInactive: boolean): Promise<TeamMember[]>;
  listTeamTimeOffRequests(accessToken: string, w: DateWindow, status: TimeOffRequestStatus[]): Promise<TimeOffRequest[]>;
  decideTimeOffRequest(accessToken: string, id: WorkdayId, action: "APPROVE" | "DENY", comment?: string): Promise<TimeOffRequest>;
  getMyBenefitEnrollments(accessToken: string, asOf?: string): Promise<BenefitEnrollment[]>;
  listMyPayStatements(accessToken: string, w: DateWindow): Promise<PayStatementSummary[]>;
  getSupervisoryOrg(accessToken: string, id: WorkdayId): Promise<SupervisoryOrg | undefined>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not wired to live Workday yet. Run with WORKDAY_USE_FIXTURES=true against a sandbox.`);
    this.name = "NotImplementedError";
  }
}

/** Live client placeholder: wire RaaS/REST/WWS calls here (sandbox first). */
export class HttpWorkdayDomainClient implements WorkdayDomainClient {
  constructor(private readonly _config: AppConfig) {}
  private ni(m: string): never {
    throw new NotImplementedError(m);
  }
  async getMyWorker(): Promise<WorkerSummary> { return this.ni("getMyWorker"); }
  async listMyTimeOffRequests(): Promise<TimeOffRequest[]> { return this.ni("listMyTimeOffRequests"); }
  async getTimeOffRequest(): Promise<TimeOffRequest | undefined> { return this.ni("getTimeOffRequest"); }
  async cancelTimeOffRequest(): Promise<TimeOffRequest> { return this.ni("cancelTimeOffRequest"); }
  async listMyTeam(): Promise<TeamMember[]> { return this.ni("listMyTeam"); }
  async listTeamTimeOffRequests(): Promise<TimeOffRequest[]> { return this.ni("listTeamTimeOffRequests"); }
  async decideTimeOffRequest(): Promise<TimeOffRequest> { return this.ni("decideTimeOffRequest"); }
  async getMyBenefitEnrollments(): Promise<BenefitEnrollment[]> { return this.ni("getMyBenefitEnrollments"); }
  async listMyPayStatements(): Promise<PayStatementSummary[]> { return this.ni("listMyPayStatements"); }
  async getSupervisoryOrg(): Promise<SupervisoryOrg | undefined> { return this.ni("getSupervisoryOrg"); }
}
