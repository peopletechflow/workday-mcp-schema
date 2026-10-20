# Workday Extend (Layer 2)

This folder mirrors the **Workday Extend** app that hosts our custom agent skills. It is documentation, not deployable source: the source of truth lives in the tenant.

| Item | Value |
| --- | --- |
| Extend app | `peopletechHrBaseline_rjqhll` |
| Dev tenant | `bzyvydgxsb_extdev` (wd119, Workday Open Developer Platform personal dev tenant) |
| Skills | [`worker-data-skill`](./skills/worker-data-skill.md) (read-only, 13 tools) · [`self-service-skill`](./skills/self-service-skill.md) (self only, 39 tools incl. 15 staged writes; known gap: `update_personal_information_marital_status`) · [`manager-actions-skill`](./skills/manager-actions-skill.md) (52 tools incl. 6 writes; verified team scope) · [`hr-partner-skill`](./skills/hr-partner-skill.md) (49 tools, 21 new incl. 11 writes; org-scope gate; gap: no open-event tool for ID changes) · [`payroll-viewer-skill`](./skills/payroll-viewer-skill.md) (read-only, 26 tools, 22 new + 4 shared, 0 writes; payslips: own for every role, payroll viewer within its pay groups, admin all; other own pay self-only; pay-group listing proof; pay results summary-only unless a payroll viewer or admin asks for detail) · [`admin-skill`](./skills/admin-skill.md) (92 tools, 21 new reads + 71 shared incl. 12 self-service writes; full tenant-wide read, self-only writes, sensitive field gate, aggregate-only demographics, hard refusals; tool list from a scrolled screenshot, rows above the first visible one may be missing) |
| Catalog totals | 158 tools (125 reads, 33 writes): 152 tenant-discovered + 6 public-docs seed rows. Writes unchanged by `payroll-viewer-skill` and `admin-skill`. |

## How skills are built

1. Skills are authored with the **Workday Developer Agent** while it is connected to the tenant. The agent lists the Agent-Ready MCP tools available to the app, and we attach the ones the skill needs.
2. Once the skill works in the tenant, it is **mirrored here** as Markdown (`extend/skills/<skill>.md`), covering description, tools, security rules, steps, errors and what is not in scope.
3. The tools it uses go into the Layer-1 catalog (`src/agent-ready/catalog.tenant.ts`) with `source: "tenant-discovered <date> <tenant>"`, and they are mapped to roles in `src/rbac/agent-ready.ts`. `npm run check:rbac` fails if a tenant tool has no mapping.

WIDs are not exposed in the Developer Agent UI, so mirrored tools carry `wid: null` until an ASOR dump fills them in (`npm run sync:agent-ready -- --asor <dump.json>`). Never invent WIDs.

`skills/payroll-viewer-skill.md` and `skills/admin-skill.md` are the verbatim Developer Agent skill texts (the other mirrors are condensed). admin-skill: `ADMIN_SKILL_TOOLS` / `ADMIN_SHARED_TOOLS` / `ADMIN_HARD_REFUSALS` in the catalog, the sensitive field gate in `src/safety/sensitive-fields.ts`, demographics in `src/safety/diversity.ts`. Its tools are in `PAYROLL_VIEWER_SKILL_TOOLS` (`src/agent-ready/catalog.tenant.ts`); RBAC in `src/rbac/agent-ready.ts`, the pay-group proof in `src/rbac/pay-group-scope.ts` and the pay-results shaping rule in `src/safety/pay-results.ts`.

If the tenant and this mirror disagree, the tenant wins. Re-run discovery and update both the mirror and the catalog.
