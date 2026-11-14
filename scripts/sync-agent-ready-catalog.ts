#!/usr/bin/env -S pnpm exec tsx
/**
 * Regenerate src/agent-ready/catalog.generated.ts from MCP Explorer CSV and/or ASOR JSON.
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-agent-ready-catalog.ts --csv <file> [--asor <file>] [--dry-run]
 *   pnpm exec tsx scripts/sync-agent-ready-catalog.ts --asor <file> [--dry-run]
 *
 * Required CSV columns: name, type|kind, description
 * Recommended: wid, product line|productArea, operationType, requiredPromptTools
 * See src/agent-ready/sync.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentReadyKind, AgentReadyOperationType, AgentReadyToolDefinition } from "../src/agent-ready/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../src/agent-ready/catalog.generated.ts");

type Args = { csv?: string; asor?: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--csv" || a === "--asor") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${a} needs a path`);
      if (a === "--csv") out.csv = value;
      else out.asor = value;
      i += 1;
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: sync-agent-ready-catalog.ts --csv <path> [--asor <path>] [--dry-run]
       sync-agent-ready-catalog.ts --asor <path> [--dry-run]`);
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}`);
  }
  if (!out.csv && !out.asor) throw new Error("Provide --csv and/or --asor");
  return out;
}

function normHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
  const headerLine = lines[0];
  if (!headerLine || lines.length < 2) return [];
  const headers = splitCsvLine(headerLine).map(normHeader);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

/** Minimal CSV splitter supporting quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseKind(raw: string | undefined): AgentReadyKind | undefined {
  if (!raw) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "basic" || k === "read" || k === "read-only" || k === "readonly") return "basic";
  if (k === "advanced" || k === "write" || k === "write-only" || k === "writeonly") return "advanced";
  if (k === "prompt" || k === "prompt-tool" || k === "prompt_tool") return "prompt";
  return undefined;
}

function parseOp(raw: string | undefined): AgentReadyOperationType | undefined {
  if (!raw) return undefined;
  const o = raw.trim().toUpperCase();
  if (o === "CREATE" || o === "PATCH" || o === "VIEW") return o;
  return undefined;
}

function inferKindFromName(name: string): AgentReadyKind {
  const n = name.toLowerCase();
  if (
    n.includes("prompt") ||
    n.startsWith("list_name_") ||
    n.startsWith("list_hereditary_") ||
    n.startsWith("list_social_")
  ) {
    return "prompt";
  }
  if (/^(create|change|update|request|submit|cancel|approve|deny|put|post|patch)/i.test(name)) return "advanced";
  return "basic";
}

function rowToTool(row: Record<string, string>): AgentReadyToolDefinition | null {
  const name = row.name || row.tool_name || row.tool || "";
  if (!name) return null;
  const kind = parseKind(row.type ?? row.kind ?? row.tool_type ?? row.tooltype) ?? inferKindFromName(name);
  const description = row.description || row.desc || `(Agent-Ready MCP tool: ${name})`;
  const productArea =
    row.product_area || row.productarea || row.product_line || row.productline || row.area || undefined;
  const wid = row.wid || row.id || row.agent_resource_id || undefined;
  const operationType = parseOp(row.operation_type ?? row.operationtype ?? row.operation);
  const promptsRaw = row.required_prompt_tools || row.requiredprompttools || row.required_prompts || "";
  const requiredPromptTools = promptsRaw
    ? promptsRaw
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return {
    name,
    ...(wid ? { wid } : {}),
    kind,
    ...(operationType ? { operationType } : {}),
    ...(productArea ? { productArea } : {}),
    description,
    ...(requiredPromptTools?.length ? { requiredPromptTools } : {}),
    source: "sync:csv",
  };
}

type AsorItem = {
  type?: string;
  name?: string;
  description?: string;
  wid?: string;
  mcpEnabled?: boolean;
  httpEnabled?: boolean;
  operationType?: string;
  productArea?: string;
  kind?: string;
};

function asorToTool(item: AsorItem): AgentReadyToolDefinition | null {
  if (!item.name) return null;
  const typeStr = (item.type ?? "").toUpperCase().replace(/_/g, " ");
  if (typeStr && !typeStr.includes("AGENT READY") && typeStr !== "AGENTREADY") {
    // Skip non-AGENT_READY rows when type is present
    return null;
  }
  const kind = parseKind(item.kind) ?? inferKindFromName(item.name);
  const operationType = parseOp(item.operationType);
  return {
    name: item.name,
    ...(item.wid ? { wid: item.wid } : {}),
    kind,
    ...(operationType ? { operationType } : {}),
    ...(item.productArea ? { productArea: item.productArea } : {}),
    description: item.description || `(Agent-Ready MCP tool: ${item.name})`,
    source: "sync:asor",
  };
}

function mergeTools(
  base: Map<string, AgentReadyToolDefinition>,
  incoming: AgentReadyToolDefinition[],
  prefer: "csv" | "asor",
): void {
  for (const t of incoming) {
    const key = t.name;
    const prev = base.get(key);
    if (!prev) {
      base.set(key, t);
      continue;
    }
    if (prefer === "csv") {
      base.set(key, {
        ...prev,
        ...t,
        wid: t.wid || prev.wid,
        requiredPromptTools: t.requiredPromptTools ?? prev.requiredPromptTools,
        source: [prev.source, t.source].filter(Boolean).join("+"),
      });
    } else {
      // ASOR: prefer wid; keep richer csv fields when present
      base.set(key, {
        ...prev,
        wid: t.wid || prev.wid,
        description: prev.description || t.description,
        kind: prev.source?.includes("csv") ? prev.kind : t.kind,
        operationType: prev.operationType ?? t.operationType,
        productArea: prev.productArea ?? t.productArea,
        source: [prev.source, t.source].filter(Boolean).join("+"),
      });
    }
  }
}

function emitTs(tools: AgentReadyToolDefinition[], sources: string[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const catalog = {
    meta: {
      generatedAt: new Date().toISOString(),
      completenessNote:
        "Regenerated by scripts/sync-agent-ready-catalog.ts from Explorer CSV and/or ASOR JSON. " +
        "Native Workday tools change without versioning; rediscover schemas at runtime on Workday MCP.",
      sources,
      toolCount: sorted.length,
    },
    tools: sorted,
  };
  return `/**
 * GENERATED FILE, do not hand-edit.
 * Regenerate: pnpm exec tsx scripts/sync-agent-ready-catalog.ts --csv <path> [--asor <path>]
 * See src/agent-ready/sync.md
 */
