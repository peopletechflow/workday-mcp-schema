/**
 * Sign in a delegate user through the Workday Agent Gateway (OAuth 2.1 authorization code + PKCE) and store the
 * ASU session at ASU_SESSION_FILE (chmod 600). Needs the agent registered, configured and activated in ASOR first.
 * Flow: open the printed URL, sign in and allow, then paste the full redirect URL here.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { authorizeUrl, exchangeCode, pkcePair } from "../src/agent-gateway/asu.js";
import { asuConfigFromEnv, saveSession } from "../src/agent-gateway/env.js";

const cfg = asuConfigFromEnv(process.env);
if (!process.env.ASU_SESSION_FILE) throw new Error("Set ASU_SESSION_FILE.");
const state = randomBytes(16).toString("base64url"); const { verifier, challenge } = pkcePair();
console.log(`Open and sign in:\n${authorizeUrl(cfg, state, challenge)}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const back = new URL((await rl.question("Paste the full redirect URL: ")).trim()); rl.close();
if (`${back.origin}${back.pathname}` !== `${new URL(cfg.redirectUri).origin}${new URL(cfg.redirectUri).pathname}`) throw new Error("Redirect URL does not match ASU_REDIRECT_URI.");
if (back.searchParams.get("state") !== state) throw new Error("State mismatch; not exchanging the code.");
const code = back.searchParams.get("code"); if (!code) throw new Error(`No code in redirect (${back.searchParams.get("error") ?? "unknown error"}).`);
saveSession(process.env.ASU_SESSION_FILE, await exchangeCode(cfg, code, verifier));
console.log("ASU session saved. The worker is bound on first server start.");
