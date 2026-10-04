# Plug reference package

Deterministic two-system design analysis and a bounded trusted-local HTTP runner.
Exports: `normalizeSystems`, `suggestDesign`, `explainDesign`, `runDemo`, canonical
types/validators, metadata importers, and bundled synthetic flight input.

CLI: `plug analyze input.json --out report`, `plug explain input.json`,
`plug demo input.json --endpoint http://127.0.0.1:4010/inventory`.
Build from the repository before `npm pack --workspace @plugproject/plug`.
Schema and validators are bundled; no repository files are required at runtime.
Publication and redistribution await owner license selection.
