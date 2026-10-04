# Plug

**Two systems + operational facts + required experience → explainable system design.**

Plug evaluates a direct baseline, cache-aside, scheduled refresh/prefetch, progressive
response, and two bounded compositions. A deterministic recommender reports why each
candidate passes, fails or needs evidence. It never invokes endpoints during analysis.

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
- [SEP process](seps/README.md)
- [Implementation status](IMPLEMENTATION.md)
- [Feedback / bugs](https://github.com/plugproject/plug/issues)

## Scope and limitations

Manual JSON/YAML, MCP tools/list (2025-11-25) and A2A Agent Cards (1.0) are supported
for metadata intake. Imports preserve unknown metadata and schema dialects. Schemas,
mappings, QoS, scope and cache permission may still need author input. Hosted execution
is limited to the bundled synthetic fixture; trusted loopback HTTP is available locally.

Coverage replay is synthetic, specific to each exact policy, and assumes successful
bounded calls. Warm-hit point estimates do not establish a production p95. A few demo
runs do not validate an SLO. No durable cache, distributed scheduler, restart recovery,
authenticated discovery, arbitrary expression evaluation, or general graph synthesis.

**Release status:** no public deployment or public URL has been verified. Distribution
license awaits owner choice; this repository is not yet claimed as open source and npm
publication is disabled. See [release notes](RELEASE_NOTES.md).

The repository adapts the specification/schema/docs/SEP organization of
[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol).
It does not inherit that project's governance, ownership or approvals.
