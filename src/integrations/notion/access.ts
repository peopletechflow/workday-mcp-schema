/**
 * Notion knowledge access for agents, fail closed.
 *
 * Notion facts this design relies on (do not overstate them):
 * - An internal integration token sees every page shared with that integration. It is a
 *   service credential, not a user identity, and does not reflect each user's Notion permissions.
 * - A public integration uses OAuth, but the resulting token is scoped to the pages the
 *   installing user chose to share with the integration in that workspace. It is not a
 *   per-request mirror of every Notion user's page permissions.
 *
 * Therefore every read requires BOTH:
 *   1. the resource is in the server-maintained policy for the caller's tenant, and the caller's
 *      roles / user id are entitled to it (deny list wins), and
 *   2. a token: in "delegated" mode the caller's own stored token (missing => deny); in
 *      "allowlist" mode the service token, usable only for resources passing step 1.
 * There is no fallback that lets a service token read arbitrary pages.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Role } from "../../rbac/roles.js";
import type { NotionConfig } from "../config.js";
import type { BoundIdentity } from "../identity.js";

export class NotionAccessDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`Notion access denied: ${reason}`);
    this.name = "NotionAccessDeniedError";
  }
}

const NotionId = z.string().regex(/^[0-9a-f]{32}$/i, "32-hex Notion id without dashes");

const ResourceSchema = z.object({
  tenantId: z.string().min(1),
  resourceId: NotionId,
  label: z.string().max(120),
  allowedRoles: z.array(z.string()).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  deniedUserIds: z.array(z.string()).default([]),
});
export type NotionResource = z.infer<typeof ResourceSchema>;

export function normalizeNotionId(raw: string): string {
  return raw.replace(/-/g, "").toLowerCase();
}

export class NotionResourcePolicy {
  private readonly resources: NotionResource[];
  constructor(resources: readonly NotionResource[]) {
    this.resources = resources.map((r) => {
      const p = ResourceSchema.parse(r);
      return { ...p, resourceId: normalizeNotionId(p.resourceId) };
    });
  }
  static fromFile(path: string): NotionResourcePolicy {
    if (!existsSync(path)) throw new Error("Notion resource policy missing (fail closed).");
    return new NotionResourcePolicy(z.array(ResourceSchema).parse(JSON.parse(readFileSync(path, "utf8"))));
  }
  /** Resources the caller may read. Used to build the agent's Notion tool scope. */
  entitled(caller: BoundIdentity, roles: readonly Role[]): NotionResource[] {
    return this.resources.filter(
      (r) =>
        r.tenantId === caller.tenantId &&
        !r.deniedUserIds.includes(caller.userId) &&
        (r.allowedUserIds.includes(caller.userId) || r.allowedRoles.some((x) => roles.includes(x as Role))),
    );
  }
  assertEntitled(caller: BoundIdentity, roles: readonly Role[], resourceId: string): NotionResource {
    const id = normalizeNotionId(resourceId);
    const r = this.entitled(caller, roles).find((x) => x.resourceId === id);
    if (!r) throw new NotionAccessDeniedError("resource_not_entitled");
    return r;
  }
}

/** Server-side store of per-user Notion tokens (delegated mode). Never return tokens to the model. */
export interface DelegatedNotionTokens {
  get(tenantId: string, userId: string): Promise<string | undefined>;
}

export type NotionFetcher = (token: string, resourceId: string) => Promise<string>;

/** Live fetcher: page block children as plain text. Not exercised in offline checks. */
export const notionHttpFetcher: NotionFetcher = async (token, resourceId) => {
  const res = await fetch(`https://api.notion.com/v1/blocks/${resourceId}/children?page_size=100`, {
    headers: { authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  if (!res.ok) throw new NotionAccessDeniedError(`notion_http_${res.status}`);
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const lines: string[] = [];
  for (const block of body.results ?? []) {
    const type = block.type as string | undefined;
    const content = type ? (block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined) : undefined;
    const text = content?.rich_text?.map((t) => t.plain_text ?? "").join("") ?? "";
    if (text) lines.push(text);
  }
  return lines.join("\n");
};

export class NotionReader {
  constructor(
    private readonly config: NotionConfig,
    private readonly policy: NotionResourcePolicy,
    private readonly fetcher: NotionFetcher,
    private readonly delegated?: DelegatedNotionTokens,
  ) {}

  async read(caller: BoundIdentity, roles: readonly Role[], resourceId: string): Promise<{ resourceId: string; label: string; text: string }> {
    if (!this.config.enabled) throw new NotionAccessDeniedError("notion_disabled");
    const resource = this.policy.assertEntitled(caller, roles, resourceId);
    let token: string | undefined;
    if (this.config.mode === "delegated") {
      token = await this.delegated?.get(caller.tenantId, caller.userId);
      if (!token) throw new NotionAccessDeniedError("no_user_token");
    } else {
      token = this.config.serviceToken;
      if (!token) throw new NotionAccessDeniedError("no_service_token");
    }
    const text = (await this.fetcher(token, resource.resourceId)).slice(0, this.config.maxChars);
    return { resourceId: resource.resourceId, label: resource.label, text };
  }
}
