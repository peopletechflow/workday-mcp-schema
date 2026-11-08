/**
 * Read-only: lists the tools this agent's ASU session can see (paginated tools/list) with contract fingerprints,
 * to help an operator write AGENT_TOOL_POLICY_PATH. It calls no Workday tool and approves nothing by itself.
 */
import { asuEndpoints, AsuTokenProvider } from "../src/agent-gateway/asu.js";
import { asuConfigFromEnv, loadSession, saveSession } from "../src/agent-gateway/env.js";
import { connectUpstream } from "../src/agent-gateway/upstream.js";
import { analyzeSchema, fingerprint } from "../src/agent-gateway/agentready.js";

const cfg = asuConfigFromEnv(process.env); const path = process.env.ASU_SESSION_FILE!;
const p = new AsuTokenProvider(cfg, loadSession(path), { onChange: (s) => saveSession(path, s) });
const up = await connectUpstream({ url: asuEndpoints(cfg).mcp, accessToken: p.token });
for (const t of await up.listTools()) console.log(JSON.stringify({ name: t.name, fingerprint: fingerprint(t), annotations: t.annotations, personPaths: analyzeSchema(t.inputSchema as never).subjectPaths, schemaProblems: analyzeSchema(t.inputSchema as never).problems }));
await up.close();
