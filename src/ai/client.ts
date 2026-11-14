/**
 * Single factory for enterprise model access via Vercel AI Gateway.
 * Fixtures / WORKDAY_AI_DISABLED=1 → refuse network (no LLM spend in CI).
 */
import { gateway, generateText, type LanguageModel } from "ai";

export class AiDisabledError extends Error {
  constructor(message = "AI is disabled (WORKDAY_AI_DISABLED=1 or missing AI_GATEWAY_API_KEY).") {
    super(message);
    this.name = "AiDisabledError";
  }
}

function envBool(name: string, env: NodeJS.ProcessEnv, fallback = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type EnterpriseAiConfig = {
  /** When true, createEnterpriseModel / generateEnterpriseText refuse to call the network. */
  disabled: boolean;
  apiKeyPresent: boolean;
  modelId: string;
  useFixtures: boolean;
};

/**
 * AI is disabled when:
 * - WORKDAY_AI_DISABLED=1, or
 * - AI_GATEWAY_API_KEY is missing
 *
 * Fixture mode alone does not block AI if a gateway key is present (rare local demo).
 * CI and default fixture runs leave the key unset, so AI stays offline.
 */
export function loadEnterpriseAiConfig(env: NodeJS.ProcessEnv = process.env): EnterpriseAiConfig {
  const useFixtures = envBool("WORKDAY_USE_FIXTURES", env, true);
  const apiKeyPresent = Boolean(env.AI_GATEWAY_API_KEY?.trim());
  const explicitlyDisabled = envBool("WORKDAY_AI_DISABLED", env, false);
  return {
    disabled: explicitlyDisabled || !apiKeyPresent,
    apiKeyPresent,
    modelId: env.WORKDAY_AI_MODEL?.trim() || "anthropic/claude-sonnet-4.5",
    useFixtures,
  };
}

/**
 * Returns a gateway language model when AI is enabled.
 * Throws AiDisabledError when disabled / no key.
 */
export function createEnterpriseModel(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const cfg = loadEnterpriseAiConfig(env);
  if (cfg.disabled) {
    throw new AiDisabledError(
      cfg.apiKeyPresent
        ? "AI calls are disabled by WORKDAY_AI_DISABLED."
        : "AI_GATEWAY_API_KEY is required for enterprise AI calls. Set WORKDAY_AI_DISABLED=1 to opt out explicitly in CI/fixtures.",
    );
  }
  // AI SDK reads AI_GATEWAY_API_KEY from the environment for the default gateway provider.
  return gateway(cfg.modelId);
}

/** Stub used by tests: any generate path refuses network. */
export function createDisabledAiStub(): {
  generate: () => Promise<never>;
} {
  return {
    async generate(): Promise<never> {
      throw new AiDisabledError();
    },
  };
}

/**
 * Thin generateText wrapper. All package LLM text generation should call this
 * (or createEnterpriseAgent) so the policy in policy.ts stays enforceable.
 */
export async function generateEnterpriseText(
  args: {
    prompt: string;
    system?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string }> {
  const model = createEnterpriseModel(env);
  const result = await generateText({
    model,
    prompt: args.prompt,
    ...(args.system !== undefined ? { instructions: args.system } : {}),
  });
  return { text: result.text };
}
