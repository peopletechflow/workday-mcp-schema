# Skill: worker-data-skill (read-only)

Mirror of the Extend skill in app `peopletechHrBaseline_rjqhll` on tenant `bzyvydgxsb_extdev` (wd119). Built with the Workday Developer Agent; discovered 2026-10-20. The tenant is the source of truth.

## Description
Answers questions about workers: who someone is, their job and org, contact details, service dates, reporting lines, and (where security allows) personal information. **Read-only**: it never changes data.

## Tools (13 Agent-Ready, all read-only; WIDs not exposed)
| Tool | Returns |
| --- | --- |
| `find_org_chart_workers` | Display name → worker WID (org chart) |
| `find_service_dates_for_worker` | Hire, original hire, continuous service, benefits service, seniority, company service dates, length of service |
| `find_staffing_agent_supervisory_organization_members` | Filled positions in a supervisory org (name, business title, job profile, job type, location, next pay period), paginated with total |
| `find_staffing_supervisory_organization` | Org detail: name, type, location, active, manager |
| `find_staffing_workers` | Search (`search` tokens, OR) or `email`, or fetch by `contextInstanceId` (WID or `"me"`): business title, location, primary managers, primarySupervisoryOrganization, work email/phone |
| `find_worker_personal_information` | DOB, gender, marital status, citizenship, nationality (sensitive) |
| `list_organizations` | Orgs by name prefix |
| `list_staffing_jobs` | Job/position by job WID or `"me"`: job profile, job type, supervisory org, next pay period |
| `list_worker_addresses` | Home addresses (sensitive) |
| `list_worker_direct_reports` | Direct reports with hasManagerRole, reporting type, time in position; `limit`/`offset`, total |
| `list_worker_email_addresses` | Email addresses |
| `list_worker_organizations` | All memberships (Company, Cost Center, Supervisory Org, Region, Location/Company/Cost Center Hierarchy); filter `organizationType`/subtype |
| `list_worker_phone_numbers` | Phone numbers |

Parameters other than the ones above were not captured. Discover the live schema before calling.

## Security rules
- Every call runs as the end user. Workday security decides visibility; never work around a denial.
- Use `"me"` for the signed-in worker. Never guess or fabricate WIDs; resolve names with `find_org_chart_workers` / `find_staffing_workers`.
- `find_worker_personal_information` needs domain **Person Data: Personal Information** or **Self-Service: Personal Information**. Personal information and home addresses are sensitive: return them only when the user asks for them explicitly, and only for themselves or for workers they are entitled to see (baseline RBAC: worker_self for self and hr_partner; never manager).
- Return the minimum fields that answer the question.

## Steps
1. Identify the target: `"me"`, or resolve a name/email to a WID (`find_org_chart_workers`, `find_staffing_workers`). If there are several matches, ask the user to choose.
2. Call the narrowest tool for the question (jobs, orgs, contacts, service dates, personal info).
3. **Manager chain** (no dedicated endpoint): `find_staffing_workers` → `primarySupervisoryOrganization` → `find_staffing_supervisory_organization` → manager. Repeat, up to 10 hops.
4. **Indirect reports**: `list_worker_direct_reports`, then recurse into reports where `hasManagerRole` is true, up to depth 5. Page with `limit`/`offset` until you reach `total`.
5. Summarize the answer, say when results were truncated by a cap, and cite which records were used.

## Errors
| Response | Meaning | Action |
| --- | --- | --- |
| 403 | Security domain / visibility denial | Do not retry. Tell the user they lack access. |
| 404 | Not found | Report it and ask the user for a different identifier. |
| 400 | Bad parameter | Fix the parameter and retry **once**. |
| 200, `total = 0` | No results | Say nothing matched. Do not treat it as an error. |

## Not in scope
- Any write (hire, change job, update contact/personal data, org changes).
- Compensation, payroll, pay statements, bank details, benefits elections, time off.
- Bulk exports or HR analytics across the whole tenant.
- Bypassing Workday security or inferring hidden data.
