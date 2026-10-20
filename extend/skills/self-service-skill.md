# Self-Service Skill

This skill gives the signed-in worker access to their own HR data and allows them to make
approved self-service changes in Workday. **All operations are scoped to the authenticated
worker only (`me`).** This skill never retrieves or modifies data for any other person.
Every write action shows a preview and requires explicit confirmation before submitting.

## Security Rules (enforce on every request)

- **Scope is always `me`.** If the user names another worker, politely decline and clarify that this skill only operates on the signed-in worker's own record.
- **No retry on 403.** Surface: "You don't have permission to view/change [item]. Please contact HR or your system administrator." Do not retry.
- **Confirm before every write.** Present a full preview and ask for explicit yes/no. On no, discard and ask what to do instead.

## Read Capabilities

### Time Off Balances and Accruals
1. Resolve the worker WID with `find_staffing_workers` (`contextInstanceId: me`).
2. `find_absence_balances` with that WID (optional `effective` YYYY-MM-DD).
3. Present plan name, remaining quantity, unit, category.

### Time Off Requests (History)
1. Resolve worker WID.
2. `find_worker_time_off_details` (optional `from`, `to`, `timeOffType` WID, `status` WID).
3. `find_worker_eligible_absence_types` for requestable types.
4. Present date range, type, quantity, unit, status.

### Payslips
1. `find_payslips` (optional `startDate`, `endDate`, `numberOfPayslips`, `mostRecent`).
2. `find_payslip_summary` with payslip WID.
3. `find_payslip_details` with payslip WID for earnings, taxes, deductions, employer-paid benefits.
4. Present payment date, period, gross, net, YTD.

### Benefits Elections
1. `find_latest_employee_enrollment_event` for current enrollment.
2. `get_employee_enrollment_history` for history.
3. `view_benefits_dependent` for dependents.
4. Present plan, election status, effective dates.

### Inbox Tasks
1. `find_business_process_tasks` (defaults to last 30 days; `startDate`/`endDate`; task WID as `contextInstanceId`).
2. Present task name, business process, status, due date, awaiting action.

### Learning Assignments
1. `find_plan_assignments`; 2. `get_learning_content`; 3. `find_learning_transcript` (record WID); 4. `find_continue_learning` (record WID).
5. Present title, type, status, due date.

### Goals
1. `list_my_goals` (filter `status` WID resolved via `find_goal_status`, never a label).
2. Present name, status, percent complete, due date, weight, category.

### Personal Information
`find_worker_personal_information` (me), `find_worker_legal_name` (me), `find_staffing_workers` (me).

### Contact Details
`list_worker_email_addresses`, `list_worker_phone_numbers`, `list_worker_addresses` (me). Present value, type, primary, public flags.

## Write Capabilities (Preview -> Confirm -> Submit)
Rule: collect inputs, show preview, ask "Shall I submit this? Please confirm with yes or no.", call the mutating tool only after an explicit yes.

### Request Time Off
1. `find_worker_eligible_absence_types`; 2. `find_worker_valid_time_off_dates`;
3. Preview type, dates, quantity, current balance (`find_absence_balances`), projected balance;
4. On yes: `create_worker_time_off_request` (worker WID, type WID, dates); 5. Present status.

### Cancel Time Off
1. `find_worker_time_off_details`; 2. confirm entry; 3. preview; 4. on yes `update_worker_time_off_entry` with entry WID and `delete: true`; 5. present status.

### Update Personal Information
1. Show current via `find_worker_personal_information`; 2. collect change; 3. preview current -> proposed;
4. On yes: `create_personal_information_change_event` -> event WID; `find_detailed_personal_information_change_event` -> record WID; stage via field update tool (e.g. `update_personal_information_marital_status` — NOTE: not in this skill's tool list, add it in the Developer Agent); final confirm; `submit_personal_information_changes`.

### Update Contact Details
1. Read current; 2. collect change; 3. preview field, current, new (or NEW);
4. On yes: `create_worker_home_contact_change` (me) -> event WID; add/update via `create_/update_email_address_for_home_contact_change`, `create_/update_phone_number_for_home_contact_change`, `create_address_for_home_contact_change` / `update_address_on_home_contact_change`; final confirm; `submit_home_contact_change`.

### Update Goal Progress
1. `list_my_goals`; 2. disambiguate; 3. collect new value; 4. preview;
5. On yes: `create_worker_goal_events` -> event WID; `edit_worker_goals` (event WID, goal WID); final confirm; `submit_worker_goal_events`.

## Error Handling
- 403: do not retry; explain and stop.
- 404: confirm identifiers, retry once if appropriate.
- 400: explain the constraint, ask for a corrected value.
- Cancelled write: discard any open change events.
- Empty results: suggest broadening filters before concluding none exist.

---

## Mirror notes (workday-mcp-schema)

Copied verbatim from the tenant skill (Extend app `peopletechHrBaseline_rjqhll`, tenant `bzyvydgxsb_extdev`, discovered 2026-10-20). The tenant is the source of truth.

- **Known gap:** "Update Personal Information" stages changes through `update_personal_information_marital_status`, but that tool is **not in the skill's tool list**. It is not catalogued here, and `src/safety/native-write-guard.ts` rejects it as a stage step (`KNOWN_TOOL_GAPS` in `src/agent-ready/catalog.tenant.ts`). For now, the `personal_information_change` flow can only open and submit. Add the tool in the Developer Agent, then catalogue it.
- Tools: 39 in total. 34 are new in `catalog.tenant.ts` (19 reads, 15 writes); 5 are shared with `worker-data-skill`.
- Writes in this repo go through preview → explicit confirm → open / stage / submit (`previewNativeWrite` / `commitNativeWrite`). The target is always self, for every role.
- No discard tool for open events was discovered. If a step fails after open, the guard returns `discardRequired: true`.
