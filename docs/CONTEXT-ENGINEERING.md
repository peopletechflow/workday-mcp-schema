# Context engineering for the agents in this repo

Source: Anthropic, "Effective context engineering for AI agents" (https://www.anthropic.com/research/effective-context-engineering-for-ai-agents). Its core rule: give the model "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome." Context is a finite attention budget; every token spent on something the model does not need costs recall on the things it does.

This page says how the repo applies that, so changes to prompts, tools, and `AGENTS.md` can be judged against it.

## Where the rules apply

| Surface | File | What goes into the model's context |
| --- | --- | --- |
| Slack and Notion agent | `src/ai/integration-agent.ts` | `INTEGRATION_SYSTEM_PROMPT`, the permission-built toolset, wrapped tool results |
| Enterprise Layer-3 agent | `src/ai/enterprise-agent.ts` | `DEFAULT_INSTRUCTIONS`, reads and previews (commit tools only when `allowWriteCommits` is true), tool results wrapped with `wrapUntrusted` |
| Audit log | `src/safety/audit.ts` | Redacted inputs, a status, and a scrubbed error message. `summarizeToolResult` is not called here. |
| Coding agents working on this repo | `AGENTS.md`, `docs/*.md` | The up-front guide plus files read on demand |

## System prompts: one altitude, sections, canonical examples

The article's two failure modes are brittle if-else logic in the prompt and vague guidance that "falsely assumes shared context." Both agent prompts sit between them:

- Sections with explicit tags: `<background>`, `<security_rules>` (or `<rules>`), `<tool_guidance>`, `<output>`, `<examples>`. The model can find the part it needs; a reviewer can see what is missing.
- Security rules are the only enumerated list, because they are the part that must hold whatever the model reads. Everything else is a short heuristic, not a case table.
- Three canonical examples replace a list of edge cases: a read, a propose, and an injection attempt. Add an example only when a real failure mode shows one is missing; do not add one per feature.
- Authorization is enforced in code (`assertToolAllowedForUser`, the approval ledger). The prompt is defense in depth, so it does not try to be a policy engine. "Minimal does not necessarily mean short," but here it is also short.

## Tools: a minimal set with unambiguous contracts

The article names bloated tool sets and ambiguous tool choice as common failure modes, and tools as "the contract between agents and their information/action space."

- The toolset is built per request from the caller's permissions (`buildIntegrationToolset`), so the model only ever sees tools it can use. A missing tool is itself a signal, and the prompt says what it means.
- Tool descriptions and parameters come from the schema-first contracts in `src/schemas/tools` through `contractFor(name)`. The model reads the same text and parameter descriptions a human integrator would. `buildReason` (internal build-vs-buy rationale) is no longer shown to the model.
- Write actions are one tool each (`propose_time_off_request`) with a strict schema and no identity fields; preview and commit tools are never exposed to the integration agent, so there is no decision point about which write tool to call.
- The enterprise agent omits `commit_*` tools unless `allowWriteCommits` is true, and wraps every tool result with `wrapUntrusted`. The prompt says text inside that tag is data.
- `notion_read_page` takes an enum of the pages the caller may read, labelled. The model picks by label; it does not search.

## Just-in-time context, not pre-loading

- Workday and Notion content is loaded only when a tool is called, as data wrapped in `<untrusted_data>`. The integration agent and the enterprise agent both wrap. Nothing is pre-fetched into the prompt.
- `wrapUntrusted` caps a result at `MAX_TOOL_RESULT_CHARS` and ends a cut result with a note that says how to recover: narrow the query (dates, status, limit) instead of paging. This turns the cap into guidance rather than a silent loss.
- Read tools expose paging and filters in their contracts; the prompt tells the model to use the narrowest input that answers the question.

## Long-horizon controls

- Every agent run is bounded: `stepCountIs(MAX_AGENT_STEPS)` on the integration agent and `stepCountIs(MAX_ENTERPRISE_AGENT_STEPS)` on the enterprise agent. A self-service question needs two or three steps; the bound stops a loop from spending the whole budget on retries.
- The prompt forbids repeating a call with the same input and tells the model to stop on a permission error.
- Compaction and structured note-taking are not needed yet: each Slack request is a short, stateless run and the durable state (approval requests, ledger) lives in Postgres, not in the conversation. If multi-turn conversations are added, follow the article's order: maximize recall first, then prune tool results that have been used.
- `summarizeToolResult` (`src/ai/summarize.ts`) can redact and shorten a tool result. Nothing on the request path or the audit logger calls it. The audit log stores redacted inputs and a status, not a model summary.

## The up-front guide for coding agents

`AGENTS.md` is the equivalent of the article's CLAUDE.md example: loaded into every session, so it must be the minimal set that fully outlines expected behavior. It holds the invariants, the check command, and a "where to look" table that points at files to read just in time. Detail stays in `docs/` and in the code. When adding to `AGENTS.md`, ask whether the line is needed on every task; if not, it belongs in a doc the table points to.

## Checklist for changes

1. New tool: write the contract first (`src/schemas/tools`), with a description that says what it returns and who may call it, and parameter descriptions on every input. The agents pick it up through `contractFor`.
2. New rule in a prompt: is it a security invariant (keep it in the rules list) or a behavior preference (make it a one-line heuristic or an example)?
3. New example: does it show a behavior the existing three do not? If it only adds an edge case, fix the tool contract instead.
4. Larger results: raise the cap only with a reason; prefer a narrower tool or a filter parameter.
5. Longer runs: raise the step bound only together with a stop condition the prompt explains.
