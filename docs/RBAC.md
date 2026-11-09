# RBAC

A coarse, fail-closed authorization layer that runs **before** any Workday call. It does not replace Workday security: the user's own OAuth token is still checked by Workday, and Workday has the final say.

Code: `src/rbac/` (`roles.ts`, `permissions.ts`, `enforce.ts`, `permission-ids.ts`, `assignments.ts`, `user-enforce.ts`, `index.ts`). See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Roles (baseline, adjustable)
| Role | Scope |
|---|---|
| `worker_self` | Own profile, own time-off, own benefits, own pay statements (read). Request/cancel own time-off (preview+commit). |
| `manager` | Team roster and team time-off reads. Approve/deny team time-off (preview+commit). |
| `hr_partner` | Broader org reads (supervisory org, team/roster reads). No payroll write. |
| `payroll_viewer` | Pay group, pay result and payroll input reads (payroll-viewer-skill); payslips of workers in its own pay group(s); other pay data own only. No writes (enforced at startup). |
| `admin` | **Full read** access to worker data (tenant-wide, payslips included; own-pay tax / next-payment tools self-only), plus kill switch / config. Uses the admin's own sign-in, never a shared account. Writes only on the admin's own record (self), and always preview + explicit confirm. No Layer-3 write tools are granted. |

## Permissions matrix (tool → roles)
| Tool | Access | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|---|
| `get_my_worker_profile` | read | ✅ | — | — | — | ✅ |
| `get_my_time_off_balance` | read | ✅ | — | — | — | ✅ |
| `list_my_time_off_requests` | read | ✅ | — | — | — | ✅ |
| `preview_request_time_off` | write-preview | ✅ | — | — | — | — |
| `commit_request_time_off` | write-commit | ✅ | — | — | — | — |
| `preview_cancel_time_off` | write-preview | ✅ | — | — | — | — |
| `commit_cancel_time_off` | write-commit | ✅ | — | — | — | — |
| `list_my_team` | read | — | ✅ | ✅ | — | ✅ |
| `list_team_time_off_requests` | read | — | ✅ | ✅ | — | ✅ |
| `preview_approve_time_off` | write-preview | — | ✅ | — | — | — |
| `commit_approve_time_off` | write-commit | — | ✅ | — | — | — |
| `preview_deny_time_off` | write-preview | — | ✅ | — | — | — |
| `commit_deny_time_off` | write-commit | — | ✅ | — | — | — |
| `get_my_benefits_enrollments` | read | ✅ | — | — | — | ✅ |
| `list_my_pay_statements` | read | ✅ | — | — | ✅ | ✅ |
| `get_supervisory_org` | read | ✅ | ✅ | ✅ | — | ✅ |
| `list_agent_ready_tools` | read (catalog meta) | ✅ | ✅ | ✅ | — | ✅ |
| `get_agent_ready_tool` | read (catalog meta) | ✅ | ✅ | ✅ | — | ✅ |

The source of truth is `TOOL_PERMISSIONS` in `src/rbac/permissions.ts`. Preview/commit pairs must have identical roles. Payroll has no write tools at all.

## Native Agent-Ready tools (tenant-discovered)
Native tools are not registered by this server, so they live in their own map: `AGENT_READY_TOOL_PERMISSIONS` in `src/rbac/agent-ready.ts`, enforced by `assertAgentReadyCallAllowed(roles, tool, { contextInstanceId, callerWid, targetInScope })`. Scopes: **self** means `contextInstanceId` must be `"me"` or the caller's WID. **reports** means self plus direct/indirect reports. **org** means the caller's supervisory org scope. **all** is still bounded by Workday security. For a non-self target the caller must have checked `targetInScope === true`, otherwise access is denied (fail closed).

| Native tool | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|
| `find_org_chart_workers` | — | reports | org | — | all |
| `find_service_dates_for_worker` | self | reports | org | — | all |
| `find_staffing_agent_supervisory_organization_members` | — | reports | org | — | all |
| `find_staffing_supervisory_organization` | self (own org) | reports | org | — | all |
| `find_staffing_workers` | self | reports | org | — | all |
| `find_worker_personal_information` ⚠️ | self | — | org | — | all |
| `list_organizations` | — | reports | org | — | all |
| `list_staffing_jobs` | self | reports | org | — | all |
| `list_worker_addresses` ⚠️ | self | — | org | — | all |
| `list_worker_direct_reports` | — | reports | org | — | all |
| `list_worker_email_addresses` | self | reports | org | — | all |
| `list_worker_organizations` | self | reports | org | — | all |
| `list_worker_phone_numbers` | self | reports | org | — | all |
| recipe `resolve_manager_chain` | — | reports | org | — | all |
| recipe `list_indirect_reports` | — | reports | org | — | all |

