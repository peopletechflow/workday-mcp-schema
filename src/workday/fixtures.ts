import type { TimeOffBalance, TimeOffRequestInput, TimeOffRequestResult } from "./types.js";
import type { WorkdayClient } from "./client.js";

/**
 * Recorded-fixture client for contract tests and local MCP demos.
 * Responses are PII-scrubbed. Swap for HttpWorkdayClient when WORKDAY_USE_FIXTURES=false.
 */
export class FixtureWorkdayClient implements WorkdayClient {
  private submitted: TimeOffRequestResult[] = [];

  async getMyTimeOffBalances(_accessToken: string, asOf?: string): Promise<TimeOffBalance[]> {
    return [
      {
        timeOffType: { type: "Time_Off_Type_ID", value: "PTO" },
        timeOffTypeName: "Paid Time Off",
        unit: "DAYS",
        available: 12.5,
        pending: 1,
        asOf: asOf ?? "2026-10-15",
      },
      {
        timeOffType: { type: "Time_Off_Type_ID", value: "SICK" },
        timeOffTypeName: "Sick Leave",
        unit: "DAYS",
        available: 5,
        pending: 0,
        asOf: asOf ?? "2026-10-15",
      },
    ];
  }

  async findMatchingTimeOffRequest(
    _accessToken: string,
    input: TimeOffRequestInput,
  ): Promise<TimeOffRequestResult | undefined> {
    return this.submitted.find(
      (r) =>
        r.startDate === input.startDate &&
        r.endDate === input.endDate &&
        r.quantity === input.quantity &&
        r.unit === input.unit &&
        r.timeOffType.value === input.timeOffType.value,
    );
  }

  async submitTimeOffRequest(_accessToken: string, input: TimeOffRequestInput): Promise<TimeOffRequestResult> {
    const result: TimeOffRequestResult = {
      workdayEventId: `evt_fixture_${this.submitted.length + 1}`,
      status: "SUBMITTED",
      startDate: input.startDate,
      endDate: input.endDate,
      quantity: input.quantity,
      unit: input.unit,
      timeOffType: input.timeOffType,
    };
    this.submitted.push(result);
    return result;
  }
}

/** Seam for injecting recorded JSON fixtures in tests without live HTTP. */
export function createWorkdayClientFromFixtureData(balances: TimeOffBalance[]): WorkdayClient {
  const client = new FixtureWorkdayClient();
  client.getMyTimeOffBalances = async () => balances;
  return client;
}
