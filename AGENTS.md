# Plug contributor instructions

Implement only the supported two-system alpha described in IMPLEMENTATION-v2.md.
Public serialized types belong in schema/draft/schema.ts. Do not maintain duplicate
application schemas. Generate JSON Schema and reference docs with npm run generate.
Generated artifacts are committed: edit their source, regenerate, then npm run check.
Use Node 24 and npm ci. Run npm run build and npm run test:browser for UI changes.
Never weaken UX requirements, confuse warm-hit latency with a traffic SLO, infer cache
permission from annotations, or invoke supplied endpoints during hosted analysis.
Unknown facts stay unknown. Synthetic observations are not production measurements.
Keep runtime bounds, cancellation and source timestamps intact. Do not publish until
license and hosting authorization are resolved. Follow seps/README.md for major changes.
