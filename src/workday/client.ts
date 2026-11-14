import type { AppConfig } from "../config.js";
import { scrubSensitiveText } from "../safety/redact.js";
import {
  LiveBalanceListSchema,
  LiveCreateTimeOffResponseSchema,
  LiveFaultBodySchema,
  LiveTimeOffDetailListSchema,
  TimeOffBalanceSchema,
  TimeOffRequestResultSchema,
  type TimeOffBalance,
} from "../schemas/absence.js";
import type { TimeOffRequestInput, TimeOffRequestResult, WorkdayFault } from "./types.js";

/**
 * Workday HTTP surface behind an interface so tools stay fixture-friendly.
 * Live REST/WWS calls belong here, never as raw MCP passthrough tools.
 */
export interface WorkdayClient {
  getMyTimeOffBalances(accessToken: string, asOf?: string): Promise<TimeOffBalance[]>;
  findMatchingTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult | undefined>;
  submitTimeOffRequest(accessToken: string, input: TimeOffRequestInput): Promise<TimeOffRequestResult>;
}

export class WorkdayApiError extends Error {
  readonly fault: WorkdayFault;
  readonly status: number;

  constructor(status: number, fault: WorkdayFault) {
    super(fault.message);
    this.name = "WorkdayApiError";
    this.status = status;
    this.fault = fault;
  }
}

/** Network timeout, 5xx, or a 2xx without a usable id on a write: Workday may or may not have the request. */
export class WorkdayAmbiguousResultError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkdayAmbiguousResultError";
  }
}

/** Live JSON did not match the absence schema. Nothing is invented to fill the gap. */
export class WorkdayResponseParseError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkdayResponseParseError";
  }
}

/** Input cannot be expressed as a valid Workday request; nothing was sent. */
export class WorkdayRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkdayRequestValidationError";
  }
}

/** Operation whose request/response contract has not been validated in a sandbox for this deployment. */
export class ContractNotValidatedError extends Error {
  constructor(readonly operation: WorkdayOperation) {
    super(
      `Workday operation '${operation}' is blocked pending sandbox contract validation. ` +
        `Validate it against your sandbox tenant, then add it to WORKDAY_VALIDATED_OPERATIONS.`,
    );
    this.name = "ContractNotValidatedError";
  }
}

/**
 * Operations and what is verified about them (Workday public REST Directory, absenceManagement):
 * - requestTimeOff.create: POST /workers/{ID}/requestTimeOff, "me" named entry allowed;
 *   "Creates a time off request ... and initiates the business process". Path verified.
 *   Body shape (days[].date / dailyQuantity / timeOffType.id / comment) is from non-official
 *   specs and must be validated in sandbox.
 * - timeOffDetails.list: GET /workers/{ID}/timeOffDetails. Path verified; fromDate/toDate
 *   filter names are from non-official specs and must be validated.
 * - balances.list: GET /balances "for the specified worker ID". Path verified; the worker
 *   query parameter name is NOT verified, so this stays blocked until validated.
 * API version is not defaulted: set WORKDAY_ABSENCE_API_VERSION to the version shown in your
 * tenant's REST directory.
 */
export const WORKDAY_OPERATIONS = ["requestTimeOff.create", "timeOffDetails.list", "balances.list"] as const;
export type WorkdayOperation = (typeof WORKDAY_OPERATIONS)[number];

export type HttpWorkdayOptions = {
  apiVersion: string;
  validatedOperations: readonly WorkdayOperation[];
  timeoutMs: number;
};

function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last && out.length <= 31) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (out.length > 31)
    throw new WorkdayRequestValidationError("Time-off range longer than 31 days is not supported in one request.");
  return out;
}

/** Build the requestTimeOff body. Exported for contract tests. */
export function buildRequestTimeOffBody(input: TimeOffRequestInput): Record<string, unknown> {
  const days = enumerateDays(input.startDate, input.endDate);
  const daily = input.quantity / days.length;
  if (input.unit === "DAYS" && daily !== 1 && daily !== 0.5) {
    throw new WorkdayRequestValidationError(
      "For DAYS, quantity must equal the number of calendar days (or half of it) in the range.",
    );
  }
  if (!Number.isFinite(daily) || daily <= 0) throw new WorkdayRequestValidationError("Invalid quantity.");
  return {
    days: days.map((date) => ({
      date,
      dailyQuantity: daily,
      timeOffType: { id: input.timeOffType.value },
      ...(input.comment ? { comment: input.comment } : {}),
    })),
  };
}

/**
 * Live Workday absence client. Every call uses the caller's own OAuth token and the "me"
 * named entry, so Workday security decides access. Operations not listed as validated fail
 * closed before any network call.
 */
