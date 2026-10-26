# Plug 0.2.0-alpha.1 — local workbench, multi-system inference and workflow graph

Implements the draft SEPs indexed in [seps/README.md](seps/README.md), including
the local workbench, workflow interchange, integration probing, edge verification,
design review and author adoption, revision history, and MCP/skill exposure.
Verified locally on 2026-10-26 using **Node 24.22.1**. Public URL: **not
deployed**. Release commit: **not assigned**. No production SLO or adoption claims
are made.

## Implemented

- `0.2-alpha.1` contracts: multi-system graphs without fixed serialized system,
  operation or connection count ceilings, with each connection's own profile,
  workload and experience, optional goal fields and priorities,
  `static` evidence, `WorkspaceIndex` and `PatternDefinition`. `0.1-alpha.2`
  documents migrate mechanically with equal candidate verdicts.
- Three-valued relation engine, pattern knowledge base (six seeds, seventeen
  pairwise patterns, five global patterns), bounded closure planner, Pareto
  frontier per status tier, lexicographic priority ranking, `policyDecisionNeeded`,
  per-architecture proofs and cross-connection quota checks.
- `plug index`: bounded, deterministic local scan (no symlinks, secrets,
  dependency, build or test directories; hostnames only; no network) drafting a
  system from OpenAPI, Agent Cards and MCP registrations, with gaps.
- `plug ui`: loopback-only workbench serving the packaged UI, workspace index and
  freshness endpoints, and a single bundled sandbox.
- Local MCP and A2A discovery in `plug ui` only: the inspector takes a server's URL
  and transient request headers, lists an MCP server's tools over Streamable HTTP
  (never calling one) or an A2A agent's skills from its Agent Card (never sending a
  message), within time, size, page and same-origin redirect bounds, and imports
  the chosen ones through the metadata importers. Headers are never stored,
  logged or returned; the hosted playground never discovers.
- Playground: workflow graph editor (systems as groups, operations as nodes,
  connections as edges with priority badges and per-edge inspector; + connectors
  shown on hover that connect by dragging onto any part of an operation or by
  picking from a list, a click-to-connect Add connection mode with a preview line,
  × on every system, operation and edge that also removes dependent connections,
  with undo, drafts that list what they lack and hold back analysis and export,
  drop a connection drag on empty canvas to spawn a wired system, drag an edge end to
  rewire, double-click or F2 to rename systems and operations or set an edge's
  latency target in place, keyboard deletion, zoom controls and minimap, ELK
  layout loaded lazily), new goal fields,
  frontier with proofs, relation facts and pattern applicability; the workspace
  panel appears only in the local workbench.
- Open Workflow Specification 1.0.x export and import (`WorkflowSpecMetadata`,
  `WorkflowTaskMetadata`): lossless Plug round trip, reconciliation of edited
  priorities, latency targets, order and removed tasks, and parse-only drafting of
  foreign workflows with unknown facts and listed gaps.
- `plug spec` and the workbench's Write spec to workspace write the `.plug/` bundle
  (`workflow.yaml`, `design-input.json`, `design.json`, `design.md`, `AGENTS.md`);
  every write retains a content-addressed revision, and the workbench reviews
  historical Plug or Git versions before replacement.
- Author-disclosed exact-origin authorization, bounded safe-read probes and
  timestamped operation manifests; as-is/design edge verification over authorized
  HTTP, MCP Streamable HTTP and A2A JSON-RPC bindings; schema-validated ephemeral
  request samples when examples are absent; citation-gated critic plus Jev review
  and explicit author adoption.
- `plug mcp`: eleven stdio tools spanning specs, indexing, add/inspect, probe,
  verify, review, adoption and revision history, plus `plug://spec/`,
  `plug://manifest` and `plug://verifications` resources. `plug mcp install`
  registers it in project-scoped Cursor, VS Code or Claude Code configuration;
  `plug skill install` installs the portable Plug workflow skill.
- `plug setup`: an explicit post-install prompt for optional Jev and completion
  providers, with masked secrets, ignored mode-`0600` `.env.local` storage and a
  non-secret `--check` mode. Equivalent setup and environment-inspection APIs are
  exported for SDK hosts; deterministic core use remains zero-configuration.

## Verified

- `npm run check`: TypeScript, ESLint, formatting, generated-artifact drift,
  examples, documentation links/SEP metadata, and **217 passing tests**, including
  workflow interchange, an MCP client talking to `plug mcp` over stdio, and
  discovery against local MCP and A2A fixture servers: pagination, refused and
  cross-origin redirected requests, size, page and time bounds, cancellation, and
  headers that never reach the result or the workspace.
- `npm run build`: reference package with packaged UI, declarations, schema,
  service and UI build.
- Production browser suite: **25 passing Chromium tests** on
  `PLUG_TEST_PORT=3100`. The full-speed proof observed real
  warmup, a cache hit, a changed version after the later refresh, expiry and
  cancellation. The graph tests dragged a + onto an operation and onto empty canvas,
  connected clicked operations in Add connection mode, removed operations,
  connections and every system with undo and listed draft gaps, deleted by keyboard,
  round-tripped a downloaded workflow and reviewed a foreign one. In the packaged
  workbench they probed a safe OpenAPI read, verified a plain-REST edge, reviewed,
  adopted and cleared a design, restored a retained spec revision, exercised a
  50-operation/100-connection graph, and listed MCP tools and A2A skills without
  keeping headers.
