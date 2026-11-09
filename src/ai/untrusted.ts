/** Longest tool result handed to the model. Beyond this the result is cut and the model is told to narrow the query. */
export const MAX_TOOL_RESULT_CHARS = 6_000;

/**
 * Wrap third-party content as data and cap its size. The cap keeps one broad read from
 * flooding the context; the note tells the model how to recover (narrow, do not page).
 */
export function wrapUntrusted(source: string, content: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const neutral = raw.replace(/<\/?\s*untrusted_data[^>]*>/gi, "[tag removed]");
  const body =
    neutral.length > maxChars
      ? `${neutral.slice(0, maxChars)}\n[truncated ${neutral.length - maxChars} characters. Narrow the query (dates, status, limit) instead of paging.]`
      : neutral;
  return `<untrusted_data source="${source.replace(/[^a-z0-9_:.-]/gi, "")}">\n${body}\n</untrusted_data>`;
}
