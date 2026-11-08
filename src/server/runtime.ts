/**
 * Runtime composition shared by the server entrypoint, the admin CLI, and offline checks.
 * All configuration comes from environment variables and is validated up front.
 */
import { z } from "zod";
import { loadConfig, workdayClientOptions, type AppConfig } from "../config.js";
import { loadIntegrationConfig, type IntegrationConfig } from "../integrations/config.js";
import type { Db } from "../store/db.js";
import { KeyRing } from "../store/crypto.js";
import { migrationStatus } from "../store/migrations.js";
import { DbEntitlements, DbFormSessions, DbIdentityLinks, DbReplayGuard, DbTokenStore } from "../store/repos.js";
import { DbApprovalBackend } from "../store/approvals.js";
import { HttpWorkdayClient, ContractNotValidatedError, type WorkdayClient } from "../workday/client.js";
import { FixtureWorkdayClient } from "../workday/fixtures.js";
import { durableAccessTokens } from "../auth/user-tokens.js";
import { ApprovalExecutionService, parseTypeMap } from "../integrations/approvals/execution.js";
import { LinkService } from "../integrations/link.js";
import { createRouter } from "../integrations/http.js";
import { createHttpSlackApi, type SlackApi } from "../integrations/slack/api.js";
import { BackgroundTasks } from "../integrations/background.js";
import { SlackApprovalNotifier } from "../integrations/slack/notify.js";
import type { IntakeSink, IntakeRecord } from "../integrations/slack/intake.js";
import { createLogger, type LogFn } from "../observability/log.js";

export type RuntimeConfig = {
  app: AppConfig;
  integrations: IntegrationConfig;
  port: number;
  databaseUrl: string;
  production: boolean;
  migrateOnStart: boolean;
  commandName: string;
  /**
   * Account linking cannot yet prove the Workday account that signs in is the admin-invited
   * user id (no sandbox-validated "who am I" contract). Production requires this explicit
   * acknowledgement (LINK_ACCEPT_UNVERIFIED_SIGNER=true). See docs/RUNBOOK.md.
   */
  acceptUnverifiedLinkSigner: boolean;
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const app = loadConfig(env);
  const integrations = loadIntegrationConfig(env);
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL ?? "";
  const errors: string[] = [];
  if (!databaseUrl) errors.push("DATABASE_URL is required");
  if (!env.TOKEN_ENCRYPTION_KEY || !env.TOKEN_ENCRYPTION_KEY_ID) errors.push("TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_ID are required");
  if (production) {
    if (app.useFixtures) errors.push("NODE_ENV=production requires WORKDAY_USE_FIXTURES=false");
    if (!app.oauthRedirectUri.startsWith("https://")) errors.push("WORKDAY_OAUTH_REDIRECT_URI must be https in production");
    if (integrations.slack.enabled && !integrations.slack.botToken) errors.push("SLACK_BOT_TOKEN is required for forms (views.open) in production");
    if (env.WORKDAY_TOKEN_ENCRYPTION_KEY === "local-dev-only-change-me") errors.push("Do not use the local dev token key");
    if (env.LINK_ACCEPT_UNVERIFIED_SIGNER !== "true") {
      errors.push(
        "LINK_ACCEPT_UNVERIFIED_SIGNER=true is required in production: account linking does not yet verify that the Workday account " +
          "that signs in is the invited user (see docs/RUNBOOK.md, 'Account linking identity')",
      );
    }
  }
  const port = z.coerce.number().int().min(1).max(65535).safeParse(env.PORT ?? "8787");
  if (!port.success) errors.push("PORT must be 1-65535");
  if (errors.length) throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  return {
    app,
    integrations,
    port: port.success ? port.data : 8787,
    databaseUrl,
    production,
    migrateOnStart: env.DB_MIGRATE_ON_START === "true",
    commandName: env.SLACK_COMMAND_NAME || "/workday",
    acceptUnverifiedLinkSigner: env.LINK_ACCEPT_UNVERIFIED_SIGNER === "true",
  };
}

/** Intake sink that records only metadata in logs (message text is not persisted). */
export function metadataOnlySink(log: LogFn): IntakeSink {
  return { put: (r: IntakeRecord) => log({ evt: "intake_record", tenant: r.identity.tenantId, channel: r.channelId, chars: r.text.length }) };
}

export function buildRuntime(opts: {
  cfg: RuntimeConfig;
  db: Db;
  env?: NodeJS.ProcessEnv;
  workdayClient?: WorkdayClient;
  slackApi?: SlackApi;
  fetchImpl?: typeof fetch;
  log?: LogFn;
  sink?: IntakeSink;
  nowSec?: number;
  budgetMs?: number;
}) {
  const { cfg, db } = opts;
  const env = opts.env ?? process.env;
  const log = opts.log ?? createLogger({ svc: "workday-integrations" });
  const keys = KeyRing.fromEnv(env);
  const tenantId = cfg.app.workdayTenant;
  const links = new DbIdentityLinks(db);
  const entitlements = new DbEntitlements(db);
  const tokens = new DbTokenStore(db, keys, tenantId);
  const backend = new DbApprovalBackend(db, cfg.integrations.approvals.decisionTtlMs, undefined, cfg.integrations.approvals.commitWindowMs);
  const client: WorkdayClient =
    opts.workdayClient ?? (cfg.app.useFixtures ? new FixtureWorkdayClient() : new HttpWorkdayClient(cfg.app, workdayClientOptions(cfg.app), opts.fetchImpl));
  const accessToken = durableAccessTokens(db, tokens, cfg.app, opts.fetchImpl);
  const required = ["timeOffDetails.list", "requestTimeOff.create"] as const;
  const service = new ApprovalExecutionService({
    tenantId,
    backend,
    client,
    accessToken,
    // Slack ack paths only check that a link exists; the token refresh happens at commit.
    linked: async (userId) => Boolean(await tokens.get(userId)),
    authzFor: (i) => entitlements.authzFor(i),
    typeMap: parseTypeMap(env.WORKDAY_TIME_OFF_TYPE_MAP),
    assertCommitContract: cfg.app.useFixtures
      ? undefined
      : () => {
          for (const op of required) if (!cfg.app.validatedOperations.includes(op)) throw new ContractNotValidatedError(op);
        },
    log,
  });
  const link = new LinkService({ db, config: cfg.app, keys, links, tokens, fetchImpl: opts.fetchImpl });
  const slackApi = opts.slackApi ?? (cfg.integrations.slack.botToken ? createHttpSlackApi(cfg.integrations.slack.botToken) : undefined);
  const notifier = new SlackApprovalNotifier({ config: cfg.integrations.slack, api: slackApi, directory: links, commandName: cfg.commandName, log });
  const background = new BackgroundTasks({ log });
  const ready = async () => (await migrationStatus(db)).state === "up_to_date";
  const route = createRouter({
    slack: cfg.integrations.slack,
    identities: links,
    replay: new DbReplayGuard(db),
    sessions: new DbFormSessions(db),
    service,
    decider: backend,
    link,
    slackApi,
    notifier,
    background,
    commandName: cfg.commandName,
    budgetMs: opts.budgetMs,
    sink: opts.sink ?? metadataOnlySink(log),
    ready,
    log,
    nowSec: opts.nowSec,
  });
  return { route, service, backend, links, entitlements, tokens, link, keys, client, log, ready, notifier, background };
}
