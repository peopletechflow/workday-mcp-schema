# Refreshing the Agent-Ready catalog

This repo holds a **catalog** of Workday native Agent-Ready MCP tools (Layer 1). It does **not** re-implement Workday’s MCP server. Live calls go to Workday MCP after ASOR registration; schemas are discovered at runtime.

## Completeness

The seed in `catalog.generated.ts` is built from **public** Workday developer docs and marketing pages. Workday cites **400+** Agent-Ready tools; public pages only name a handful. Treat the seed as incomplete until you sync from Explorer / ASOR.

## Tenant-discovered tools

`catalog.tenant.ts` is hand-maintained. It holds tools that the Workday Developer Agent found on a real tenant `bzyvydgxsb_extdev` (2026-10-20): 13 read-only tools from Extend skill `worker-data-skill`, plus 34 from `self-service-skill` (19 reads, 15 staged writes with `businessProcess` steps). Also 41 from `manager-actions-skill` (35 reads, 6 writes) and 21 from `hr-partner-skill` (10 reads, 11 writes; the notes don't list its 28 shared tools, so those aren't tagged). Also 22 from `payroll-viewer-skill` (all reads; 4 more of its 26 tools were already catalogued and are tagged). The merged catalog has 137 tools (104 reads, 33 writes). Tools used by several skills are catalogued once, with `skills` listing all of them. `catalog.ts` merges it with `catalog.generated.ts` and dedupes by exact name. The generated row wins on WID, and the tenant row's provenance is appended to `source`. Regenerating the seed never removes tenant rows.

- `wid: null` means the WID was not exposed. To fill WIDs, dump ASOR into the generated seed (`--asor`). The merge then picks them up by name. Never type WIDs in by hand from memory.
- `params` lists only parameters seen during discovery (`contextInstanceId` WID|`"me"`, `search`, `email`, `limit`/`offset`, `organizationType`/subtype). Treat everything else as passthrough/unknown.
- Every tenant tool needs a role mapping in `src/rbac/agent-ready.ts`. `npm run check:rbac` enforces this.

## Required columns (CSV)

Export from [MCP Explorer](https://developer.workday.com/mcp-explorer) (updates weekly on Tuesdays) or build a CSV with at least:

| Column | Required | Notes |
| --- | --- | --- |
| `name` | yes | Exact Workday MCP tool name |
| `wid` | recommended | ASOR `agent_resource.id` |
| `type` or `kind` | yes | `basic` \| `advanced` \| `prompt` (aliases: Basic/Advanced/Prompt) |
| `description` | yes | Tool description |
| `product line` / `productArea` / `product_area` | no | e.g. Workforce, Financials |
| `operationType` / `operation_type` | no | `CREATE` \| `PATCH` \| `VIEW` |
| `requiredPromptTools` / `required_prompt_tools` | no | Comma-separated prompt tool names |

Header matching is case-insensitive; spaces and underscores are normalized.

## ASOR JSON dump

From a tenant with **Setup: Agents**:

```
GET https://us.agent.workday.com/asor/agentResourceSearch/v1
  ?searchString=<term>
  &toolType=AGENT_READY
  &protocol=MCP
```

Expected items:

```json
[
  {
    "type": "AGENT READY",
    "name": "getTimeOffEntries",
    "description": "Returns time off entries for a worker.",
    "wid": "386c0e439ecd100039e864720d570000",
    "mcpEnabled": true,
    "httpEnabled": false
  }
]
```

Dump one or more search results into a JSON array file. The sync script maps `type: "AGENT READY"` + name heuristics to `kind` when Explorer type is absent (`get*`/`list*` → basic, `create*`/`change*`/`update*`/`request*` → advanced, `*prompt*` / `list_*` name patterns used as prompts in docs → prompt when marked).

Prefer CSV from Explorer for `kind` / product area; use ASOR JSON for authoritative WIDs.

## Sync command

```bash
# CSV only
npx tsx scripts/sync-agent-ready-catalog.ts --csv path/to/explorer-export.csv

# ASOR JSON only
npx tsx scripts/sync-agent-ready-catalog.ts --asor path/to/asor-dump.json

# Merge both (CSV wins on kind/description/productArea; ASOR fills/overrides wid)
npx tsx scripts/sync-agent-ready-catalog.ts \
  --csv path/to/explorer-export.csv \
  --asor path/to/asor-dump.json

# Dry-run (print counts, write nothing)
npx tsx scripts/sync-agent-ready-catalog.ts --csv export.csv --dry-run
```

Writes `src/agent-ready/catalog.generated.ts`. Then:

```bash
npm run typecheck && npm run build && npm run check:rbac
```

## What this catalog is not

- No `call_*` passthrough tools that pretend to hit Workday.
- No hard-coded dependency for production agent prompts — Workday’s change policy treats renames as non-breaking for agents that rediscover schemas.
- Custom Layer-3 tools in `src/tools/` stay separate and unchanged.
