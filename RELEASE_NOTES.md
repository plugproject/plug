# Plug 0.2.0-alpha.1 — local workbench, multi-system inference and workflow graph

Implements draft [SEP-0000: local workbench](seps/0000-local-workbench-and-multi-system.md),
[SEP-0000: workflow graph](seps/0000-workflow-graph-and-openspec.md) and
[SEP-0000: local MCP and A2A discovery](seps/0000-local-mcp-a2a-discovery.md). Verified
locally on 2026-10-05 using **Node 25.9.0**; Node 24 was not available on the
verification host, so the Node 24 run remains outstanding. Public URL: **not
deployed**. Release commit: **not assigned**. No production SLO or adoption claims
are made.

## Implemented

- `0.2-alpha.1` contracts: two to eight systems, one to twelve connections with their
  own profile, workload and experience, optional goal fields and priorities,
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
  message), within time, size, page and same-origin redirect bounds, and imports up
  to four chosen ones through the metadata importers. Headers are never stored,
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
  the workbench flags and reopens a workflow edited outside Plug.
- `plug mcp`: stdio MCP server with `plug_get_spec`, `plug_update_spec`,
  `plug_analyze`, `plug_index_workspace` and `plug_explain` and `plug://spec/`
  resources; `plug mcp install` registers it in project-scoped Cursor, VS Code or
  Claude Code configuration.

## Verified

- `npm run check`: TypeScript, ESLint, formatting, generated-artifact drift,
  examples, documentation links/SEP metadata, and **110 passing tests**, including
  workflow interchange, an MCP client talking to `plug mcp` over stdio, and
  discovery against local MCP and A2A fixture servers: pagination, refused and
  cross-origin redirected requests, size, page and time bounds, cancellation, and
  headers that never reach the result or the workspace.
- `npm run build`: reference package with packaged UI, declarations, schema,
  service and UI build.
- Browser suite, development and production (`npm start`) servers: **15 passing
  Chromium tests** each, run with `PLUG_TEST_PORT=3107` and `3111` because port 3000
  was occupied by an unrelated process. The full-speed proof again observed real
  warmup, a cache hit, a changed version after the later refresh, expiry and
  cancellation. The graph tests dragged a + onto an operation and onto empty canvas,
  connected clicked operations in Add connection mode, removed operations,
  connections and every system with undo and listed draft gaps, deleted by keyboard,
  round-tripped a downloaded workflow and reviewed a foreign one. In the packaged
  workbench they wrote and reopened an edited `.plug/workflow.yaml` and listed MCP
  tools and A2A skills from local fixture servers without keeping headers.
- `npm run test:package`: the tarball installed outside the workspace analyzed and
  executed a customized input, indexed a directory, served the workbench UI and
  workspace endpoints, wrote the `.plug/` bundle, registered the Cursor MCP entry
  and answered an MCP handshake from the packed `plug mcp`.
- The workbench indexed this repository in a browser and reported a stale index
  after source changes.

The fixture still selects `scheduled-cache` (architecture `scheduled-cache`,
dominating `scheduled-cache-aside`) with unchanged seed estimates. Catalog
`0.2-alpha.1/catalog-1+knowledge-1`.
Input hash: `2e32f278a75589d75f0e6dbce30895e1c22619563a1f92e54efd87aa48aaa98d`.
Design hash: `19667d19c6f9148485d3db4eb98bba6c41b2a228270de53b00ebce415696ba3d`.
The initial production UI bundle is about 154 KB gzip; the graph editor and ELK
layout load on demand as a further 510 KB gzip chunk.

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

## Remaining release steps

1. Owner chooses a distribution license. Until then the package remains private
   and UNLICENSED; no open-source or public npm publication is claimed.
2. Owner configures a private security reporting route and actual maintainers.
3. Commit/push the reviewed implementation and connect the repository to Render
   using `render.yaml`. Supply `APP_ORIGIN` and verify the hosting proxy topology
   before setting `TRUST_PROXY_HOPS`. No Render API credential was available here.
4. On the host-provided domain, repeat streaming, real source/refresh, isolation,
   cancellation, per-IP and four-session-cap smoke checks. Record the deployed
   commit and public URL here. Free-tier cold starts remain a documented limitation.

The bootstrap SEP remains draft pending actual owner review. Multi-instance
operation, durable jobs/cache, restart continuity, authenticated MCP/A2A execution
and customer endpoint execution in the hosted playground are outside this alpha.
The local continuous runner is explicitly selected by trusted application code;
hosted requests cannot extend the 120-second session lifetime. The production UI
bundle is about 125 KB gzip; Vite reports a raw minified chunk-size warning.
Five outside users and two own-system integrations are learning targets, not
claimed adoption.
