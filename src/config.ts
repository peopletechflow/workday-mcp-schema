import { z } from "zod";

const ConfigSchema = z.object({
  workdayBaseUrl: z.string().url(),
  workdayTenant: z.string().min(1),
  oauthClientId: z.string().min(1),
  oauthClientSecret: z.string().min(1),
  oauthRedirectUri: z.string().url(),
  oauthAuthorizeUrl: z.string().url(),
  oauthTokenUrl: z.string().url(),
  oauthScopes: z.string().default("openid"),
  tokenStorePath: z.string().default(".data/tokens.json"),
  auditLogPath: z.string().default(".data/audit.jsonl"),
  allowProd: z.boolean().default(false),
  useFixtures: z.boolean().default(true),
  disabledTools: z.array(z.string()).default([]),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const PROD_HOST_HINTS = [
  "services1.workday.com",
  "myworkday.com",
  "wd3.myworkday.com",
  "wd5.myworkday.com",
  "wd12.myworkday.com",
];

function looksLikeProduction(baseUrl: string, tenant: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const tenantLower = tenant.toLowerCase();
  if (tenantLower.includes("prod") && !tenantLower.includes("sandbox")) {
    return true;
  }
  // Implementation / preview hosts are safe; bare services hosts without impl/preview are suspect.
  if (host.includes("impl") || host.includes("preview") || host.includes("sandbox")) {
    return false;
  }
  return PROD_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Load config from environment. Refuses production tenants unless
 * WORKDAY_ALLOW_PROD=true is set explicitly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const disabled =
    env.WORKDAY_DISABLED_TOOLS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];

  const parsed = ConfigSchema.safeParse({
    workdayBaseUrl: env.WORKDAY_BASE_URL ?? "https://wd2-impl-services1.workday.com",
    workdayTenant: env.WORKDAY_TENANT ?? "sandbox_tenant",
    oauthClientId: env.WORKDAY_OAUTH_CLIENT_ID ?? "replace_me",
    oauthClientSecret: env.WORKDAY_OAUTH_CLIENT_SECRET ?? "replace_me",
    oauthRedirectUri: env.WORKDAY_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:8787/oauth/callback",
    oauthAuthorizeUrl:
      env.WORKDAY_OAUTH_AUTHORIZE_URL ??
      "https://wd2-impl.workday.com/sandbox_tenant/authorize",
    oauthTokenUrl:
      env.WORKDAY_OAUTH_TOKEN_URL ??
      "https://wd2-impl-services1.workday.com/ccx/oauth2/sandbox_tenant/token",
    oauthScopes: env.WORKDAY_OAUTH_SCOPES ?? "openid",
    tokenStorePath: env.WORKDAY_TOKEN_STORE_PATH ?? ".data/tokens.json",
    auditLogPath: env.WORKDAY_AUDIT_LOG_PATH ?? ".data/audit.jsonl",
    allowProd: envBool("WORKDAY_ALLOW_PROD", false),
    useFixtures: envBool("WORKDAY_USE_FIXTURES", true),
    disabledTools: disabled,
  });

  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }

  const config = parsed.data;
  if (looksLikeProduction(config.workdayBaseUrl, config.workdayTenant) && !config.allowProd) {
    throw new Error(
      "Refusing to start against what looks like a production Workday tenant. " +
        "Develop against a sandbox/implementation tenant, or set WORKDAY_ALLOW_PROD=true " +
        "only with an explicit change ticket and rollback plan.",
    );
  }

  return config;
}

export function assertToolEnabled(config: AppConfig, toolName: string): void {
  if (config.disabledTools.includes(toolName)) {
    throw new Error(`Tool '${toolName}' is disabled by WORKDAY_DISABLED_TOOLS kill switch.`);
  }
}
