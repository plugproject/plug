# OpenSpec bundle

`.plug/workflow.yaml` is the editable Open Workflow Specification and spec of
record. Its `document.metadata.plug.input` carries the canonical Plug input.

Plug regenerates:

- `.plug/design-input.json`: canonical input and evidence
- `.plug/design.json`: deterministic recommendations and proofs
- `.plug/design.md`: human-readable explanation and tasks
- `.plug/AGENTS.md`: concise implementation guidance

Local operational records include the manifest, probe and verification logs,
model-review log, and content-addressed revisions. Do not hand-edit generated
JSON or Markdown. Pass an edited workflow or a complete DesignInput to
`plug_update_spec`.

Every model-facing result and demonstration should carry the input, design, and
spec revision hashes it used. Treat a result as stale when those hashes differ.

To restore history, review a revision first, then pass its workflow back through
`plug_update_spec`. Plug may read project-git history for `.plug/workflow.yaml`,
but it never stages or commits files.
