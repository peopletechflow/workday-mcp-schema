import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as T from "../schemas/tools/index.js";
import type { TimeOffRequest } from "../schemas/absence.js";
import { MAX_RECORDS_PER_CALL, type WorkdayId } from "../schemas/common.js";
import type { z } from "zod";
import type { ToolContract } from "../schemas/tools/contract.js";
import type { ToolDeps } from "./framework.js";
import { registerRead, registerWritePair, ToolUserError } from "./framework.js";

const page = <R>(rows: R[], limit: number, offset: number) => ({
  rows: rows.slice(offset, offset + Math.min(limit, MAX_RECORDS_PER_CALL)),
  page: { total: rows.length, limit, offset },
});

/** Registers every scaffolded tool beyond the original time-off trio. */
export function registerScaffoldTools(server: McpServer, deps: ToolDeps): void {
  const d = deps.domain;

  registerRead(server, deps, T.getMyWorkerProfile, async ({ accessToken }) => ({
    worker: await d.getMyWorker(accessToken),
  }));

  registerRead(server, deps, T.listMyTimeOffRequests, async ({ accessToken }, a) => {
    const rows = await d.listMyTimeOffRequests(accessToken, { from: a.from, to: a.to }, a.status);
    const p = page(rows, a.limit, a.offset);
    return { requests: p.rows, page: p.page };
  });

  registerWritePair(
    server, deps, T.previewCancelTimeOff, T.commitCancelTimeOff,
    async ({ accessToken }, a) => {
      const req = await d.getTimeOffRequest(accessToken, a.requestId);
      if (!req || req.worker) throw new ToolUserError("NOT_FOUND", "Time-off request not found among your own requests.");
      if (req.status === "CANCELED" || req.status === "DENIED") {
        throw new ToolUserError("VALIDATION_FAILED", `Request is already ${req.status}.`);
      }
      return {
        summary: `Cancel time off ${req.startDate}..${req.endDate} (${req.quantity} ${req.unit.toLowerCase()}, currently ${req.status})`,
        willSubmit: { requestId: a.requestId, startDate: req.startDate, endDate: req.endDate, currentStatus: req.status, reason: a.reason ?? null },
      };
    },
    async ({ accessToken }, w) => {
      // Check Workday for current state first: already canceled => reuse, no duplicate BP.
      const current = await d.getTimeOffRequest(accessToken, w.requestId);
      if (current?.status === "CANCELED") return { result: current, reusedExisting: true, workdayEventId: current.requestId.value };
      const r = await d.cancelTimeOffRequest(accessToken, w.requestId, w.reason ?? undefined);
      return { result: r, reusedExisting: false, workdayEventId: r.requestId.value };
    },
  );

  registerRead(server, deps, T.listMyTeam, async ({ accessToken }, a) => {
    const p = page(await d.listMyTeam(accessToken, a.includeInactive), a.limit, a.offset);
    return { members: p.rows, page: p.page };
  });

  registerRead(server, deps, T.listTeamTimeOffRequests, async ({ accessToken }, a) => {
    const rows = await d.listTeamTimeOffRequests(accessToken, { from: a.from, to: a.to }, a.status);
    const p = page(rows, a.limit, a.offset);
    return { requests: p.rows, page: p.page };
  });

  const registerDecision = <PI extends z.ZodRawShape, PO extends z.ZodRawShape, CI extends z.ZodRawShape, CO extends z.ZodRawShape>(
    action: "APPROVE" | "DENY",
    preview: ToolContract<PI, PO>,
    commit: ToolContract<CI, CO>,
  ) => {
    const target = action === "APPROVE" ? "APPROVED" : "DENIED";
    registerWritePair(
      server, deps, preview, commit,
      async ({ accessToken }, raw) => {
        const a = raw as unknown as { requestId: WorkdayId; comment?: string };
        const req: TimeOffRequest | undefined = await d.getTimeOffRequest(accessToken, a.requestId);
        if (!req || !req.worker) throw new ToolUserError("NOT_FOUND", "Request not found in your team approval inbox.");
        if (req.status !== "SUBMITTED" && req.status !== "IN_PROGRESS") {
          throw new ToolUserError("VALIDATION_FAILED", `Request is ${req.status}; nothing to ${action.toLowerCase()}.`);
        }
        return {
          summary: `${action === "APPROVE" ? "Approve" : "Deny"} ${req.worker.descriptor}'s time off ${req.startDate}..${req.endDate} (${req.quantity} ${req.unit.toLowerCase()})`,
          willSubmit: { action, request: req, comment: a.comment ?? null },
        };
      },
      async ({ accessToken }, w: { action: string; request: TimeOffRequest; comment: string | null }) => {
        const current = await d.getTimeOffRequest(accessToken, w.request.requestId);
        if (current?.status === target) return { result: current, reusedExisting: true, workdayEventId: current.requestId.value };
        const r = await d.decideTimeOffRequest(accessToken, w.request.requestId, action, w.comment ?? undefined);
        return { result: r, reusedExisting: false, workdayEventId: r.requestId.value };
      },
    );
  };
  registerDecision("APPROVE", T.previewApproveTimeOff, T.commitApproveTimeOff);
  registerDecision("DENY", T.previewDenyTimeOff, T.commitDenyTimeOff);

  registerRead(server, deps, T.getMyBenefitsEnrollments, async ({ accessToken }, a) => ({
    enrollments: await d.getMyBenefitEnrollments(accessToken, a.asOf),
  }));

  // Payroll: read-only. There is deliberately no registerWritePair for payroll.
  registerRead(server, deps, T.listMyPayStatements, async ({ accessToken }, a) => {
    const p = page(await d.listMyPayStatements(accessToken, { from: a.from, to: a.to }), a.limit, a.offset);
    return { statements: p.rows, page: p.page };
  });

  registerRead(server, deps, T.getSupervisoryOrg, async ({ accessToken }, a) => {
    const org = await d.getSupervisoryOrg(accessToken, a.orgId);
    if (!org) throw new ToolUserError("NOT_FOUND", "Supervisory org not found or not visible to you.");
    return { org };
  });
}
