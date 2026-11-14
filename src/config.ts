import { z } from "zod";

const ConfigSchema = z.object({
  workdayBaseUrl: z.url(),
  workdayTenant: z.string().min(1),
  oauthClientId: z.string().min(1),
  oauthClientSecret: z.string().min(1),
  oauthRedirectUri: z.url(),
  oauthAuthorizeUrl: z.url(),
  oauthTokenUrl: z.url(),
  oauthScopes: z.string().default("openid"),
  tokenStorePath: z.string().default(".data/tokens.json"),
  auditLogPath: z.string().default(".data/audit.jsonl"),
  allowProd: z.boolean().default(false),
  useFixtures: z.boolean().default(true),
  disabledTools: z.array(z.string()).default([]),
  /** Required for live mode; copy the version from your tenant's REST directory. */
  absenceApiVersion: z
    .string()
    .regex(/^v\d+(\.\d+)?$/)
    .optional(),
  /** Workday operations validated in sandbox for this deployment (others fail closed). */
  validatedOperations: z.array(z.enum(["requestTimeOff.create", "timeOffDetails.list", "balances.list"])).default([]),
  workdayHttpTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  /** Reads per user per tool per window. */
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
  /** Write actions per user per tool per window. */
  rateLimitWritePerMinute: z.number().int().min(1).max(10_000).default(10),
  rateLimitWindowMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  /** When true, also register one MCP tool per catalog operation. Off by default. */
  exposeFullCatalog: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Workday production API / UI hosts. Covers bare and data-center-prefixed forms, e.g.
 * services1.workday.com, wd2-services1.workday.com, wd5-services1.myworkday.com,
 * wd3.myworkday.com, www.myworkday.com.
 */
const PROD_HOST_PATTERNS = [
  /(^|\.)(wd\d+-)?services\d*\.(my)?workday\.com$/,
  /(^|\.)wd\d+\.(my)?workday\.com$/,
  /(^|\.)myworkday\.com$/,
];

export function looksLikeProduction(baseUrl: string, tenant: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const tenantLower = tenant.toLowerCase();
  if (tenantLower.includes("prod") && !tenantLower.includes("sandbox")) {
    return true;
  }
  // Implementation / preview / sandbox hosts are non-production.
  if (host.includes("impl") || host.includes("preview") || host.includes("sandbox")) {
    return false;
  }
  return PROD_HOST_PATTERNS.some((re) => re.test(host));
}

function envBool(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
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
    oauthAuthorizeUrl: env.WORKDAY_OAUTH_AUTHORIZE_URL ?? "https://wd2-impl.workday.com/sandbox_tenant/authorize",
    oauthTokenUrl:
      env.WORKDAY_OAUTH_TOKEN_URL ?? "https://wd2-impl-services1.workday.com/ccx/oauth2/sandbox_tenant/token",
    oauthScopes: env.WORKDAY_OAUTH_SCOPES ?? "openid",
    tokenStorePath: env.WORKDAY_TOKEN_STORE_PATH ?? ".data/tokens.json",
    auditLogPath: env.WORKDAY_AUDIT_LOG_PATH ?? ".data/audit.jsonl",
    allowProd: envBool("WORKDAY_ALLOW_PROD", false, env),
    useFixtures: envBool("WORKDAY_USE_FIXTURES", true, env),
    disabledTools: disabled,
    absenceApiVersion: env.WORKDAY_ABSENCE_API_VERSION || undefined,
    validatedOperations: (env.WORKDAY_VALIDATED_OPERATIONS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    workdayHttpTimeoutMs: env.WORKDAY_HTTP_TIMEOUT_MS ? Number(env.WORKDAY_HTTP_TIMEOUT_MS) : 15000,
    rateLimitPerMinute: env.WORKDAY_RATE_LIMIT_PER_MINUTE ? Number(env.WORKDAY_RATE_LIMIT_PER_MINUTE) : 60,
    rateLimitWritePerMinute: env.WORKDAY_RATE_LIMIT_WRITE_PER_MINUTE
      ? Number(env.WORKDAY_RATE_LIMIT_WRITE_PER_MINUTE)
      : 10,
    rateLimitWindowMs: env.WORKDAY_RATE_LIMIT_WINDOW_MS ? Number(env.WORKDAY_RATE_LIMIT_WINDOW_MS) : 60_000,
    exposeFullCatalog: envBool("WORKDAY_EXPOSE_FULL_CATALOG", false, env),
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

  if (!config.useFixtures) {
    if (!config.absenceApiVersion)
      throw new Error("WORKDAY_ABSENCE_API_VERSION is required when WORKDAY_USE_FIXTURES=false (no default version).");
    for (const k of ["oauthClientId", "oauthClientSecret"] as const) {
      if (config[k] === "replace_me") throw new Error(`Live mode requires ${k} to be configured.`);
    }
  }
  return config;
}

const DEV_TOKEN_SECRET = "local-dev-only-change-me";

/**
 * Secret for the stdio server's file token store. Fixtures may use a dev secret; live mode
 * requires WORKDAY_TOKEN_ENCRYPTION_KEY (at least 32 characters) and never falls back.
 */
export function tokenStoreSecret(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WORKDAY_TOKEN_ENCRYPTION_KEY?.trim();
  if (config.useFixtures) return raw || DEV_TOKEN_SECRET;
  if (!raw || raw === DEV_TOKEN_SECRET || raw.length < 32) {
    throw new Error("Live mode requires WORKDAY_TOKEN_ENCRYPTION_KEY (at least 32 characters; no fallback key).");
  }
  return raw;
}

export function workdayClientOptions(config: AppConfig) {
  return {
    apiVersion: config.absenceApiVersion ?? "v0",
    validatedOperations: config.validatedOperations,
    timeoutMs: config.workdayHttpTimeoutMs,
  };
}

export function assertToolEnabled(config: AppConfig, toolName: string): void {
  if (config.disabledTools.includes(toolName)) {
    throw new Error(`Tool '${toolName}' is disabled by WORKDAY_DISABLED_TOOLS kill switch.`);
  }
}
