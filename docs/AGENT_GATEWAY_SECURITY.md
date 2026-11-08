# Agent Gateway security design (src/agent-gateway)

This repository ships the registry core and its checks only. The Slack runtime is not wired to it yet; when it is, it must define its own ceilings (`Ceiling[]`) the same way the focused projects do (`performance-review-cycle-helper/src/agent-capabilities.ts`).

Workday's Agent-Ready tools are for agents only. Their names and schemas change without notice, and prompts must not bind to tool names. This server therefore never lets the model call an arbitrary Workday tool. Workday security groups (ASOR) limit what the agent system user can reach. They do not stop an agent with broad grants from reaching into another person's data, so this code adds its own limits on top.

## Layers, from outermost to innermost
1. **Capability ceilings in code** (per project, `Ceiling[]` passed to `AgentToolRegistry`). Each capability, such as `goals.self.read`, states its access (read or write), the project role permission it needs, and its consent scope. It also says whether it is enabled at all. One MCP tool is generated per enabled ceiling (`workday_goals_self_read`, or a `_preview`/`_commit` pair for a write). These tools run through the normal role, deny and consent checks. There is no tool that calls any tool.
2. **Operator policy** (`AGENT_TOOL_POLICY_PATH`, version 2). The policy binds each live Workday tool, by name and contract fingerprint, to exactly one ceiling and declares where person fields go. It can only narrow access: a capability missing from the code, or disabled there, is refused. Tool names live only here, in security configuration reconciled against live discovery, and never in prompts or skills.
3. **Fail-closed schema analysis.** Schemas are walked recursively through `properties`, `items`, `anyOf/oneOf/allOf` and local `$ref` aliases. The schema is refused for any of these:
   - external, recursive or unresolved refs, or tuples;
   - `not`, `if`, `dependentSchemas`, `unevaluatedProperties` or `patternProperties`;
   - open `additionalProperties`, or objects without declared properties;
   - any person field inside an array or union.
   
   Every person field at any depth must be bound to the caller (`caller`, or `me`/`true` for self selectors). Otherwise the tool is unavailable.
4. **No record-id inputs, no free text.**
   - Workday does not document which output fields are records the signed-in worker owns. A self read can return a manager's or colleague's id (for example `manager.id`), so ownership cannot be inferred from results. No ownership is assumed, and the operator policy cannot declare it either.
   - A tool whose schema takes an id-like field is unavailable. Fields count as id-like by name (`*Id`, `*Wid`, `*Ref`, `*Reference`, `*Key`, `*Descriptor`, and so on) for any scalar type, including numbers. Free-form strings make a tool unavailable too, because they could carry another person's id.
   - Model-supplied values are limited to enums, consts, dates and date-times (the format is checked by this code, not left to Ajv), and non-id numbers or booleans. Unknown fields, nested person fields and unexpected arrays are rejected at any depth. The server then sets the bound fields and validates against the live schema.
   - By-id capabilities stay unavailable until a real, tenant-verified contract says which output path is the caller's own record for which capability. That would be a code change to the ceilings, with tests, not an operator setting.
5. **Writes are off by default.** Write ceilings ship `enabled: false` until a scoped adapter is validated against a tenant. A read capability needs the live tool annotated `readOnlyHint: true` and not `destructiveHint: true`; missing or empty annotations make it unavailable. A destructive tool is never mapped to a write without `allowDestructive` on that exact ceiling. When writes are enabled they keep the existing safety steps:
   - an exact preview, a fingerprint and explicit confirmation;
   - a fingerprint re-check right before commit, so contract drift sends nothing;
   - commit-once with idempotency keys and durable unknown outcomes.
6. **Defence in depth.** A normalized denylist of known manager, HR and payroll tools, plus a name pattern for business-process decisions (approve, deny, send back, advance, rescind, cancel, reassign and so on) and HR changes (initiate change job, termination, hire, compensation, payroll). These are backups. The capability ceilings and annotations are the real gates.
7. **Policy file hygiene.** Duplicate tool names (compared case- and punctuation-insensitively) are rejected when the policy loads.

## Identity
- Exactly one policy entry may use `identity.self`. Its only inputs must be self selectors (`me`/`true`), it must carry `attestedBy`/`attestedAt`, and its `workerIdPath` must select exactly one record (`data[].id` means "the array must have exactly one element"). Numeric indexes such as `data.0.id` are rejected. Search results are never used.
- **Tenant verification:** a tenant administrator calls the tool as two different test workers and confirms each sees only their own single record. They then record their name and the date in the policy.
- After every token refresh the identity is read again. A different worker signs the session out with no fallback.

## Session file
`ASU_SESSION_FILE` is written to a random temp file in the same directory, opened with `wx` and mode 600, fsynced, then renamed atomically; the temp file is removed on failure. Symlinks, non-files, files owned by another user and group- or world-readable files are refused when reading and writing.

## What is not proven
Nothing has been run against a live tenant. Refresh uses the standard OAuth grant, because Workday does not document it. Writes are disabled. Capabilities with no verified tool simply show as unavailable.
