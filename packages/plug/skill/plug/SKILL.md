---
name: plug
description: >
  Uses Plug to inspect integration points, define caller-to-downstream business
  requirements, analyze feasible system designs, run bounded local
  demonstrations, review recommendations, and keep the OpenSpec bundle current.
  Use when adding or changing an external system, API, MCP server, A2A agent,
  connection, cache, scheduler, retry, queue, timeout, quota, or integration
  architecture in a project that exposes the Plug MCP server.
---

# Work with Plug

Treat `.plug/workflow.yaml` as the integration spec of record. Use Plug's MCP
tools instead of editing generated JSON or Markdown.

## Workflow

1. Call `plug_get_spec`. If there is no spec, add or import systems before
   connecting them.
2. Before adding a host, tell the user that Plug will inspect everything the
   host exposes. Inspection is local, bounded, and limited to read-safe
   operations unless the author explicitly marks another operation read-only
   and idempotent.
3. Call `plug_add_system` or `plug_probe` only after that disclosure. Never
   obtain credentials from prose or write credential values into the spec.
4. Connect caller and downstream operations and encode the edge's useful
   output, latency, freshness, correctness, availability, workload, mappings,
   and priorities. Unknown facts stay unknown.
5. Call `plug_analyze`. Read hard failures, unknowns, assumptions, frontier
   trade-offs, and cross-connection criteria before discussing a design.
6. When execution is authorized, call `plug_verify_edge`. Describe its result
   as a bounded workbench demonstration, never a production SLO.
7. Call `plug_review_design` only when model review is useful. The LLM
   critiques, Jev supplies typed judgments, code decides, and the deterministic
   engine remains the authority on feasibility.
8. Ask the author before `plug_adopt_design`. Adoption is a policy decision,
   not a model fact.
9. Use `plug_update_spec` after integration changes. Re-read the spec and use
   `plug_list_spec_revisions` when a previous version must be reviewed or
   restored.
10. Implement the effective design's tasks, then update and re-analyze the spec
    when code changes the integration.

## Required reading

- Read [references/tools.md](references/tools.md) before invoking Plug tools.
- Read [references/honesty.md](references/honesty.md) before interpreting
  probes, demonstrations, model judgments, or unknowns.
- Read [references/openspec.md](references/openspec.md) before editing or
  restoring the OpenSpec bundle.
