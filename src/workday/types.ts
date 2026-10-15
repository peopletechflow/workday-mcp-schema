import type { WorkdayId } from "../schemas/common.js";

export type TimeOffBalance = {
  timeOffType: WorkdayId;
  timeOffTypeName: string;
  unit: "HOURS" | "DAYS";
  available: number;
  pending: number;
  asOf: string;
};

export type TimeOffRequestInput = {
  startDate: string;
  endDate: string;
  unit: "HOURS" | "DAYS";
  quantity: number;
  timeOffType: WorkdayId;
  comment?: string;
};

export type TimeOffRequestResult = {
  workdayEventId: string;
  status: "SUBMITTED" | "IN_PROGRESS" | "APPROVED" | "DENIED";
  startDate: string;
  endDate: string;
  quantity: number;
  unit: "HOURS" | "DAYS";
  timeOffType: WorkdayId;
};

export type WorkdayFault = {
  code: string;
  message: string;
};
