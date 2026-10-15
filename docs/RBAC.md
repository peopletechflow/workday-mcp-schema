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

The source of truth is `TOOL_PERMISSIONS` in `src/rbac/permissions.ts`. Preview/commit pairs must have identical roles. Payroll has no write tools at all.

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
