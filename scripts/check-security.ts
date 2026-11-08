/** Release-hardening checks: transport and redirect safety for every credential-bearing outbound call. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";

const base = { WORKDAY_TENANT: "sandbox_tenant", WORKDAY_USE_FIXTURES: "true" } as NodeJS.ProcessEnv;
for (const k of ["WORKDAY_BASE_URL", "WORKDAY_OAUTH_AUTHORIZE_URL", "WORKDAY_OAUTH_TOKEN_URL"]) {
  assert.throws(() => loadConfig({ ...base, [k]: "http://attacker.example.com/x" }), /must use https/, k);
  assert.throws(() => loadConfig({ ...base, [k]: "https://u:p@wd2-impl-services1.workday.com/x" }), /credentials/, k);
}
assert.doesNotThrow(() => loadConfig({ ...base, WORKDAY_OAUTH_TOKEN_URL: "http://127.0.0.1:9/token" }));
console.log("ok - Workday/OAuth URLs: https only (loopback excepted), no embedded credentials");

for (const f of ["src/workday/client.ts", "src/auth/oauth.ts", "src/integrations/slack/api.ts", "src/integrations/notion/access.ts"]) {
  assert.match(readFileSync(f, "utf8"), /redirect: "error"/, f);
}
console.log("ok - bearer/secret-carrying fetches refuse redirects");
