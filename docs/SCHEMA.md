# Schema contract

`src/schemas/` is the single source of truth. Tool code imports contracts from `src/schemas/tools/`; it never defines its own I/O shapes. Every object is a Zod schema with an inferred TS type exported next to it.

## API objects

| File | Objects | PII notes |
| --- | --- | --- |
| `common.ts` | `IsoDate`, `IsoDateTime`, `WorkdayId` (typed: WID, Employee_ID, Contingent_Worker_ID, Position_ID, Organization_Reference_ID, Supervisory_Organization_ID, Cost_Center_Reference_ID, Location_ID, Job_Profile_ID, Benefit_Plan_ID, Pay_Group_ID, Pay_Statement_ID, Absence_Table_ID, Time_Off_Type_ID, Time_Off_Entry_ID, Business_Process_Event_ID), per-type ID schemas, `Ref`, `IdempotencyKey`, `PreviewToken`, `UserConfirmed`, paging (max 100) | `Ref.descriptor` is PII when it names a person |
| `worker.ts` | `WorkerSummary`, `TeamMember` | preferred name, hire/termination date, manager name. **No** SSN, DOB, bank, home address, personal contact, comp |
| `organization.ts` | `SupervisoryOrg`, `CostCenterRef` | manager name |
| `absence.ts` | `TimeOffType`, `TimeOffBalance`, `TimeOffRequest`, `TimeOffRequestInput`, status + approval enums | free-text comment |
| `time.ts` | `TimeEntrySummary`, `WorkScheduleSummary` (no tool yet) | worker name; no punch/geo data |
| `benefits.ts` | `BenefitEnrollment` (read-shaped) | coverage level is sensitive; no dependents/beneficiaries/costs |
| `payroll.ts` | `PayStatementSummary`, `PayDate` — **read only** | gross/net pay; no bank/tax |
| `errors.ts` | `WorkdayFault`, `McpErrorCode`, `McpToolError` | never carries tokens |

## Tool I/O

Contracts: `src/schemas/tools/{self-service,manager,benefits,payroll,org}.ts`, built with `defineTool({ name, title, description, toolClass, input, output })`.

- Reads return `{ <data> }` and lists add `page: { total, limit, offset }`.
- `preview_*` → `{ previewToken, expiresInSeconds, summary, willSubmit, nextStep }`. No Workday write; checks current state; token bound to user + commit tool, 15 min TTL, single use.
- `commit_*` input is always `{ previewToken, idempotencyKey, userConfirmed: true }` → `{ replayed, submitted, reusedExisting, summary, result }`.
- Errors: `isError: true` with an `McpToolError` JSON body (`SIGN_IN_REQUIRED` includes `authorizeUrl`).
- Outputs are validated against the output schema before return (`structuredContent`).

| Tool | Input | Output |
| --- | --- | --- |
| get_my_worker_profile | – | `worker: WorkerSummary` |
| get_my_time_off_balance | `asOf?` | text JSON of `TimeOffBalance[]` (legacy shape; contract declares `balances`) |
| list_my_time_off_requests | `from?, to?, status?[], limit, offset` | `requests: TimeOffRequest[], page` |
| preview/commit_request_time_off | dates, unit, quantity, timeOffType, comment? / commit envelope | preview / commit envelope |
| preview/commit_cancel_time_off | `requestId, reason?` / commit envelope | willSubmit `{requestId, dates, currentStatus, reason}` |
| list_my_team | `includeInactive, limit, offset` | `members: TeamMember[], page` |
| list_team_time_off_requests | `status[] (default open), from?, to?, limit, offset` | `requests, page` |
| preview/commit_approve_time_off | `requestId, comment?` | willSubmit `{action, request, comment}` |
| preview/commit_deny_time_off | `requestId, comment` (required) | same |
| get_my_benefits_enrollments | `asOf?` | `enrollments: BenefitEnrollment[]` |
| list_my_pay_statements | `from?, to?, limit, offset` | `statements: PayStatementSummary[], page` |
| get_supervisory_org | `orgId` | `org: SupervisoryOrg` |

Surface, PII fields and build reason per tool: `src/tools/registry.ts`.

## Never

- No generic `call_workday` / raw REST or SOAP passthrough (registry check rejects it).
- No payroll write schemas or tools (registry check rejects them).
- No shared/service-account auth: every handler gets the caller's token via `requireUserAccessToken`; missing token → `SIGN_IN_REQUIRED`.
- No write without preview + `userConfirmed: true` + `idempotencyKey`; commits pre-check Workday state and submit through the business process.
- No SSN, DOB, bank, home address in any schema; no tokens or unredacted PII in logs.
- Sandbox/implementation tenants only during development.

## Agent-Ready catalog (Layer 1, meta only)

`src/agent-ready/` holds a seed/sync catalog of **native** Workday Agent-Ready MCP tools. Meta tool contracts live in `src/schemas/tools/agent-ready.ts`:

| Tool | Input | Output |
| --- | --- | --- |
| `list_agent_ready_tools` | `search?, kind?, productArea?, operationType?, limit, offset` | `disclaimer, completenessNote, generatedAt, totalMatching, tools[], productAreas[]` |
| `get_agent_ready_tool` | `name?` and/or `wid?` | `disclaimer, found, tool?` |

Each catalog row is marked `nativeWorkdayTool: true`. Rows can also carry `category`, `readOnly`, `params` (only the parameters observed during discovery), `inputSchemaStatus` (`partial` = the rest pass through, `unknown` = discover the live schema first), `securityDomains` and `notes`. `wid` can be `null` (explicitly unknown). Tenant-discovered rows (`source: "tenant-discovered 2026-10-20 bzyvydgxsb_extdev"`) live in `src/agent-ready/catalog.tenant.ts`. Their output schemas are deliberately not modeled here. Write previews for manager actions must include the worker, the action, the effective date (provided by the user, never defaulted), the changed fields and the approvers (`WritePreviewDetails` / `NativeWritePreview` in `src/safety/native-write-guard.ts`). `specialCategory` marks GDPR Art. 9 / highly sensitive PII (ethnicity; passport, visa, national and government IDs). Diversity output (`DiversityAggregate`) holds only bucket counts (k ≥ 5) and never worker IDs. Pay results (`ShapedPayResults` in `src/safety/pay-results.ts`) are a summary (count + statuses) unless a payroll viewer or admin explicitly asks for worker-level lines. Rows also carry `sensitive`, `skills` and, for writes, `businessProcess: { flow, step: "open" | "stage" | "submit" }` (see `NATIVE_WRITE_FLOWS` in `src/safety/native-write-guard.ts`). `find_worker_personal_information` (DOB), `list_worker_addresses` (home address), payslips and `view_benefits_dependent` (dependent DOB) are native tools, and the "no DOB / home address in any schema" rule still applies to this server's own Layer-3 schemas. These tools read the local catalog only; they do not call Workday. Refresh with `npm run sync:agent-ready -- --csv <explorer.csv>`. See `src/agent-ready/sync.md`.
