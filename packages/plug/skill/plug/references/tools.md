# Plug MCP tools

Use the tools in this order when applicable:

- `plug_get_spec`: read the current, hash-pinned spec and concise connection
  results.
- `plug_add_system`: add reviewed system metadata. If `inspect` is true, first
  disclose that the added host will be inspected.
- `plug_probe`: run bounded local inspection for an authorized host or
  operation. It can call read-safe operations and write probed facts.
- `plug_update_spec`: validate, analyze, and atomically rewrite the OpenSpec
  bundle from exactly one DesignInput or workflow document.
- `plug_analyze`: analyze without writing.
- `plug_verify_edge`: demonstrate the direct or selected design path against an
  authorized local-workbench binding.
- `plug_review_design`: obtain a citation-gated critique and Jev judgments.
- `plug_adopt_design`: record the author's chosen, engine-verified
  architecture.
- `plug_explain`: render proofs, assumptions, unknowns, and tasks.
- `plug_index_workspace`: scan bounded local code/config metadata. It does not
  call supplied endpoints or establish operational facts.
- `plug_list_spec_revisions`: list content-addressed local revisions and
  read-only project-git history.

Long-running tools are cancellable and bounded. Surface a tool error as an
error; never reinterpret it as a negative fact or successful verification.
