# RBAC

A coarse, fail-closed authorization layer that runs **before** any Workday call. It does not replace Workday security: the user's own OAuth token is still checked by Workday, and Workday has the final say.

Code: `src/rbac/` (`roles.ts`, `permissions.ts`, `enforce.ts`, `index.ts`). See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Roles (baseline, adjustable)
| Role | Scope |
|---|---|
| `worker_self` | Own profile, own time-off, own benefits, own pay statements (read). Request/cancel own time-off (preview+commit). |
| `manager` | Team roster and team time-off reads. Approve/deny team time-off (preview+commit). |
| `hr_partner` | Broader org reads (supervisory org, team/roster reads). No payroll write. |
| `payroll_viewer` | Pay statement reads only. No writes (enforced at startup). |
| `admin` | Kill switch / config introspection only. No user-data tools are granted. Never a shared account. |

## Permissions matrix (tool → roles)
| Tool | Access | worker_self | manager | hr_partner | payroll_viewer | admin |
|---|---|---|---|---|---|---|
| `get_my_worker_profile` | read | ✅ | — | — | — | — |
| `get_my_time_off_balance` | read | ✅ | — | — | — | — |
| `list_my_time_off_requests` | read | ✅ | — | — | — | — |
| `preview_request_time_off` | write-preview | ✅ | — | — | — | — |
| `commit_request_time_off` | write-commit | ✅ | — | — | — | — |
| `preview_cancel_time_off` | write-preview | ✅ | — | — | — | — |
| `commit_cancel_time_off` | write-commit | ✅ | — | — | — | — |
| `list_my_team` | read | — | ✅ | ✅ | — | — |
| `list_team_time_off_requests` | read | — | ✅ | ✅ | — | — |
| `preview_approve_time_off` | write-preview | — | ✅ | — | — | — |
| `commit_approve_time_off` | write-commit | — | ✅ | — | — | — |
| `preview_deny_time_off` | write-preview | — | ✅ | — | — | — |
| `commit_deny_time_off` | write-commit | — | ✅ | — | — | — |
| `get_my_benefits_enrollments` | read | ✅ | — | — | — | — |
| `list_my_pay_statements` | read | ✅ | — | — | ✅ | — |
| `get_supervisory_org` | read | ✅ | ✅ | ✅ | — | — |
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

⚠️ Sensitive (DOB/personal info, home address): never granted to `manager`. `payroll_viewer` gets no worker-data tools. The admin grant here covers native reads only. It still runs under the admin's own token, never a shared account.

## Mapping to Workday
| RBAC role | Workday security group (example) | ASOR agent skill "Available To" |
|---|---|---|
| `worker_self` | Employee as Self (user-based) | All employees |
| `manager` | Manager (role-based, supervisory org) | Managers |
| `hr_partner` | HR Partner (role-based) | HR Partners |
| `payroll_viewer` | Payroll Partner / custom view-only group | Payroll viewers |
| `admin` | Integration/Security Administrator | Platform admins |

- Keep the skill's **Available To** list aligned with these roles, so the agent never offers a tool it would deny.
- Production: resolve roles from the user's Workday security group memberships (for example a RaaS report or Workers API call as the user, cached per session). Fixtures/dev: `WORKDAY_USER_ROLES=worker_self,manager` (default `worker_self`). Unknown roles fail startup.

## Denial behavior
- `assertToolAllowed(userRoles, toolName)` throws `RbacDeniedError`. Tools return `{ "error": "PERMISSION_DENIED", "message": "Access denied: '<tool>' requires one of [...]; you have [...]. Ask your Workday security admin ..." }`.
- The check happens after the kill switch and **before** sign-in or any Workday request. Denials are audited as `result: "denied"` and never pinned to an idempotency key.
- A tool with no mapping is denied for everyone (fail closed). Startup (`assertRegistryInvariants`) and `npm run check:rbac` also fail.

## Customizing for your scale-up
1. Add or rename roles in `src/rbac/roles.ts` (`ROLES`, `ROLE_DESCRIPTIONS`).
2. Update `TOOL_PERMISSIONS` for every tool, keeping preview/commit pairs identical.
3. Map each role to a Workday security group and to the skill's Available To list.
4. Swap `resolveRolesFromEnv` for a security-group lookup in production.
5. Run `npm run typecheck && npm run check:rbac`.