⚠️ Sensitive (DOB/personal info, home address): never granted to `manager`. `payroll_viewer` gets no worker-data tools. Admin has full read and always runs under the admin's own token, never a shared account.

### self-service-skill (34 new native tools)
| Group | Tools | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|---|
| Time off reads | `find_absence_balances`, `find_worker_time_off_details`, `find_worker_eligible_absence_types`, `find_worker_valid_time_off_dates` | self | self | org | — | all |
| Inbox / learning / goals reads | `find_business_process_tasks`, `find_plan_assignments`, `get_learning_content`, `find_learning_transcript`, `find_continue_learning`, `list_my_goals`, `find_goal_status` | self | self | org | — | all |
| Payslips ⚠️ | `find_payslips`, `find_payslip_summary`, `find_payslip_details` | self | self | self | own + pay group | all (see payroll-viewer-skill) |
| Benefits | `find_latest_employee_enrollment_event`, `get_employee_enrollment_history`, `view_benefits_dependent` ⚠️ | self | self | — | — | all |
| Personal data reads | `find_worker_legal_name` ⚠️, `find_detailed_personal_information_change_event` | self | self | — | — | all |
| Writes (15, staged BP) | `create_*` / `update_*` / `edit_*` / `submit_*` (time off, personal info, home contact, goals) | self | self | — | — | self |

Writes are self-only for every role. `assertAgentReadyCallAllowed` refuses a write unless the target is self **and** the call comes from `src/safety/native-write-guard.ts` after a consumed preview token, `userConfirmed: true` and an `idempotencyKey`. For tools keyed by a payslip, event or entry WID, pass the owning worker as `contextInstanceId` (the adapter resolves ownership).

### manager-actions-skill (41 new native tools)
| Group | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|
| BP event/step reads (4) | own items (subject or awaiting approver = me) | team | org | — | all |
| Other reads (28: expenses, change-job lookups, history ⚠️, recruiting, performance, feedback received ⚠️, team learning, `list_staffing_business_process_types`) | — | team | org | — | all |
| `find_anytime_feedback_events` | self | team | org | — | all |
| Payroll input lookups (3; `…_workers` ⚠️) | — | team | org | pay group | all |
| approve / deny step | own awaiting steps | team + awaiting approver | org + awaiting approver | — | own awaiting steps |
| `initiate_change_job`, `initiate_performance_review_for_employee` | — | team | org | — | self |
| `create_anytime_feedback_events` | anyone (as giver) | team | org | — | anyone (as giver) |
| `request_payroll_input` ⚠️ (highest risk) | — | team + payroll domain | org + payroll domain | — (never writes) | self + payroll domain |

- **team** means the target is in a `TeamScope` from `verifyTeamScope()`: direct + indirect reports, recursing where `hasManagerRole` is true, depth ≤ 5, TTL 5 min, tied to the caller's WID, and minted only by that module. `targetInScope: true` alone is **not** accepted for managers. The shared time-off reads (`find_absence_balances`, `find_worker_time_off_details`) now also allow a manager on their team.
- Approve/deny always requires `awaitingApproverWid` = the caller, supplied by the calling code like payslip ownership. Reference lookups (types, templates, statuses, pay components) need no target. "My team" lists are scoped by Workday; org and pay-group scopes still need `targetInScope` for the requested filter.

### hr-partner-skill (21 new native tools)
| Group | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|
| Org chart (`find_org_chart_organizations`, `get_org_chart_children`, `get_org_chart_parent`) | — | own team orgs (manager OrgScope) | org proof | — | all |
| `list_organization_members`, status lookups, onboarding tasks, `list_worker_history_events` ⚠️ | — | — | org proof | — | all |
| `find_ethnicity`, `find_ethnicity_details` 🛑 | — | — | org proof | — | all |
| `request_worker_leave_of_absence` | self | — | org proof | — | self |
| Passport / visa / national / government ID create, update, submit (10) 🛑 | self | — | org proof | — | self |
| recipe `aggregate_diversity` (counts only, k ≥ 5) | — | — | org proof | — | all |

