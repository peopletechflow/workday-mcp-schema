# Skill: hr-partner-skill

> **Condensed mirror of the Developer Agent skill text.** Reconstructed from the discovery notes (`/workspace/handoff/hr-partner-tools.txt`). Extend app `peopletechHrBaseline_rjqhll`, tenant `bzyvydgxsb_extdev` (wd119), discovered 2026-10-20. The tenant is the source of truth.

## Purpose
HR partner operations within the HR partner's supervisory orgs: org chart and membership, worker history, leave of absence, identity documents (passport, visa, national and government IDs), onboarding tasks and aggregate diversity.

## Tools (49; 28 already catalogued, 21 new; WIDs not exposed)
The notes do not say which 28 existing tools the skill uses, so they are not tagged with this skill in the catalog.

- **New reads (10):**
  - `find_org_chart_organizations` (search orgs by name), `get_org_chart_children`, `get_org_chart_parent`.
  - `list_organization_members` (any org type: cost centers, supervisory orgs, …).
  - `list_leave_event_statuses`, `list_time_off_entry_statuses`.
  - `list_onboarding_business_process_tasks` (signed-in user or new hire).
  - `list_worker_history_events` (BP history, BP type filters; distinct from `find_worker_history_events`).
  - `find_ethnicity`, `find_ethnicity_details` (lookup values).
- **New writes (11):**
  - `request_worker_leave_of_absence`: worker, leave type from `find_worker_eligible_absence_types`, start, end, reason.
  - `create_passport_ids`, `update_passport_ids`, `create_visa_ids`, `update_visa_ids`, then `submit_passport_and_visa_changes`.
  - `create_national_ids`, `update_national_ids`, `create_government_ids`, `update_government_ids`, then `submit_government_identifier_changes`.

## Security rules
- **Scope gate before every action:** verify that the target worker or org is within the HR partner's supervisory orgs (`list_worker_organizations` / `find_staffing_supervisory_organization`). On 403, do not retry.
- **Highly sensitive:**
  - All passport, visa, national and government ID tools are highly sensitive PII.
  - Ethnicity (`find_ethnicity_details`, and ethnicity read through `find_worker_personal_information`) is GDPR Art. 9 special-category data.
  - `list_worker_history_events` is sensitive.
- **Diversity is aggregate-only:** never show per-person ethnicity. Report counts per bucket with a minimum group size of 5 (smaller groups suppressed), and only to HR partners and admins.

## Steps per capability
- **Org chart:** `find_org_chart_organizations` → `get_org_chart_children` / `get_org_chart_parent` → `list_organization_members`.
- **Worker history:** scope gate → `list_worker_history_events` (filter by BP type).
- **Leave of absence:**
  1. Scope gate.
  2. `find_worker_eligible_absence_types` (leave type).
  3. Ask for the start date (required, never defaulted), end date and reason.
  4. Preview, then confirm.
  5. `request_worker_leave_of_absence`.
  6. Track it with `list_leave_event_statuses`.
- **Passport / visa:**
  1. Scope gate.
  2. Within an **open change event**: `create_` / `update_passport_ids`, `create_` / `update_visa_ids`.
  3. Preview, then confirm.
  4. `submit_passport_and_visa_changes`.
- **National / government IDs:**
  1. Scope gate.
  2. Within an **open change event**: `create_` / `update_national_ids`, `create_` / `update_government_ids`.
  3. Preview, then confirm.
  4. `submit_government_identifier_changes`.
- **Onboarding:** `list_onboarding_business_process_tasks` for the user or a new hire.
- **Diversity:** iterate the org's members and read their personal information client-side, then return aggregates only (k ≥ 5).
- **Probation:** there is no API field. Derive an estimate from the hire date and label it clearly as an **estimate**.

## Errors
| Response | Action |
| --- | --- |
| 403 | Outside scope or missing domain. Do not retry. Explain and stop. |
| 404 | Check the identifiers. |
| 400 | Explain the constraint (e.g. start date missing) and ask for a corrected value. |
| Empty results | Report that nothing was found. |

## Known gap
The passport/visa and government-identifier writes run "within an open change event", but **no tool to open such an event** is in the skill's tool list. In this repo the guard (`passport_visa_change` / `government_id_change` flows) requires the existing event WID to be supplied from outside, and refuses without one.

## Not available in this tenant
| Capability | Status |
| --- | --- |
| Aggregate headcount / attrition reports | Not available (diversity is assembled client-side, aggregate-only) |
| Document expiry queries (passport/visa expiry) | Not available |
| Contract end dates | Not available |
| Create / rename supervisory orgs | Not available |
| Termination | Not available |
| Pre-hire / hire | Not available |
| Probation end date | No field; derived estimate from hire date only |
| Opening a passport/visa or government-ID change event | No tool (gap above) |

## Mirror notes (workday-mcp-schema)
- Catalog: `HR_PARTNER_SKILL_TOOLS` (`src/agent-ready/catalog.tenant.ts`); special-category tools carry `specialCategory: true`.
- Org-scope gate: `src/rbac/org-scope.ts`. `verifyOrgScope` covers root orgs plus descendants (depth 5). `verifyWorkerInOrgScope` issues a per-worker proof, and `filterToOrgScope` filters search results. Every hr-partner-skill tool needs one of these proofs; a bare `targetInScope` is refused.
- Diversity: `src/safety/diversity.ts` (`computeDiversityAggregate`, recipe `aggregate_diversity`, hr_partner/admin only).
- Writes: `src/safety/native-write-guard.ts` flows `leave_of_absence`, `passport_visa_change`, `government_id_change`.
