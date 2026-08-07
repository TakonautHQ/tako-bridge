# Contributing

1. Open an issue describing the defect or narrowly scoped change.
2. Add the smallest failing regression test before changing behavior.
3. Run `bun run test`, `bun run typecheck`, `bun run pack:check`, and `bun audit`.
4. Do not weaken HTTPS and same-origin enforcement, credential-file permissions, repository verification, signed-manifest validation, managed-worktree checks, sensitive-value redaction, or human review gates.
5. Keep Pi host packages in `peerDependencies`; do not bundle a second Pi runtime or Tako Runner.

Runtime dependencies require explicit justification. Pin release tags and preserve compatibility with the Pi version documented in README.md.
