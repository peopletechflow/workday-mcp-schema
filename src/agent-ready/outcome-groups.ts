/**
 * Maps every catalog operation to one outcome tool. The catalog rows stay the
 * source of truth. Outcome tools route here. They do not replace the rows.
 */
import type { AgentReadyToolDefinition } from "./types.js";
import { allAgentReadyTools } from "./catalog.js";

export const OUTCOME_IDS = [
  "time_off",
  "worker",
  "organization",
  "job",
  "compensation",
  "benefits",
  "pay",
  "talent",
  "recruiting",
  "personal_data",
  "expenses",
  "business_process",
] as const;

export type OutcomeId = (typeof OUTCOME_IDS)[number];

function blob(tool: AgentReadyToolDefinition): string {
  return `${tool.name} ${tool.category ?? ""} ${tool.productArea ?? ""}`.toLowerCase();
}

/** First matching rule wins. A tool that matches none is a bug (tests fail closed). */
export function outcomeForCatalogTool(tool: AgentReadyToolDefinition): OutcomeId {
  const text = blob(tool);
  const area = (tool.productArea ?? "").toLowerCase();

  if (area.startsWith("payroll") || area === "payroll" || /\bpayslip|payroll|tax form|w-2|year-end/.test(text))
    return "pay";
  if (area.startsWith("benefits") || /\bbenefit|dependent/.test(text)) return "benefits";
  if (area.startsWith("spend") || /\bexpense/.test(text)) return "expenses";
  if (area.startsWith("talent / recruiting") || /candidate|job requisition|job posting/.test(text)) return "recruiting";
  if (area.startsWith("talent") || /\bgoal|performance|feedback|learning|education|job history/.test(text))
    return "talent";
  if (area.startsWith("compensation") || /compensation/.test(text)) return "compensation";
  if (area.startsWith("business process") || /business process|inbox|onboarding/.test(text)) return "business_process";
  if (area.includes("absence") || /time off|leave of absence|\babsence/.test(text)) return "time_off";
  if (/worktag/.test(text)) return "organization";
  if (
    area.includes("organizations") ||
    /org chart|organization|supervisory organization|direct report|reporting line/.test(text)
  ) {
    return "organization";
  }
  if (/change job|job profile|job \/ position|\bpositions\b|staffing jobs/.test(text)) return "job";
  if (
    area.includes("personal data") ||
    /personal|contact|preferred name|legal name|home contact|address|phone|email|web address|identifier|passport|visa|national id|government id|ethnicity|demographic|marital|gender/.test(
      text,
    )
  ) {
    return "personal_data";
  }
  if (/worker|service date|worker history|staffing/.test(text)) return "worker";
  throw new Error(`Catalog tool has no outcome group: ${tool.name}`);
}

export function catalogToolsForOutcome(outcome: OutcomeId): AgentReadyToolDefinition[] {
  return allAgentReadyTools().filter((tool) => outcomeForCatalogTool(tool) === outcome);
}

/**
 * Catalog names are never called through as Workday operations.
 * Outcome actions run the guarded layer-3 handlers. Payroll writes stay unexecuted.
 */
export function catalogCallReason(tool: AgentReadyToolDefinition): string {
  if (outcomeForCatalogTool(tool) === "pay" && tool.readOnly === false) {
    return "Payroll writes are not available. This server has no payroll mutation tool.";
  }
  if (tool.readOnly === false) {
    return "Write operations stay behind preview and commit on the outcome tool. This catalog name does not submit.";
  }
  return "Discovery only. This server does not call Workday under the catalog tool name.";
}