export class HttpWorkdayClient implements WorkdayClient {
  constructor(
    private readonly config: AppConfig,
    private readonly opts: HttpWorkdayOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^v\d+(\.\d+)?$/.test(opts.apiVersion))
      throw new Error("WORKDAY_ABSENCE_API_VERSION must look like v1 or v1.2");
  }

  private gate(op: WorkdayOperation): void {
    if (!this.opts.validatedOperations.includes(op)) throw new ContractNotValidatedError(op);
  }

  private url(path: string): string {
    const base = this.config.workdayBaseUrl.replace(/\/$/, "");
    return `${base}/ccx/api/absenceManagement/${this.opts.apiVersion}/${encodeURIComponent(this.config.workdayTenant)}${path}`;
  }

  private async call(
    op: WorkdayOperation,
    path: string,
    accessToken: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    this.gate(op);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };
      if (init.body) headers["Content-Type"] = "application/json";
      return await this.fetchImpl(this.url(path), {
        method: init.method ?? "GET",
        headers,
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      if (init.method === "POST")
        throw new WorkdayAmbiguousResultError(op, `Network error or timeout on ${op}; outcome unknown.`);
      throw e;
    }
  }

  async getMyTimeOffBalances(accessToken: string, asOf?: string): Promise<TimeOffBalance[]> {
    const qs = new URLSearchParams({ worker: "me", ...(asOf ? { asOf } : {}) });
    const res = await this.call("balances.list", `/balances?${String(qs)}`, accessToken);
    if (!res.ok) throw await this.toError(res);
    const parsed = LiveBalanceListSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new WorkdayResponseParseError(
        "balances.list",
        "Workday balance response did not match the absence schema.",
      );
    }
    return parsed.data.data.map((row) => balanceFromRow(row));
  }

  async findMatchingTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult | undefined> {
    const qs = new URLSearchParams({ fromDate: input.startDate, toDate: input.endDate, limit: "100" });
    const res = await this.call("timeOffDetails.list", `/workers/me/timeOffDetails?${String(qs)}`, accessToken);
    if (!res.ok) throw await this.toError(res);
    const parsed = LiveTimeOffDetailListSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new WorkdayResponseParseError(
        "timeOffDetails.list",
        "Workday time-off detail response did not match the absence schema.",
      );
    }
    const wanted = new Set(enumerateDays(input.startDate, input.endDate));
    const rows = parsed.data.data.filter((row) => {
      const date = row.date.slice(0, 10);
      const status = (typeof row.status === "string" ? row.status : row.status.descriptor).toLowerCase();
      return wanted.has(date) && row.timeOffType.id === input.timeOffType.value && !/cancel|denied|reject/.test(status);
    });
    const covered = new Set(rows.map((row) => row.date.slice(0, 10)));
    if (covered.size !== wanted.size) return undefined;
    const first = rows[0];
    if (!first) return undefined;
    return TimeOffRequestResultSchema.parse({
      workdayEventId: first.id,
      status: "SUBMITTED",
      startDate: input.startDate,
      endDate: input.endDate,
      quantity: input.quantity,
      unit: input.unit,
      timeOffType: input.timeOffType,
    });
  }

  async submitTimeOffRequest(accessToken: string, input: TimeOffRequestInput): Promise<TimeOffRequestResult> {
    const body = buildRequestTimeOffBody(input);
    const res = await this.call("requestTimeOff.create", "/workers/me/requestTimeOff", accessToken, {
      method: "POST",
      body,
    });
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw new WorkdayAmbiguousResultError(
        "requestTimeOff.create",
        `Workday returned HTTP ${res.status}; outcome unknown.`,
      );
    }
    if (!res.ok) throw await this.toError(res);
    const raw = await res.json().catch(() => undefined);
    const parsed = LiveCreateTimeOffResponseSchema.safeParse(raw);
    const id = parsed.success ? (parsed.data.id ?? parsed.data.businessProcess?.id) : undefined;
    if (!id) {
      throw new WorkdayAmbiguousResultError(
        "requestTimeOff.create",
        "Workday accepted the request but returned no usable id. The outcome must be reconciled.",
      );
    }
    return TimeOffRequestResultSchema.parse({
      workdayEventId: id,
      status: "SUBMITTED",
      startDate: input.startDate,
      endDate: input.endDate,
      quantity: input.quantity,
      unit: input.unit,
      timeOffType: input.timeOffType,
    });
  }

  private async toError(res: Response): Promise<WorkdayApiError> {
    let message = `Workday HTTP ${res.status}`;
    let code = `HTTP_${res.status}`;
    try {
      const parsed = LiveFaultBodySchema.safeParse(await res.json());
      if (parsed.success) {
        message = parsed.data.message ?? parsed.data.error ?? message;
        code = parsed.data.code ?? code;
      }
    } catch {
      // ignore non-JSON fault bodies
    }
    return new WorkdayApiError(res.status, { code, message: scrubSensitiveText(message).slice(0, 300) });
  }
}

function balanceFromRow(row: {
  timeOffTypeId?: string | undefined;
  id?: string | undefined;
  timeOffTypeName?: string | undefined;
  descriptor?: string | undefined;
  name?: string | undefined;
  unit: "HOURS" | "DAYS";
  available?: number | undefined;
  balance?: number | undefined;
  pending: number;
  asOf: string;
}): TimeOffBalance {
  const typeId = row.timeOffTypeId ?? row.id;
  const name = row.timeOffTypeName ?? row.descriptor ?? row.name;
  const available = row.available ?? row.balance;
  if (!typeId || !name || available === undefined) {
    throw new WorkdayResponseParseError("balances.list", "Balance row is missing type, name, or available amount.");
  }
  const parsed = TimeOffBalanceSchema.safeParse({
    timeOffType: { type: "Time_Off_Type_ID", value: typeId },
    timeOffTypeName: name,
    unit: row.unit,
    available,
    pending: row.pending,
    asOf: row.asOf,
  });
  if (!parsed.success) {
    throw new WorkdayResponseParseError("balances.list", "Balance row did not match TimeOffBalanceSchema.");
  }
  return parsed.data;
}
