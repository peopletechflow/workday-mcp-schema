# Contributing

1. Use Node 22 and pnpm: `pnpm install --frozen-lockfile`, then `pnpm check`, which must pass.
2. Keep changes narrow. Every new write path needs a full preview, explicit confirmation, a single-use token, and idempotency. Add tests that prove the denial cases.
3. Never commit secrets, `.env` files, tokens, tenant mappings with real hostnames, or real employee data. Use the `*.example.*` files and invented fixtures.
4. Do not add Workday API operations from memory. Cite the public documentation, or keep the capability gated and document the gap.
5. Report security issues privately, following SECURITY.md, not as an issue or a PR.
6. By contributing, you agree that your contribution is licensed under the repository's LICENSE (MIT).
