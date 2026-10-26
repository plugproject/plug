# Plug reference package

Deterministic multi-system design analysis, authorized integration probing,
edge verification, citation-gated review, author adoption and bounded
trusted-local HTTP, MCP and A2A transports. Exports:
`normalizeSystems`, `suggestDesign`, `explainDesign`, `runDemo`, canonical
types/validators, metadata importers, probe/verification/review APIs, OpenSpec
revision support, MCP/skill installers and bundled synthetic flight input.

CLI: `plug analyze`, `plug explain`, `plug demo`, `plug setup`, `plug probe`,
`plug verify`, `plug spec`, `plug ui`, `plug mcp` and `plug skill install`.
Build from the repository before `npm pack --workspace @plugproject/plug`.
Schema and validators are bundled; no repository files are required at runtime.
Licensed under the [MIT License](LICENSE). npm publication remains disabled.

## Dependency setup

The deterministic SDK requires no environment variables. After installing the
owner-authorized package tarball, run:

```sh
npx plug setup --workspace .
npx plug setup --check --workspace .
```

The guided setup configures only optional model roles, masks secrets, and writes
an ignored mode-`0600` `.env.local`. `plug ui`, `probe`, `verify` and `mcp` load
that file. SDK hosts can call `promptForPlugEnvironment` for the terminal flow,
provide their own `PlugSetupPrompt` to `setupPlugEnvironment`, or render
`inspectPlugEnvironment` results in their setup UI.

- Jev: `TYPESAFE_API_KEY` and `PLUG_JUDGE_MODEL`; optionally pin
  `PLUG_JUDGE_PROVIDER=typesafe`.
- Drafting: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`,
  `PLUG_DRAFT_PROVIDER`, and `PLUG_DRAFT_MODEL`.
- Review: reuses the draft provider/model unless `PLUG_REVIEW_PROVIDER` and
  `PLUG_REVIEW_MODEL` override them.
- Executable bindings: every saved `${env:NAME}` reference requires that
  project-specific `NAME` at execution time.

Public playground hosting additionally requires an exact `APP_ORIGIN`; `PORT`,
`TRUST_PROXY_HOPS`, `RENDER_GIT_COMMIT` and `RELEASE_COMMIT` are
deployment-specific. API keys and endpoint credentials must never enter `.plug/`
or source control.
