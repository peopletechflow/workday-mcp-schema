/**
 * Integration config (Slack, Notion, approval routing). Everything is disabled
 * unless explicitly configured. Secrets are read from env references only and are
 * never logged, returned, or placed in Slack metadata.
 */
import { z } from "zod";

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
function bool(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").toLowerCase());
}

export type SlackConfig = {
  enabled: boolean;
  /** Raw signing secret, held only in process memory. */
  signingSecret?: string;
  allowedTeamIds: string[];
  allowedChannelIds: string[];
  botUserId?: string;
  identityMapPath?: string;
  maxBodyBytes: number;
  maxIntakeTextChars: number;
  /** Approval delivery to Slack only when "explicit" AND channel + token configured. */
  approvalDelivery: "off" | "explicit";
  approvalChannelId?: string;
  botToken?: string;
  formTtlMs: number;
};

export type NotionConfig = {
  enabled: boolean;
  /** delegated: per-user token from a server-side store. allowlist: server token limited to policy file resources. */
  mode: "delegated" | "allowlist";
  resourcePolicyPath?: string;
  /** Used only in allowlist mode, and only for resources in the policy file. */
  serviceToken?: string;
  maxChars: number;
};

export type ApprovalConfig = {
  policyPath?: string;
  ttlMs: number;
};

export type IntegrationConfig = { slack: SlackConfig; notion: NotionConfig; approvals: ApprovalConfig };

export function loadIntegrationConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  const slackEnabled = bool(env.SLACK_ENABLED);
  const slack: SlackConfig = {
    enabled: slackEnabled,
    signingSecret: env.SLACK_SIGNING_SECRET || undefined,
    allowedTeamIds: list(env.SLACK_ALLOWED_TEAM_IDS),
    allowedChannelIds: list(env.SLACK_ALLOWED_CHANNEL_IDS),
    botUserId: env.SLACK_BOT_USER_ID || undefined,
    identityMapPath: env.SLACK_IDENTITY_MAP_PATH || undefined,
    maxBodyBytes: z.coerce.number().int().positive().max(1_000_000).catch(65_536).parse(env.SLACK_MAX_BODY_BYTES ?? 65_536),
    maxIntakeTextChars: z.coerce.number().int().positive().max(20_000).catch(4_000).parse(env.SLACK_MAX_INTAKE_CHARS ?? 4_000),
    approvalDelivery: env.SLACK_APPROVAL_DELIVERY === "explicit" ? "explicit" : "off",
    approvalChannelId: env.SLACK_APPROVAL_CHANNEL_ID || undefined,
    botToken: env.SLACK_BOT_TOKEN || undefined,
    formTtlMs: 10 * 60 * 1000,
  };
  if (slack.enabled) {
    const missing: string[] = [];
    if (!slack.signingSecret) missing.push("SLACK_SIGNING_SECRET");
    if (!slack.allowedTeamIds.length) missing.push("SLACK_ALLOWED_TEAM_IDS");
    if (!slack.allowedChannelIds.length) missing.push("SLACK_ALLOWED_CHANNEL_IDS");
    if (!slack.identityMapPath) missing.push("SLACK_IDENTITY_MAP_PATH");
    if (missing.length) throw new Error(`SLACK_ENABLED=true but missing: ${missing.join(", ")} (fail closed).`);
  }
  const notion: NotionConfig = {
    enabled: bool(env.NOTION_ENABLED),
    mode: env.NOTION_MODE === "delegated" ? "delegated" : "allowlist",
    resourcePolicyPath: env.NOTION_RESOURCE_POLICY_PATH || undefined,
    serviceToken: env.NOTION_SERVICE_TOKEN || undefined,
    maxChars: 8_000,
  };
  if (notion.enabled && !notion.resourcePolicyPath) {
    throw new Error("NOTION_ENABLED=true requires NOTION_RESOURCE_POLICY_PATH (fail closed).");
  }
  return {
    slack,
    notion,
    approvals: { policyPath: env.APPROVAL_POLICY_PATH || undefined, ttlMs: 15 * 60 * 1000 },
  };
}