- `npm run test:package`: the tarball installed outside the workspace analyzed and
  executed a customized input, indexed a directory, served the workbench UI and
  workspace endpoints, reported non-secret environment readiness, loaded an MCP
  review provider from the workspace's `.env.local`, wrote the `.plug/` bundle,
  installed the portable Plug skill, registered the Cursor MCP entry, and
  verified all eleven tools plus the manifest and verification resources from
  the packed `plug mcp`.
- One live five-case review calibration had pass@1 and engine agreement 1.0 with
  0.2 abstention; one live probe-question smoke test correctly classified useful
  output, source timestamp and rate limiting. Both use scrubbed fixtures and are
  evaluation evidence, not production measurements or SLOs.
- The workbench indexed this repository in a browser and reported a stale index
  after source changes.

The fixture still selects `scheduled-cache` (architecture `scheduled-cache`,
dominating `scheduled-cache-aside`) with unchanged seed estimates. Catalog
`0.2-alpha.1/catalog-1+knowledge-1`.
Input hash: `2e32f278a75589d75f0e6dbce30895e1c22619563a1f92e54efd87aa48aaa98d`.
Design hash: `19667d19c6f9148485d3db4eb98bba6c41b2a228270de53b00ebce415696ba3d`.
The graph editor and ELK layout remain lazy-loaded.

Remaining release steps from 0.1.0-alpha.2 below still apply.

# Plug 0.1.0-alpha.2 — local alpha

Verified locally on 2026-10-04 using Node 24.21.0. Public URL: **not deployed**.
Release commit: **not assigned**; this repository began without commits and the
implementation is currently an uncommitted workspace change. No production SLO or
adoption claims are made.

## Implemented

- Canonical `0.1-alpha.2` TypeScript contracts, generated JSON Schema, standalone
  AJV validators and schema reference; synchronized examples and draft SEP pages.
- Six deterministic patterns/compositions with direct baseline, exact-policy
  coverage replay, bounded age/scheduling/load reasoning, evidence, tradeoffs and
  implementation/configuration/report exports.
- Manual JSON/YAML, MCP 2025-11-25 tools/list and A2A 1.0 Agent Card metadata intake.
- React/Express playground, isolated HTTP demo sandboxes, scoped action tokens,
  quotas, memory/lifetime caps, response validation and cancellation/cleanup.
- Reference package, CLI, real 15-second flight source, continuous trusted-local
  inventory example, documentation preview, CI and Render deployment configuration.

## Verified

- Clean `npm ci`: successful; dependency audit reported zero vulnerabilities.
- `npm run check`: TypeScript, ESLint, formatting, generated-artifact drift,
  examples, documentation links/SEP metadata, and **48 passing tests**.
- `npm run build`: reference package, declarations, schema, service and UI build.
- `PLUG_TEST_PRODUCTION=1 npm run test:browser`: **3 passing Chromium tests**.
  Own descriptions, changed constraints/verdicts, downloads, mobile width, MCP
  metadata review and canonical browser validation passed under the production CSP.
  The full-speed proof observed real 15-second warmup, an eligible fast cache hit,
  a changed source version after the later 60-second refresh, expiry and cancellation.
- `npm run test:package`: a local tarball was installed outside the workspace;
  contract, field mappings, exact key, profile and endpoint were customized, then
  analyzed and executed against a separate loopback HTTP service. TypeScript
  consumer imports and bundled schema availability passed.
- `npm run serve:docs`: rendered quickstart and code examples returned HTTP 200.
  Desktop and mobile playground screenshots were inspected.

The fixture recommends `scheduled-cache`, 60,000 ms cadence, a conservative
86,000 ms age envelope, and 0.98 usable-hit replay coverage. The synthetic
within-target hit assumption yields 0.9702 target success. These are estimates
under declared synthetic assumptions, not measured production traffic guarantees.
Input hash: `67f171929ac7196ac47bfedea59a131b3edfbdb6a834937cc7be9cf22bf203c4`.
Design hash: `0208b69c5676dd668ccc1536bfed07959a876848e085fc7929a1608b7e619291`.

The owner selected the MIT License for Plug on October 25, 2026. The repository
and reference package include the license; npm publication remains disabled.

## Remaining release steps

1. Owner configures a private security reporting route and actual maintainers.
2. Commit/push the reviewed implementation and connect the repository to Render
   using `render.yaml`. Supply `APP_ORIGIN` and verify the hosting proxy topology
   before setting `TRUST_PROXY_HOPS`. No Render API credential was available here.
3. On the host-provided domain, repeat streaming, real source/refresh, isolation,
   cancellation, per-IP and four-session-cap smoke checks. Record the deployed
   commit and public URL here. Free-tier cold starts remain a documented limitation.

The bootstrap SEP remains draft pending actual owner review. Multi-instance
operation, durable jobs/cache, restart continuity, unrestricted MCP/A2A execution
and customer endpoint execution in the hosted playground are outside this alpha.
The local continuous runner is explicitly selected by trusted application code;
hosted requests cannot extend the 120-second session lifetime. The production UI
bundle is about 125 KB gzip; Vite reports a raw minified chunk-size warning.
Five outside users and two own-system integrations are learning targets, not
claimed adoption.