🛑 = special category (`specialCategory: true`). **org proof** = an `OrgScope` (root supervisory orgs + descendants, depth ≤ 5) for org targets, or a `WorkerOrgProof` (the worker's orgs intersect that scope) for worker targets. Both are minted only by `src/rbac/org-scope.ts`, bound to the caller's WID and to a basis (hr_partner / manager), with a TTL of 5 min. A bare `targetInScope: true` is refused for these tools. Older hr_partner grants still accept `targetInScope` (or a proof). Managers get no ID, passport, visa or ethnicity tools.

### payroll-viewer-skill (26 tools: 22 new, 4 shared; all reads)
| Group | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|
| Payslips: `find_payslips` ⚠️, `find_payslip_summary` ⚠️ (and `find_payslip_details` ⚠️, self-service-skill) | self | self | self | own + workers in own pay group(s) | all |
| Other own pay (7): `find_worker_next_payroll_payment_date`, `find_tax_form_box_details` ⚠️, `list_countries_for_worker_year_end_tax_documents`, `list_report_types_for_worker_year_end_tax_documents`, `list_companies_for_worker_year_end_tax_documents`, `list_countries_for_worker_pay_group`, `list_companies_for_worker` | self | self | self | self | self |
| Pay group tools (13): `find_pay_groups`, `find_pay_group_details`, run category / pay run group selection / off-cycle prompts, `payroll_payroll_results_for_pay_group_detail_and_period_prompt` ⚠️, calculation status prompts, the 4 retro lists | — | — | — | pay-group proof | all |
| `find_payroll_inputs` ⚠️, `payroll_input_types_prompt` | — | — | — | pay group | all |
| `list_request_payroll_input_workers` ⚠️, `list_request_payroll_input_pay_components` (shared, unchanged) | — | team | org | pay group | all |
| Writes | none: `request_payroll_input`, `create_payroll_inputs`, `edit_payroll_inputs` and retro launch are never granted through this skill | | | | |

- **Payslips** (user decision): every role reads its own; `worker_self`, `manager` and `hr_partner` are self-only. `payroll_viewer` may read another worker's payslips only when that worker is in a pay group the caller can see: preferably a `WorkerPayGroupProof` from `verifyWorkerInPayGroupScope(session, worker, listWorkerPayGroupIds)` (the worker's pay group must be one listed by `find_pay_groups` / `find_pay_group_details` in the same session, same caller), otherwise the existing pay-group membership check (`targetInScope: true`, supplied by caller code). Admin reads all payslips.
- ⚠️ **Caveat:** Workday's own native payslip tools are self-service server-side: even with these grants the tenant still returns only the caller's own payslips through `find_payslips` / `find_payslip_summary` / `find_payslip_details`, until a payroll-admin data source (e.g. a RaaS report or Payroll API) or a Custom Agent Action exists for this. The grants are the policy the external layer enforces once such a source is wired in.
- **self** for the other own-pay tools is enforced for every role, admin included: `contextInstanceId` must be `"me"` or the caller's WID. Any other worker id, and a missing one, is refused before the call; `targetInScope`, team or org proofs never widen it.
- **pay-group proof**: a `PayGroupSession` from `openPayGroupSession(callerWid, sessionId)` in `src/rbac/pay-group-scope.ts`. Only IDs returned by `find_pay_groups` / `find_pay_group_details` can be recorded on it (`recordListedPayGroups`), it is bound to the caller and the session, has a 15 min TTL, and only that module can mint it. A pay group or pay group detail ID (`payGroupId`, or `contextInstanceId`) is accepted for `payroll_viewer` only if it was listed earlier in the same session. Omitting the ID (a list call) is allowed, because Workday returns only the pay groups the caller may view. A bare `targetInScope: true` is refused. Admin is exempt (full read).
- **Pay results shaping** (`src/safety/pay-results.ts`): results for a pay group detail and period are returned as a summary (result count + count per status, period dates). Worker-level lines go only to `payroll_viewer` or `admin` when the request sets `explicitDetail: true`. Every other role gets the summary.

### admin-skill (92 tools: 21 new, 71 shared; 80 reads, 12 writes)
| Group | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|
| 59 shared reads (worker data, org chart, BP, recruiting, learning, feedback, time off, ethnicity, payslips) | unchanged | unchanged | unchanged | unchanged | all |
| `find_tax_form_box_details`, `find_worker_next_payroll_payment_date` (own pay, unchanged) | self | self | self | self | self |
| 21 new reads (preferred name, web addresses, talent job history, education, positions, job profiles, W-2s ⚠️, org chart navigable, worktags, compensation grades (reference), BP in-progress steps / comments / attachments ⚠️, home contact change event, internal job postings, feedback awaiting me, active genders, active marital statuses) | — | — | — | — | all |
| 12 writes (own personal info, contact, time off; self-service staged writes) | self | self | — | — | self |

