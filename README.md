# Plug

**Your systems + operational facts + required experience → explainable system design.**

Describe two to eight systems and up to twelve connections between them. For each
connection Plug evaluates six seed designs (direct, cache-aside, scheduled
refresh/prefetch, progressive response and two compositions), derives three-valued
relation facts, applies a pattern knowledge base and composes architectures that
close every problem and obligation. It ranks a Pareto frontier by your priorities,
with a proof for each architecture. Analysis is deterministic and never invokes
endpoints.

## Local workbench

```sh
npx plug ui            # http://127.0.0.1:4319, loopback only
npx plug index . --out workspace-index.json
```

The workbench offers to index the current project. Indexing is a bounded local scan
of OpenAPI documents, Agent Cards, package manifests and source markers; it skips
secrets, dependencies and symbolic links, and lists the operational facts Plug still
needs. The drafted system is used only after you review and adopt it.

The design is edited as a workflow graph: systems are groups, operations are nodes
and every edge is a connection with its own experience and priorities. Hover an
operation and drag its **+** onto another operation to connect them; anything can be
removed, and undo restores it. For an MCP server or A2A agent, enter its URL and the
workbench lists its tools or skills without calling them; request headers are used
once and never saved. Download or upload the graph as an
[Open Workflow Specification](https://open-workflow-specification.org/) document. To
hand the result to your coding agent:

```sh
npx plug spec input.json             # writes .plug/workflow.yaml, design.json, design.md, AGENTS.md
npx plug mcp install --ide cursor    # or vscode, claude, generic
```

The agent reads the spec of record and updates it through the `plug mcp` stdio
server, which validates and re-analyzes every change.

## Run locally

Use Node 24 (`nvm use`), then:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. The development server stays running until Ctrl-C.
The flight example uses a real 15-second HTTP source. Scheduled caching can provide
eligible indicative options quickly; the source remains slow. A 60-second refresh
runs inside a bounded 120-second session. No booking or payment execution is included.

```sh
npm run check
npm run build
npm run test:browser
npm start
```

`npm start` stays running and serves the production UI and API on port 3000 or `PORT`.
Install the Chromium test browser once with `npx playwright install chromium`.

- [Quickstart and custom HTTP adoption](docs/docs/quickstart.mdx)
- [Current draft specification](docs/specification/draft/index.mdx)
- [Canonical contracts](schema/draft/schema.ts) / [reference package](packages/plug/src/index.ts)
- [Deployment](docs/development/deployment.mdx)
- [SEP process](seps/README.md) /
  [SEP-0000: local workbench and multi-system inference](seps/0000-local-workbench-and-multi-system.md) /
  [SEP-0000: workflow graph, OpenSpec and IDE integration](seps/0000-workflow-graph-and-openspec.md) /
  [SEP-0000: local MCP and A2A discovery](seps/0000-local-mcp-a2a-discovery.md)
- [Implementation status](IMPLEMENTATION.md)
- [Feedback / bugs](https://github.com/plugproject/plug/issues)

## Scope and limitations

Manual JSON/YAML, MCP tools/list (2025-11-25) and A2A Agent Cards (1.0) are supported
for metadata intake, and the local workbench can list them from a running server. Imports
preserve unknown metadata and schema dialects. Schemas,
mappings, QoS, scope and cache permission may still need author input. Hosted execution
is limited to the bundled synthetic fixture; trusted loopback HTTP is available locally.

Coverage replay is synthetic, specific to each exact policy, and assumes successful
bounded calls. Warm-hit point estimates do not establish a production p95. A few demo
runs do not validate an SLO. Composed architectures are design output; only seed
designs run here. Global patterns (backend for frontend, message bus and similar)
are reported as needing global context. No durable cache, distributed scheduler,
restart recovery, OAuth sign-in for discovery, arbitrary expression evaluation, or
model-assisted extraction.

**Release status:** no public deployment or public URL has been verified. Distribution
license awaits owner choice; this repository is not yet claimed as open source and npm
publication is disabled. See [release notes](RELEASE_NOTES.md).

The repository adapts the specification/schema/docs/SEP organization of
[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol).
It does not inherit that project's governance, ownership or approvals.
