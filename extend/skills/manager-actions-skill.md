# Skill: manager-actions-skill

> **Condensed mirror of the Developer Agent skill text.** Reconstructed from the discovery notes (`/workspace/handoff/manager-actions-tools.txt`). Extend app `peopletechHrBaseline_rjqhll`, tenant `bzyvydgxsb_extdev` (wd119), discovered 2026-10-20. The tenant is the source of truth.

## Purpose
Helps a manager act on their team: business-process inbox and approvals, change job, performance reviews, anytime feedback, team learning, expenses, recruiting lookups and payroll input requests.

## Tools (52; WIDs not exposed)
- **11 shared** (already catalogued): `find_absence_balances`, `find_business_process_tasks`, `find_service_dates_for_worker`, `find_staffing_agent_supervisory_organization_members`, `find_staffing_supervisory_organization`, `find_staffing_workers`, `find_worker_time_off_details`, `list_organizations`, `list_staffing_jobs`, `list_worker_direct_reports`, `list_worker_organizations`.
- **35 new reads:**
  - **Business process:** `find_business_process_event`, `find_business_process_event_step`, `find_completed_steps_for_business_process_event`, `find_remaining_steps_for_business_process_event` (approver chain), `list_staffing_business_process_types`.
  - **Expenses:** `find_expense_reports`, `find_expense_lines`.
  - **Change job lookups:** `find_workers_to_initiate_change_job`, `find_change_job_templates`, `find_job_profiles_for_change_job`, `find_locations_for_change_job`, `find_supervisory_organizations_for_change_job`, `find_reasons_for_change_job`, `find_employee_types_for_change_job`.
  - **Worker history:** `find_worker_history_events`.
  - **Recruiting:** `list_job_requisition_supervisory_organizations`, `list_job_requisition_statuses`, `list_job_requisition_types`, `find_job_requisitions`, `find_in_progress_create_job_requisition_events`, `find_my_candidates`, `list_my_candidate_candidate_stages`, `list_my_candidate_job_profiles`, `list_my_candidate_candidate_types`, `list_my_candidate_job_families`.
  - **Performance:** `find_performance_review`, `find_worker_from_my_team_to_filter_performance_review`, `list_workers_for_initiate_performance_review`, `find_worker_performance_review_template`.
  - **Feedback:** `find_anytime_feedback_events`, `find_worker_anytime_feedback_received`.
  - **Learning:** `list_my_teams_learning_records`.
  - **Payroll input lookups:** `list_request_payroll_input_workers`, `list_request_payroll_input_pay_components`, `list_request_payroll_input_event_input_types_for_pay_component`.
- **6 writes:** `approve_business_process_event_step`, `deny_business_process_event_step`, `initiate_change_job`, `initiate_performance_review_for_employee`, `create_anytime_feedback_events`, `request_payroll_input`.

## Security rules
- **Team verification before any action on a worker.** Resolve the manager with `find_staffing_workers` (`contextInstanceId: me`). The team is `list_worker_direct_reports`, recursing into reports where `hasManagerRole` is true (cap 5). Refuse workers who are not in the team.
- Approve or deny only steps that are awaiting the signed-in user.
- `request_payroll_input` is admin / payroll-domain level. Without the payroll domain it returns 403, and you must not retry.
- Never guess WIDs. Resolve them with the lookup tools.

## Steps per capability
- **Inbox / approvals:** `find_business_process_tasks` → `find_business_process_event` / `find_business_process_event_step` → `find_remaining_steps_for_business_process_event` (approvers) → preview → `approve_…` / `deny_…` (step WID; deny comment is required, max 256 characters).
- **Change job:** verify the worker is in the team (`find_workers_to_initiate_change_job`). Resolve the template, job profile, location, supervisory org, reason and employee type with the `find_*_for_change_job` lookups. Ask for the effective date. Preview, then `initiate_change_job` (worker WID). It returns a job change ID and routes for approval.
- **Performance review:** `list_workers_for_initiate_performance_review` / `find_worker_from_my_team_to_filter_performance_review` → `find_worker_performance_review_template` (`promptContext` = review type id) → preview → `initiate_performance_review_for_employee` (`reviewAboutWorker`, `reviewTemplate`, `startDate`, `endDate`). Read existing reviews with `find_performance_review` (worker, date range).
- **Anytime feedback:** preview, then `create_anytime_feedback_events` (target worker, message, optional badge, competencies/goals, notify-manager flag). Read with `find_anytime_feedback_events` and `find_worker_anytime_feedback_received` (worker, `fromDate`, `toDate`).
- **Expenses:** `find_expense_reports` (worker, status, date range) → `find_expense_lines`.
- **Team data:** `list_worker_direct_reports` (`directReportView` includes `nextAnniversary` and `timeInPosition`), `find_worker_history_events`, `list_my_teams_learning_records`, plus time off and service dates.
- **Recruiting (read-only):** requisition lookups, `find_job_requisitions` (`supervisoryOrganization`, `status`), `find_my_candidates` (candidate ID) and candidate lookups.
- **Payroll input:** `list_request_payroll_input_workers` (eligibility, next pay period start) → `list_request_payroll_input_pay_components` (`effectiveDate`) → `list_request_payroll_input_event_input_types_for_pay_component` (`payComponent`) → preview → `request_payroll_input`. Its fields are `payrollInput.worker`, `.payComponent`, `.startDate` (YYYY-MM-DD), `.ongoing`, `.endDate` (required when `ongoing=false`), `.inputDetails[].type` (WID), `.inputDetails[].value` (number), and `businessProcessParameters.action` (WID).

## Write preview rules
Every write shows a preview before an explicit yes/no. The preview contains:
- the worker's name;
- the action type;
- the effective date (**always ask, never default**);
- the changed fields;
- the approvers, from `find_remaining_steps_for_business_process_event`, or a note that the tenant's business process configuration decides them.

## Errors
| Response | Action |
| --- | --- |
| 403 | Missing domain or visibility (e.g. payroll domain). Do not retry. Explain and stop. |
| 404 | Check the identifiers. |
| 400 | Explain the constraint (e.g. deny comment > 256 characters, endDate missing) and ask for a corrected value. |
| 200 with empty results | Report that nothing was found. |

## Limitations in this tenant's tool set
| Not available | Note |
| --- | --- |
| Compensation / salary / grade change | No API exposed |
| Termination | No API exposed |
| PATCH field staging after `initiate_change_job` | Initiate only; the change routes for approval as submitted |
| Create job requisition | Requisitions are read-only (lookups, in-progress events) |
| Move candidates between stages | Candidates are read-only |
| Check-ins | Only anytime feedback is available |

## Mirror notes (workday-mcp-schema)
- Catalog: `MANAGER_ACTIONS_SKILL_TOOLS` in `src/agent-ready/catalog.tenant.ts`. RBAC: `src/rbac/agent-ready.ts`. Team proof: `src/rbac/team-scope.ts` (`verifyTeamScope`, reusing the `list_indirect_reports` recipe). Writes: `src/safety/native-write-guard.ts`, flows `approve_step`, `deny_step`, `change_job`, `performance_review`, `anytime_feedback`, `payroll_input`.
- Business-process ownership (awaiting approver), payroll-domain capability and org / pay-group scope are supplied by the calling code. The external layer refuses when any of them is missing.
