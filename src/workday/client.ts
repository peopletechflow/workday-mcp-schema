import type { AppConfig } from "../config.js";
import type {
  TimeOffBalance,
  TimeOffRequestInput,
  TimeOffRequestResult,
  WorkdayFault,
} from "./types.js";

/**
 * Workday HTTP surface behind an interface so tools stay fixture-friendly.
 * Live REST/WWS calls belong here — never as raw MCP passthrough tools.
 */
export interface WorkdayClient {
  getMyTimeOffBalances(accessToken: string, asOf?: string): Promise<TimeOffBalance[]>;
  findMatchingTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult | undefined>;
  submitTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult>;
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

/**
 * Live client stub: shapes requests against Workday REST Absence endpoints.
 * Wire real paths/WSDL after confirming tenant report definitions.
 * Prefer RaaS for filtered reads; submit time-off through the business process.
 */
export class HttpWorkdayClient implements WorkdayClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    const base = this.config.workdayBaseUrl.replace(/\/$/, "");
    return `${base}/api/absenceManagement/v1/${this.config.workdayTenant}${path}`;
  }

  async getMyTimeOffBalances(accessToken: string, asOf?: string): Promise<TimeOffBalance[]> {
    const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
    const res = await this.fetchImpl(this.url(`/balances${qs}`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    const json = (await res.json()) as { data?: unknown[] };
    // Mapping is intentionally explicit and narrow — drop unused PII fields.
    return (json.data ?? []).map((row) => mapBalance(row));
  }

  async findMatchingTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult | undefined> {
    const qs = new URLSearchParams({
      from: input.startDate,
      to: input.endDate,
      status: "SUBMITTED,IN_PROGRESS,APPROVED",
    });
    const res = await this.fetchImpl(this.url(`/workers/me/timeOffRequest?${qs}`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    const json = (await res.json()) as { data?: unknown[] };
    const match = (json.data ?? [])
      .map((row) => mapRequest(row))
      .find(
        (r) =>
          r.startDate === input.startDate &&
          r.endDate === input.endDate &&
          r.quantity === input.quantity &&
          r.unit === input.unit &&
          r.timeOffType.value === input.timeOffType.value,
      );
    return match;
  }

  async submitTimeOffRequest(
    accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult> {
    // Submit through the business process — never bypass BP approvals.
    const res = await this.fetchImpl(this.url("/workers/me/timeOffRequest"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        days: [
          {
            date: input.startDate,
            endDate: input.endDate,
            dailyQuantity: input.quantity,
            unit: { id: input.unit },
          },
        ],
        timeOffType: {
          id: input.timeOffType.value,
          type: input.timeOffType.type,
        },
        comment: input.comment,
      }),
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    return mapRequest(await res.json());
  }

  private async toError(res: Response): Promise<WorkdayApiError> {
    let message = `Workday HTTP ${res.status}`;
    let code = `HTTP_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string; code?: string };
      message = body.message ?? body.error ?? message;
      code = body.code ?? code;
    } catch {
      // ignore non-JSON fault bodies
    }
    return new WorkdayApiError(res.status, { code, message });
  }
}

function mapBalance(row: unknown): TimeOffBalance {
  const r = row as Record<string, unknown>;
  const typeId = String(r.timeOffTypeId ?? r.id ?? "unknown");
  return {
    timeOffType: { type: "Time_Off_Type_ID", value: typeId },
    timeOffTypeName: String(r.timeOffTypeName ?? r.name ?? typeId),
    unit: (r.unit as "HOURS" | "DAYS") ?? "DAYS",
    available: Number(r.available ?? r.balance ?? 0),
    pending: Number(r.pending ?? 0),
    asOf: String(r.asOf ?? new Date().toISOString().slice(0, 10)),
  };
}

function mapRequest(row: unknown): TimeOffRequestResult {
  const r = row as Record<string, unknown>;
  return {
    workdayEventId: String(r.id ?? r.workdayEventId ?? ""),
    status: (r.status as TimeOffRequestResult["status"]) ?? "SUBMITTED",
    startDate: String(r.startDate ?? ""),
    endDate: String(r.endDate ?? ""),
    quantity: Number(r.quantity ?? 0),
    unit: (r.unit as "HOURS" | "DAYS") ?? "DAYS",
    timeOffType: {
      type: "Time_Off_Type_ID",
      value: String((r.timeOffType as { id?: string } | undefined)?.id ?? r.timeOffTypeId ?? ""),
    },
  };
}
