/**
 * Narrow Slack Web API surface, injectable for tests:
 *   views.open        show a modal to the user who just invoked a signed command or shortcut
 *   chat.postMessage  DM an approver or requester (channel = user id), or post to the fallback channel
 *   response_url      update the message a button lived on, or follow up after a slow commit
 * Every call is bounded by SLACK_HTTP_TIMEOUT_MS. response_url targets must be on hooks.slack.com,
 * so a forged payload cannot turn the runtime into a request proxy.
 */
export const SLACK_HTTP_TIMEOUT_MS = 8_000;

export type SlackResult = { ok: boolean; error?: string };

export interface SlackApi {
  viewsOpen(triggerId: string, view: Record<string, unknown>): Promise<SlackResult>;
  /** `channel` is a channel id or a user id (a user id opens or reuses the app DM). */
  postMessage(
    channel: string,
    text: string,
    blocks?: Record<string, unknown>[],
  ): Promise<SlackResult & { ts?: string | undefined }>;
  /** POST a response to a Slack `response_url`. Refuses URLs that are not Slack hooks. */
  respond(responseUrl: string, body: Record<string, unknown>): Promise<SlackResult>;
}

/** Only https URLs on hooks.slack.com are accepted as response targets. */
export function isSlackResponseUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

export function createHttpSlackApi(botToken: string, fetchImpl: typeof fetch = fetch): SlackApi {
  const call = async (
    url: string,
    body: Record<string, unknown>,
    auth: boolean,
  ): Promise<SlackResult & { ts?: string | undefined }> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(auth ? { authorization: `Bearer ${botToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "network_or_timeout" };
    }
    if (!auth) return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }; // response_url replies with plain "ok"
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
    return json.ok === true ? { ok: true, ts: json.ts } : { ok: false, error: json.error ?? `http_${res.status}` };
  };
  return {
    viewsOpen: (triggerId, view) => call("https://slack.com/api/views.open", { trigger_id: triggerId, view }, true),
    postMessage: (channel, text, blocks) =>
      call("https://slack.com/api/chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}) }, true),
    respond: (responseUrl, body) =>
      isSlackResponseUrl(responseUrl)
        ? call(responseUrl, body, false)
        : Promise.resolve({ ok: false, error: "bad_response_url" }),
  };
}

/** Resolve within budgetMs or report a timeout; the underlying promise keeps running. */
export async function withinBudget<T>(
  p: Promise<T>,
  budgetMs: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), budgetMs);
  });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
