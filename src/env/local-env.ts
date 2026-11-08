/**
 * Local development env file loader (no dependency; uses node:util parseEnv).
 *
 * - Reads `.env.local` from the working directory (override with LOCAL_ENV_FILE).
 * - Never overrides a variable already set in the process environment, so shell, CI, and
 *   deployment values always win.
 * - Skipped entirely when NODE_ENV=production or SKIP_LOCAL_ENV=true: production config comes
 *   only from the deployment environment / secrets manager.
 * - A missing file is fine (nothing loaded). A file that exists but cannot be parsed throws.
 * - Never logs values; returns only the names it set.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export const LOCAL_ENV_FILE = ".env.local";

export type LocalEnvResult = { loaded: boolean; path?: string; keys: string[]; skipped?: "production" | "disabled" };

export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): LocalEnvResult {
  if (env.NODE_ENV === "production") return { loaded: false, keys: [], skipped: "production" };
  if (env.SKIP_LOCAL_ENV === "true") return { loaded: false, keys: [], skipped: "disabled" };
  const path = resolve(cwd, env.LOCAL_ENV_FILE || LOCAL_ENV_FILE);
  if (!existsSync(path)) return { loaded: false, path, keys: [] };
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const keys: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] !== undefined) continue;
    env[k] = v;
    keys.push(k);
  }
  return { loaded: true, path, keys };
}
