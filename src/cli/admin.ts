#!/usr/bin/env node
/**
 * Admin CLI (audited in admin_audit). Usage: npm run admin -- <command> [--flags]
 *   migrate | schema-status | keygen
 *   link-invite --slack-team T.. --slack-user U.. --user-id <id>
 *   link-revoke --slack-team T.. --slack-user U..
 *   roles-set --user-id <id> --roles worker_self[,manager] [--grants tool:x] [--denies tool:y]
 *   policy-set --approvers id1,id2 [--tool commit_request_time_off] [--allow-self] [--rotate]
 *   approvals-list [--status unknown]
 *   reconcile --id apr_... [--confirm-not-submitted]
 *   probe-time-off --user-id <id> --from YYYY-MM-DD --to YYYY-MM-DD --type <form type> [--quantity n]
 *     Read-only: looks up matching time-off entries with that user's own token (sandbox validation).
 * Actor: --actor or ADMIN_ACTOR (required for writes). Tenant: WORKDAY_TENANT.
 */
import { randomBytes } from "node:crypto";
import { createPgDb } from "../store/db.js";
import { migrate, schemaVersion, LATEST_SCHEMA_VERSION } from "../store/migrations.js";
import { buildRuntime, loadRuntimeConfig } from "../server/runtime.js";

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}
const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
function req(f: Record<string, string | true>, k: string): string {
  const v = f[k];
  if (typeof v !== "string" || !v) throw new Error(`--${k} is required`);
  return v;
}

export async function runAdmin(argv: string[], env: NodeJS.ProcessEnv = process.env, print: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<void> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (cmd === "keygen") {
    print(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
    print(`TOKEN_ENCRYPTION_KEY_ID=k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
    return;
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createPgDb(url, { max: 2 });
  try {
    if (cmd === "migrate") return print(`applied: [${(await migrate(db)).join(",")}]`);
    if (cmd === "schema-status") return print(`schema ${await schemaVersion(db)} / latest ${LATEST_SCHEMA_VERSION}`);
    const cfg = loadRuntimeConfig(env);
    const rt = buildRuntime({ cfg, db, env, log: () => {} });
    const tenantId = cfg.app.workdayTenant;
    const actor = typeof f.actor === "string" ? f.actor : env.ADMIN_ACTOR;
    const needActor = () => {
      if (!actor) throw new Error("--actor or ADMIN_ACTOR is required");
      return actor;
    };
    switch (cmd) {
      case "link-invite":
        await rt.links.invite(needActor(), { slackTeamId: req(f, "slack-team"), slackUserId: req(f, "slack-user"), tenantId, userId: req(f, "user-id") });
        return print("invited; the user runs the link command in Slack to complete Workday sign-in");
      case "link-revoke":
        return print((await rt.links.revoke(needActor(), req(f, "slack-team"), req(f, "slack-user"))) ? "revoked (tokens deleted)" : "no active link");
      case "roles-set":
        await rt.entitlements.set(needActor(), { tenantId, userId: req(f, "user-id") }, { roles: list(f.roles), grants: list(f.grants), denies: list(f.denies) });
        return print("roles updated");
      case "policy-set":
        await rt.backend.setPolicy(needActor(), { tenantId, commitTool: typeof f.tool === "string" ? f.tool : "commit_request_time_off", approverUserIds: list(f.approvers), allowSelfApproval: f["allow-self"] === true, rotate: f.rotate === true });
        return print("policy updated");
      case "approvals-list": {
        const rows = f.status === "reconcile" ? await rt.backend.needingReconcile(tenantId) : await rt.backend.list(tenantId, typeof f.status === "string" ? f.status : undefined);
        for (const r of rows) print(`${r.id}\t${r.status}\t${r.requesterUserId}\t${new Date(r.createdAt).toISOString()}\t${r.summary}`);
        return;
      }
      case "reconcile":
        return print(await rt.service.reconcile(needActor(), req(f, "id"), f["confirm-not-submitted"] === true));
      case "probe-time-off": {
        const map = JSON.parse(env.WORKDAY_TIME_OFF_TYPE_MAP ?? "{}") as Record<string, { type: "Time_Off_Type_ID"; value: string }>;
        const type = map[req(f, "type")];
        if (!type) throw new Error("--type not in WORKDAY_TIME_OFF_TYPE_MAP");
        const from = req(f, "from"), to = req(f, "to");
        const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
        const token = await (await import("../auth/user-tokens.js")).durableAccessTokens(db, rt.tokens, cfg.app)(req(f, "user-id"));
        const found = await rt.client.findMatchingTimeOffRequest(token, { startDate: from, endDate: to, unit: "DAYS", quantity: typeof f.quantity === "string" ? Number(f.quantity) : days, timeOffType: type });
        return print(found ? `match: event ${found.workdayEventId}` : "no matching entries");
      }
      default:
        throw new Error(`Unknown command '${cmd ?? ""}'. See src/cli/admin.ts header.`);
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1] && /admin\.(js|ts)$/.test(process.argv[1])) {
  runAdmin(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
