/** Env + session file helpers for the Agent Gateway CLIs. The secret is read from a file; the session file is chmod 600. */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { AsuConfig, AsuSession } from "./asu.js";

function secretFile(path: string, label: string): string {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${label} must not be readable by group or others (chmod 600).`);
  const v = readFileSync(path, "utf8").trim(); if (!v) throw new Error(`${label} is empty.`); return v;
}
export function asuConfigFromEnv(env: NodeJS.ProcessEnv): AsuConfig {
  const need = ["WORKDAY_AGENT_GATEWAY", "WORKDAY_TENANT_ALIAS", "ASU_CLIENT_ID", "ASU_CLIENT_SECRET_FILE", "ASU_REDIRECT_URI"].filter((k) => !env[k]);
  if (need.length) throw new Error(`Agent Gateway needs ${need.join(", ")} (values come from configuring the agent in ASOR).`);
  return { gatewayHost: env.WORKDAY_AGENT_GATEWAY!, tenantAlias: env.WORKDAY_TENANT_ALIAS!, clientId: env.ASU_CLIENT_ID!, clientSecret: secretFile(env.ASU_CLIENT_SECRET_FILE!, "ASU_CLIENT_SECRET_FILE"), redirectUri: env.ASU_REDIRECT_URI!, production: env.NODE_ENV === "production" };
}
const Session = z.object({ gatewayHost: z.string(), tenantAlias: z.string(), clientId: z.string(), workerId: z.string().optional(), accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number() }).strict();
export const loadSession = (path: string): AsuSession | undefined => { try { return Session.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; } };
export function saveSession(path: string, s: AsuSession | undefined) { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(s ?? {}), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path); }
