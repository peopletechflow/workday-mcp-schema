/**
 * Audit-safe summary helper via the AI SDK (generateEnterpriseText).
 * Redacts known PII keys before the prompt leaves this process.
 */
import { redactPii } from "../safety/audit.js";
import { generateEnterpriseText, AiDisabledError } from "./client.js";

export type SummarizeToolResultInput = {
  toolName: string;
  result: unknown;
  /** Max chars of redacted JSON to send to the model. */
  maxChars?: number;
};

/**
 * Summarize a tool result for logs / operator display.
 * When AI is disabled, returns a local redacted JSON preview (no network).
 */
export async function summarizeToolResult(
  input: SummarizeToolResultInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: string; via: "ai" | "local-redacted" }> {
  const redacted = redactPii(input.result);
  const json = JSON.stringify(redacted, null, 2);
  const clipped = json.length > (input.maxChars ?? 4000) ? `${json.slice(0, input.maxChars ?? 4000)}…` : json;

  try {
    const { text } = await generateEnterpriseText(
      {
        system:
          "Summarize this Workday tool result for an internal audit log. " +
          "Do not invent fields. Do not restore redacted values. Keep it under 80 words.",
        prompt: `Tool: ${input.toolName}\nResult:\n${clipped}`,
      },
      env,
    );
    return { summary: text.trim(), via: "ai" };
  } catch (err) {
    if (err instanceof AiDisabledError) {
      return {
        summary: `tool=${input.toolName} redactedResult=${clipped.slice(0, 500)}`,
        via: "local-redacted",
      };
    }
    throw err;
  }
}