import type { AgentReadyCatalog } from "./types.js";

export const AGENT_READY_CATALOG: AgentReadyCatalog = ${JSON.stringify(catalog, null, 2)} as const satisfies AgentReadyCatalog;
`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const map = new Map<string, AgentReadyToolDefinition>();
  const sources: string[] = [];

  if (args.csv) {
    const path = resolve(args.csv);
    const rows = parseCsv(readFileSync(path, "utf8"));
    const tools = rows.map(rowToTool).filter((t): t is AgentReadyToolDefinition => t !== null);
    mergeTools(map, tools, "csv");
    sources.push(`csv:${path} (${tools.length} rows)`);
  }
  if (args.asor) {
    const path = resolve(args.asor);
    const raw = JSON.parse(readFileSync(path, "utf8")) as AsorItem[] | { data?: AsorItem[]; results?: AsorItem[] };
    const items = Array.isArray(raw) ? raw : (raw.data ?? raw.results ?? []);
    const tools = items.map(asorToTool).filter((t): t is AgentReadyToolDefinition => t !== null);
    mergeTools(map, tools, "asor");
    sources.push(`asor:${path} (${tools.length} items)`);
  }

  const tools = [...map.values()];
  console.log(`Catalog: ${tools.length} tools from ${sources.join("; ")}`);
  if (args.dryRun) {
    console.log("Dry-run: not writing", OUT);
    for (const t of tools.slice(0, 20)) console.log(`  - ${t.kind}\t${t.name}\t${t.wid ?? "(no wid)"}`);
    if (tools.length > 20) console.log(`  … ${tools.length - 20} more`);
    return;
  }
  writeFileSync(OUT, emitTs(tools, sources), "utf8");
  console.log(`Wrote ${OUT}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
