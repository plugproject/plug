---
title: Agent exposure through MCP and a portable Agent Skill
status: draft
---

This proposal has no PR number, sponsor or approval. It extends the existing
workspace MCP surface and proposes a portable Plug Agent Skill. The expanded
server, packaged skill and installers are implemented; the proposal remains
draft pending owner review.

## Motivation

Plug's spec is most valuable when the coding agent implementing an integration
can read its requirements, proofs and tasks. The existing stdio MCP server
exposes analysis and the current bundle, but it cannot add and inspect a host,
verify an edge, review and adopt a design, or navigate revisions. Agents also
need concise procedural guidance that travels independently of one IDE's
extension format.

MCP should expose the bounded capabilities, while a portable Agent Skill teaches
the workflow and honesty rules. Neither artifact should introduce an agent
harness into Plug's runtime or grant an agent broader authority than the local
workbench.

## Specification

### Workspace MCP surface

`plug mcp` remains a stdio server for one resolved workspace and never listens
on a network port. Existing tools remain compatible. The server adds:

- `plug_add_system`, which carries the same add-host disclosure as the
  workbench and treats the confirmed call as authorization to inspect the
  host's exposed surface;
- `plug_probe`, for bounded inspection of an authorized host;
- `plug_verify_edge`, for bounded direct or selected-design verification;
- `plug_review_design`, for local model critique and typed judgments;
- `plug_adopt_design`, for explicit author-directed adoption after code
  re-verifies feasibility; and
- `plug_list_spec_revisions`, for immutable local history and optional
  read-only Git entries.

`plug_get_spec` can read a named revision in addition to the current bundle.
Resources add the current integration manifest and verification log alongside
the existing OpenSpec bundle resources.

Tool descriptions are part of the security boundary. Host-adding and probing
tools state before execution that adding the host authorizes inventory of
everything it exposes and invocation of only the read-safe subset. They repeat
that results are workbench-vantage evidence, never production measurements or
SLOs, and that cache permission remains declared.

Every long-running tool propagates MCP cancellation and has per-edge or
per-operation call, rate, concurrency, byte and wall-clock bounds. There is no
maximum system, operation or connection count, but no tool may turn that into
an unbounded batch. Each call re-reads the workspace so agents see author edits.

MCP does not bypass the product's authority split: the deterministic engine
decides feasibility, the LLM critiques, Jev returns atomic typed judgments, code
validates and resolves them, and the author directs adoption.

### Portable Agent Skill

The package includes a Plug skill with Agent Skills frontmatter and small
reference files for tools, honesty rules and OpenSpec handling. The skill tells
an agent to:

1. read the current spec and revision before changing an integration;
2. add and inspect a host only after presenting the disclosure;
3. connect systems and record the edge's business requirement;
4. analyze with the deterministic engine;
5. distinguish engine feasibility from workbench verification;
6. request bounded review, surface citations and ask the author to adopt;
7. implement the effective design's tasks; and
8. update the spec through Plug rather than hand-edit generated files.

The skill also states what an agent must not do: invoke write-capable
operations, infer read safety or cache permission from annotations, describe a
probe as production evidence, weaken requirements, treat a model as the
architect, edit revision history or ask Plug to commit.

`plug skill install --ide cursor|vscode|claude|generic` installs or emits a
project-scoped copy:

- Cursor: `.agents/skills/plug/`;
- VS Code: `.github/skills/plug/`;
- Claude: `.claude/skills/plug/`; and
- generic: prints or copies the portable directory without assuming an IDE
  runtime.

MCP installation continues to support Cursor, VS Code, Claude and generic
project-scoped configuration. Installers merge the `plug` entry, retain every
unrelated entry and refuse to rewrite a file they cannot parse.

Cursor, VS Code and Claude are distribution surfaces, not runtime dependencies.
Pi, Harbor and other agent or evaluation harnesses are not dependencies or
named targets. Generic skill and MCP output preserve portability without
promising support for an undeclared harness.

## Rationale

MCP carries typed actions and current workspace state; the skill carries
workflow knowledge and safety guidance. Keeping them separate lets any
MCP-capable agent call Plug while allowing an IDE that understands Agent Skills
to route relevant work correctly.

Stdio and project-scoped installation preserve the current local trust model.
Reusing Plug's guarded entry points keeps validation and provenance centralized
instead of teaching agents to edit canonical JSON or call integration points
directly.

## Compatibility

The five existing MCP tools and current resources keep their names and
semantics. New tools, optional revision arguments and resources are additive.
Older clients may ignore them. Each installer retains existing server and skill
configuration outside Plug's own entry.

Projects without an installed skill continue to use MCP directly. Projects
without MCP may still read `.plug/` and the portable skill, but mutation guidance
must direct them to the CLI or workbench. No user-level IDE configuration is
written.

## Alternatives

- Ship only MCP. Agents would have capabilities but no portable guidance about
  authorization, evidence and adoption.
- Ship only a skill. Text instructions cannot provide validated, cancellable
  workspace operations.
- Build separate IDE extensions. That duplicates behavior, narrows portability
  and creates several security surfaces.
- Expose network MCP from the workbench. A listening transport needs a separate
  authentication and authorization design.
- Embed an agent harness in Plug. Agents consume Plug; they are not part of its
  deterministic or verification runtime.

## Security implications

The MCP process inherits only the workspace and environment with which the
author starts it. Tool schemas are strict and size-bounded. Host authorization
is explicit in the add-system call, secrets are resolved locally and omitted
from results, and long operations honor cancellation. Read-only tool annotations
describe tools but never authorize remote operations.

Installers write only known project-relative destinations, reject traversal and
symbolic-link escapes, preserve unrelated configuration and use atomic writes.
Skill content is instructions, not executable code or additional authority. An
agent still cannot bypass host allowlists, read-safe eligibility, engine
feasibility or author adoption.

## Implementation

The expanded server and resources live in `packages/plug/src/mcp/server.ts`,
the installers and commands in `packages/plug/src/cli.ts`, and the portable
skill in `packages/plug/skill/plug/`. Package tests install each supported
project-scoped layout from the packed tarball.

## Validation

The
[MCP server tests](../tests/mcp-server.test.ts),
[local server tests](../tests/ui-server.test.ts) and package installation test
at `scripts/test-package.ts` prove:

- the tool and resource lists expose the complete additive surface;
- tool descriptions carry the host disclosure and evidence boundaries;
- cancellation and per-edge bounds reach probe, verification and review calls;
- no tool bypasses read-safe eligibility, deterministic feasibility or author
  adoption;
- current and historical resources are workspace-scoped and omit secrets;
- Cursor, VS Code and Claude installers merge valid project configuration,
  generic output is portable, and malformed files are untouched;
- the packaged skill has valid frontmatter, all references and the required
  honesty rules; and
- no Pi, Harbor or agent-harness runtime dependency or target is introduced.

This proposal remains draft pending owner review.