- **Writes** stay self-only: target must be `"me"` or the admin's own WID, and only via `src/safety/native-write-guard.ts` (preview → explicit confirm → commit). Any other target, or no target, is refused.
- **Hard refusals** (`ADMIN_HARD_REFUSALS`): compensation, termination/rehire, hire/pre-hire/onboarding, org changes, security changes and any job/position change for another worker. No such write is in the skill; any catalogued write matching them is never granted to admin beyond `self` (e.g. `initiate_change_job` on another worker is refused).
- **Sensitive field gate** (`src/safety/sensitive-fields.ts`): national ID, bank and passport (and visa) fields are hidden in any response unless the request explicitly names one field category for one named worker and the response is about exactly that worker. The response then carries "⚠️ Note: access to this field is logged by Workday." and an `accessLog` record for the audit log.
- **Demographics** (`src/safety/diversity.ts`): per-person reads of `find_worker_personal_information`, ethnicity, gender or marital status for more than one worker are refused (`assertSingleWorkerDemographicRead`); use `computeDemographicAggregate` (recipe `aggregate_diversity` RBAC, counts only, groups under 5 suppressed).


## User permission assignments (lowest level)

Enterprise Layer-3 adds **per-user** grants and denies on top of role→tool maps. Atomic permission ids are `tool:<toolName>` for every Layer-3 registered tool and every mapped Agent-Ready / recipe tool (`src/rbac/permission-ids.ts`).

### `UserPermissionAssignment`
| Field | Meaning |
|---|---|
| `userId` | Session user id |
| `roles` | Baseline roles (still used) |
| `grants` | Permission ids explicitly allowed for this user |
| `denies` | Permission ids explicitly blocked |
| `updatedAt` / `updatedBy` | Audit metadata |

Store: `src/rbac/assignments.ts` (`AssignmentStore`, `InMemoryAssignmentStore`, optional JSON via `WORKDAY_RBAC_ASSIGNMENTS_PATH`). Dev seed: `WORKDAY_USER_GRANTS` / `WORKDAY_USER_DENIES` for `WORKDAY_USER_ID`.

### Resolution order (fail closed)
1. Permission id in `denies` → **DENY** (wins over roles and grants)
2. Permission id in `grants` → **ALLOW** at the permission layer
3. Else if any of the user's roles allows the tool via `TOOL_PERMISSIONS` / Agent-Ready maps → **ALLOW**
4. Else → **DENY**

Grants never skip team / org / pay-group proofs, awaiting-approver checks, payroll-domain checks, or preview→confirm write requirements. Workday security on the user's token remains authoritative.

Admin management (code-level, requires `admin` role): `listPermissions`, `getUserAssignment`, `setUserAssignment`, `grantPermission`, `denyPermission`, `clearGrant`, `clearDeny`.

Enforcement: `assertToolAllowedForUser` / `assertAgentReadyCallAllowedForUser` in `src/rbac/user-enforce.ts`, wired from `src/tools/framework.ts`.

## Mapping to Workday
| RBAC role | Workday security group (example) | ASOR agent skill "Available To" |
|---|---|---|
| `worker_self` | Employee as Self (user-based) | All employees |
| `manager` | Manager (role-based, supervisory org) | Managers |
| `hr_partner` | HR Partner (role-based) | HR Partners |
| `payroll_viewer` | Payroll Partner / custom view-only group | Payroll viewers |
| `admin` | Integration/Security Administrator | Platform admins |

- Keep the skill's **Available To** list aligned with these roles, so the agent never offers a tool it would deny.
- Stdio roles come from `WORKDAY_USER_ROLES` (default `worker_self`) for the life of the process, including a live tenant. Unknown roles fail startup. This server does not look up Workday security groups. Workday still enforces the caller's own token on live calls. A security-group lookup needs a sandbox-validated contract and is not implemented.

## Denial behavior
- `assertToolAllowed(userRoles, toolName)` throws `RbacDeniedError`. Tools return `{ "error": "PERMISSION_DENIED", "message": "Access denied: '<tool>' requires one of [...]; you have [...]. Ask your Workday security admin ..." }`.
- The check happens after the kill switch and **before** sign-in or any Workday request. Denials are audited as `result: "denied"` and never pinned to an idempotency key.
- A tool with no mapping is denied for everyone (fail closed). Startup (`assertRegistryInvariants`) and `pnpm run check:rbac` also fail.

## Customizing for your scale-up
1. Add or rename roles in `src/rbac/roles.ts` (`ROLES`, `ROLE_DESCRIPTIONS`).
2. Update `TOOL_PERMISSIONS` for every tool, keeping preview/commit pairs identical.
3. Map each role to a Workday security group and to the skill's Available To list.
4. Add a security-group lookup only after a sandbox-validated contract exists. This repository does not include one. `resolveRolesFromEnv` reads `WORKDAY_USER_ROLES`.
5. Run `pnpm run typecheck && pnpm run check:rbac`.
