/**
 * Enterprise AI policy for workday-mcp-schema (Layer-3 custom MCP).
 *
 * Rule: every model call in this package goes through helpers under `src/ai/`.
 * Do not add raw `fetch` to openai.com, api.anthropic.com, or other LLM HTTP APIs
 * elsewhere in this repo. Use `createEnterpriseModel` / `generateEnterpriseText` /
 * `createEnterpriseAgent` instead.
 *
 * Writes still require preview → explicit confirm → commit. An agent must not
 * auto-commit without a confirmation flag that flows through the existing guards.
 */
export const AI_POLICY = {
  allModelCallsGoThroughSrcAi: true,
  noRawProviderFetchOutsideSrcAi: true,
  writesRequirePreviewConfirm: true,
  workdaySecurityRemainsAuthoritative: true,
} as const;
