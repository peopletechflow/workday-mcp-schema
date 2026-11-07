/**
 * Narrow Slack Web API surface: only views.open (to show a modal to the user who just
 * invoked a signed command or shortcut). No chat.postMessage here. Injectable for tests.
 */
export interface SlackApi {
  viewsOpen(triggerId: string, view: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

export function createHttpSlackApi(botToken: string, fetchImpl: typeof fetch = fetch): SlackApi {
  return {
    async viewsOpen(triggerId, view) {
      const res = await fetchImpl("https://slack.com/api/views.open", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
        body: JSON.stringify({ trigger_id: triggerId, view }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      return { ok: body.ok === true, error: body.ok ? undefined : body.error ?? `http_${res.status}` };
    },
  };
}

/** Resolve within budgetMs or report a timeout; the underlying promise keeps running. */
export async function withinBudget<T>(p: Promise<T>, budgetMs: number): Promise<{ done: true; value: T } | { done: false }> {
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
