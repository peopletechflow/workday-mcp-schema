---
name: payroll-viewer-skill
description: Use when a payroll viewer asks about pay groups, pay runs, pay results, or their own payslip. Do not use to create or change payroll data, or to open another worker's payslip.
---

> **Boundary.** This file mirrors a Workday Extend skill. The tenant copy is the source of truth. The body below is the tenant text, unchanged.
> This repository does not register these tool names. Do not call them on the workday-mcp-schema MCP server.
> In this repository, a change is a preview or a propose tool, then a human confirm, then a commit in code. A yes in chat is not a submit.
> If a step names a tool that is not in the tool list, stop and say the step is unavailable.

# Payroll Viewer Skill

Read-only payroll visibility for users with access to one or more Workday pay groups.
Surfaces pay group structure and period schedules, pay run group selections for regular,
off-cycle, and retro runs, payroll input records, pay results by group and period, next
payment dates, and year-end tax documents. **Never creates, modifies, or submits any
payroll data.** Payslips and individual worker pay are self-service only — the caller
sees their own record; totals and period summaries are preferred when role allows.

---

## Security Rules (enforce on every request)

- **Scope to accessible pay groups.** All pay group lookups are bounded by the signed-in
  user's Workday security. `find_pay_groups` and `find_pay_group_details` return only pay
  groups the caller is authorized to view (Set Up: Payroll - Pay Group Specific domain).
  Do not attempt to retrieve a pay group or pay group detail whose ID was supplied by the
  user but was not returned in a prior list — that is a scope violation attempt.
- **No individual pay for non-payroll-admin callers.** `find_payslips` and
  `find_payslip_summary` are self-service and return only the signed-in worker's own
  payslips — this is enforced by Workday, not by this skill. Never pass another worker's
  ID to these tools. When a user asks for another worker's payslip, decline: "Payslip
  details are self-service only. I can show totals or period summaries scoped to pay
  groups you administer."
- **No writes, ever.** If a user asks to create, update, submit, cancel, or delete any
  payroll data, decline: "This skill is read-only. Payroll input changes must be made
  through the Workday UI or a write-enabled payroll skill."
- **No retry on 403.** Surface the error: "You don't have permission to view [resource].
  This may require the 'Set Up: Payroll - Pay Group Specific' security domain or a
  payroll-admin role." Do not retry with different parameters.
- **Ambiguity check.** If a pay group name or period is ambiguous, list candidates and
  ask the user to confirm before proceeding.

---

## Functional Areas

### 1. Pay Groups

**Goal:** List active pay groups and their details (run category, period schedule,
processing periods, pay run groups).

**Steps:**
1. Call `find_pay_groups` (omit `contextInstanceId`) to list all pay groups visible to
   the caller. Optionally filter by `country` if the user specifies one.
2. If the user asks for a specific pay group, call `find_pay_groups` with the pay group
   WID as `contextInstanceId`.
3. For detailed period and run-category information, call `find_pay_group_details` with
   the pay group detail WID.
4. To filter details by run category, pass one or more `runCategories` WIDs. Resolve
   valid run category WIDs via `payroll_run_categories_prompt`.

**Do not** call `find_pay_group_details` with an ID the user supplied but that was not
returned by a prior `find_pay_groups` call.

---

### 2. Pay Group Period Schedule (Payroll Calendar)

**Goal:** Show the period schedule for a pay group — processing periods, pay dates, and
period boundaries — without a dedicated payroll-calendar API.

**Steps:**
1. Call `find_pay_group_details` for the relevant pay group detail WID to read the
   `periodSchedule` and `processingPeriods` fields; these contain period start/end dates
   and payment dates.
2. If the user wants upcoming on-cycle pay run periods, call
   `payroll_run_payroll_calculation_pay_run_group_selections_prompt` to list active
   pay run group selections eligible for a regular payroll calculation run.
3. For off-cycle periods, call `payroll_off_cycle_pay_pay_run_group_selections_prompt`
   to list eligible pay run group selections, then
   `payroll_off_cycle_pay_calculation_periods_prompt` to list valid periods for the
   selected pay run group.

---

### 3. Pay Results by Group and Period

**Goal:** Browse payroll results for a specific pay group detail and pay period.

**Steps:**
1. Resolve the pay group detail WID via `find_pay_group_details` if not already known.
2. Call `payroll_payroll_results_for_pay_group_detail_and_period_prompt` to retrieve
   payroll results for the given pay group detail and period combination. This is the
   primary tool for result browsing.
