# Plug contributor instructions

Implement only the supported multi-system alpha described by the draft SEPs indexed
in seps/README.md; IMPLEMENTATION-v2.md is historical bootstrap context.
Public serialized types belong in schema/draft/schema.ts. Do not maintain duplicate
application schemas. Generate JSON Schema and reference docs with npm run generate.
Generated artifacts are committed: edit their source, regenerate, then npm run check.
Keep README.md as the current product and architecture map. Any change to public
features, CLI or MCP surfaces, supported protocols, model roles, safety boundaries,
the .plug layout, recommendation flow, or runtime topology must update README.md in
the same change. Keep its Mermaid diagrams synchronized with actual components,
data flow, authority boundaries and hosted-versus-local execution; remove stale
claims and counts instead of documenting planned behavior as implemented. Compare
README.md, RELEASE_NOTES.md, the package README and architecture docs before
finishing a major change.
Use Node 24 and npm ci. Run npm run build and npm run test:browser for UI changes.
Never weaken UX requirements, confuse warm-hit or local-probe latency with a traffic
SLO, infer cache permission from annotations, or invoke supplied endpoints during
hosted analysis. Local probes require explicit host authorization, run bounded safe
reads only, and preserve vantage, sample window and source timestamps. Unknown facts
stay unknown: each fact is declared, measured by an authorized probe, or unknown.
Synthetic and local-workbench observations are not production measurements.
Keep runtime bounds, cancellation and source timestamps intact. Do not publish until
license and hosting authorization are resolved. Follow seps/README.md for major changes
and keep its proposal index in sync with SEP frontmatter (see seps/AGENTS.md).
