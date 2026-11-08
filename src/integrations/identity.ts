/**
 * Server-side identity binding. A Slack (team, user) pair maps to exactly one
 * (tenantId, userId) that the server already authenticated (for example through
 * the Workday OAuth sign-in plus an admin-approved link). Payload emails, display
 * names, and model-supplied user ids are never trusted.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export type BoundIdentity = { tenantId: string; userId: string };

const LinkSchema = z.object({
  slackTeamId: z.string().regex(/^[TE][A-Z0-9]{2,}$/),
  slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,}$/),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
});
export type IdentityLink = z.infer<typeof LinkSchema>;

export interface IdentityResolver {
  /** Undefined means unknown or revoked caller: deny. */
  resolveSlack(teamId: string, userId: string): BoundIdentity | undefined | Promise<BoundIdentity | undefined>;
}

export type SlackAddress = { teamId: string; userId: string };

/** Reverse lookup, used only to deliver notifications (never to authenticate anyone). */
export interface SlackDirectory {
  slackFor(identity: BoundIdentity): SlackAddress | undefined | Promise<SlackAddress | undefined>;
}

export class IdentityDirectory implements IdentityResolver, SlackDirectory {
  private readonly links = new Map<string, BoundIdentity>();
  private readonly reverse = new Map<string, SlackAddress>();
  constructor(links: readonly IdentityLink[] = []) {
    for (const l of links) this.link(l);
  }
  link(input: IdentityLink): void {
    const l = LinkSchema.parse(input);
    const key = `${l.slackTeamId}:${l.slackUserId}`;
    if (this.links.has(key)) throw new Error(`Duplicate Slack identity link ${key} (fail closed).`);
    this.links.set(key, { tenantId: l.tenantId, userId: l.userId });
    this.reverse.set(`${l.tenantId}:${l.userId}`, { teamId: l.slackTeamId, userId: l.slackUserId });
  }
  /** Undefined means unknown caller: deny. */
  resolveSlack(teamId: string, userId: string): BoundIdentity | undefined {
    return this.links.get(`${teamId}:${userId}`);
  }
  slackFor(identity: BoundIdentity): SlackAddress | undefined {
    return this.reverse.get(`${identity.tenantId}:${identity.userId}`);
  }
  static fromFile(path: string): IdentityDirectory {
    if (!existsSync(path)) throw new Error(`Identity map not found at configured path (fail closed).`);
    const parsed = z.array(LinkSchema).parse(JSON.parse(readFileSync(path, "utf8")));
    return new IdentityDirectory(parsed);
  }
}