3. To filter by calculation status, resolve valid statuses via
   `payroll_result_calculation_statuses_prompt` (for off-cycle contexts) or
   `payroll_result_calculation_statuses_all_statuses_prompt` (for all contexts).
4. Present results as a summary (pay group, period dates, result count, statuses).
   Do not expand individual worker-level pay lines unless the caller is a confirmed
   payroll admin and asks explicitly.

---

### 4. Payroll Input Records (Read)

**Goal:** View existing payroll input records for eligible workers.

**Steps:**
1. To list workers eligible for payroll input (payroll admin context), call
   `list_request_payroll_input_workers`. This also returns each worker's next primary
   pay period start date.
2. To look up valid pay components for a worker, call
   `list_request_payroll_input_pay_components` (optionally pass `effectiveDate`).
3. To look up valid input types for a selected pay component, call
   `payroll_input_types_prompt` with the pay component WID.
4. To read a specific payroll input instance, call `find_payroll_inputs` with the
   payroll input WID.
5. Present input records as: worker name, pay component, start/end date, input type,
   value, and status.

**Do not** use `create_payroll_inputs`, `edit_payroll_inputs`, or `request_payroll_input`
— those are write operations and are outside the scope of this skill.

---

### 5. Retro Pay Group Browsing

**Goal:** Show pay run groups and statuses available for retro pay review (read-only
browsing, not launching a retro calculation).

**Steps:**
1. Call `list_retro_results_pay_run_group_selections` to list pay groups the caller
   can access for retro worker result review. Use a returned WID as
   `payRunGroupSelectionId` when filtering retro results.
2. To understand which pay run groups are eligible for a retro calculation (payroll
   admin context), call `list_retro_calc_pay_run_group_selections`.
3. To resolve retro event categories for a pay run group, call
   `list_retro_event_categories` passing the `payRunGroupSelectionParm` from step 2.
4. To resolve calculation statuses for a pay run group selection, call
   `list_retro_calculation_statuses` passing the same `payRunGroupSelectionParm`.

**Do not** launch a retro calculation. If the user requests one, decline: "Launching
a Retro Pay Calculation is a write operation. This skill is read-only."

---

### 6. Next Payroll Payment Date

**Goal:** Tell the signed-in worker when their next on-cycle payroll payment will be made.

**Steps:**
1. Call `find_worker_next_payroll_payment_date` with the signed-in worker context.
   This is a self-service tool — it returns only the calling worker's own next payment
   date.
2. Optionally call `list_countries_for_worker_pay_group` and
   `list_companies_for_worker` to give the user context on which pay groups and
   companies are in scope.

---

### 7. Self-Service Payslips

**Goal:** Show the signed-in worker their own payslips.

**Steps:**
1. Call `find_payslips` to list the worker's own payslips. Use optional filters:
   `startDate`, `endDate`, `numberOfPayslips`, or `mostRecent: true`.
2. For a specific payslip's breakdown (gross, net, YTD deductions, taxes, hours), call
   `find_payslip_summary` with the payslip WID.
3. **Never** pass another worker's ID to `find_payslips` or `find_payslip_summary`.
   Both are self-service; Workday enforces the scope server-side, but this skill must
   decline the request before making the call.

---

### 8. Year-End Tax Documents

**Goal:** Show the signed-in worker their own year-end tax forms (W-2, T4, P60, etc.).

**Steps:**
1. Call `list_countries_for_worker_year_end_tax_documents` to identify which countries
   have tax documents for this worker.
2. Call `list_report_types_for_worker_year_end_tax_documents` to identify which form
   types are available (e.g., W-2, T4).
3. Call `list_companies_for_worker_year_end_tax_documents` to identify which companies
   appear on the worker's documents.
4. Call `find_tax_form_box_details` with optional filters (`country`, `reportType`,
   `startDate`, `company`) to retrieve the worker's tax form box amounts.
5. Present results as: tax year, form type, company, payroll tax authority, and
   box-level amounts.

---

## Error Handling

| Condition | Response |
|---|---|
| 403 on any tool | "You don't have permission to view [resource]. This may require the 'Set Up: Payroll - Pay Group Specific' domain or a payroll-admin role. I won't retry this request." |
| 404 on pay group WID | "That pay group ID was not found. Let me list the pay groups visible to you." Then call `find_pay_groups`. |
| User requests a write | "This skill is read-only. Payroll input changes must be made through the Workday UI or a write-enabled payroll skill." |
| Ambiguous pay group or period | List candidates from `find_pay_groups` or the relevant period prompt and ask the user to confirm. |
| User requests another worker's payslip | "Payslip details are self-service only. I can only show your own payslips." |
