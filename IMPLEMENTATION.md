# Implementation status

The controlling proposals are the draft SEPs indexed in
[seps/README.md](seps/README.md). [IMPLEMENTATION-v2.md](IMPLEMENTATION-v2.md)
is historical bootstrap context.

Implemented: canonical TypeScript contracts and generated AJV schema/reference;
multi-system workflow graphs; deterministic relation and bounded composition
planning; authorized HTTP, MCP and A2A discovery/probing; edge verification;
citation-gated review and author adoption; OpenSpec interchange, retained revisions
and read-only Git restore; the local workbench; workspace-scoped MCP tools and
resources; a packaged agent skill; CLI and package surfaces; runnable local
examples; guided optional-provider environment setup for CLI and SDK consumers;
and schema/docs/SEP workflows.

Node 24 verification passed: 217 implementation tests, 25 production-browser
tests, build, generation/docs checks and packed-package customization. Detailed
evidence and remaining release steps are recorded in
[RELEASE_NOTES.md](RELEASE_NOTES.md).
No live URL, production SLO, licensed public distribution, outside-user adoption,
or approval of any draft SEP is implied by this implementation.
