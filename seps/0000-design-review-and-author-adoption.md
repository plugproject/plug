---
title: Design review and author adoption
status: draft
---

This proposal has no PR number, sponsor or approval. It proposes a local review
and adoption layer over deterministic recommendations. The reference layer and
regression evaluation exist; the proposal remains draft pending owner review
and live calibration.

## Motivation

Plug can derive a feasible frontier and explain its proofs, but feasibility does
not settle every engineering choice. An author may need a critique of operational
complexity, migration risk or evidence gaps, and may deliberately prefer a
different feasible frontier member. A language model can surface concerns in
natural language, but it must not become an architect whose prose overrides
hard requirements.

The missing boundary is an explicit review pipeline: an LLM critiques a bounded
report, Jev answers atomic typed questions about the critique, code resolves
citations and rechecks feasibility, and only the author adopts a design into
the OpenSpec.

## Specification

### Division of authority

The deterministic engine owns relation facts, pattern applicability,
obligation closure, feasibility, trade-off vectors, dominance and the frontier.
Neither a completion model nor Jev runs inside `suggestDesign`, changes a hard
requirement or turns an infeasible architecture into a feasible one.

A configured completion model is a critic. It receives a bounded, scrubbed
review basis for one edge: the engine shortlist and proofs, relation facts,
criteria, estimates, missing information, a manifest summary, the latest
non-stale verification summary and bounded author context. It does not receive
credentials, endpoints, raw probe payloads, the full workspace or executable
tools.

The critic returns a strict typed document whose claims cite a closed set of
report locations. Code rejects unknown fields, bounds all text and collections,
and drops every claim whose citation cannot be resolved exactly against the
review basis.

Jev receives named, bounded state and registered atomic typed questions. Nouls
judge individual concerns or claimed conflicts; a Choice may compare only the
engine-supplied shortlist and is paired with a Noul that asks whether any listed
choice is supportable. Every question records its version, exact state, model
and probability. Jev does not draft prose, invent an architecture or make the
adoption decision.

Code applies fixed thresholds and a documented truth table, verifies every
suggested alternative through the deterministic engine, and abstains when the
evidence does not support a choice. A Jev failure is an error, not a negative
answer. Without Jev, a critique may be displayed as unverified but cannot confer
additional evidence on an alternative.

### Review and staleness

A review is pinned to the input hash, design hash, catalog version, connection
and OpenSpec revision. Any change to those values, the manifest or the
verification basis marks it stale and disables adoption from that review.
Review runs only in the local workbench, local CLI or workspace stdio MCP
server. The hosted playground has no review or model route.

There is no maximum number of connections, systems or operations. Review is
per edge and sends only a bounded shortlist and report slice. Deadlines,
cancellation, provider response bytes and question counts remain bounded for
every review.

### Author adoption

Adoption is a distinct, undoable author action. It records the exact
architecture or pattern set, input and design hashes, catalog version, revision,
review hash, critic model, applicable Jev judgments and declared author
evidence. The model is never recorded as the declaring party.

Before honoring an adoption, code re-evaluates the architecture with the same
catalog and rules used by the engine. The engine's default selection remains
visible. The adopted architecture becomes the effective design only while it is
known, feasible and valid for the current catalog and input. The report exposes
at least:

- `honored`;
- `dominated`;
- `not_feasible`;
- `unknown_architecture`; and
- `catalog_changed`.

A dominated, non-feasible or unknown choice may not be newly adopted. An
existing pin that becomes dominated remains visible with that status and is not
the effective design. Clearing an adoption is explicit. Adoption and clearing
write new OpenSpec revisions so either action can be restored.

## Rationale

This is a propose–verify–adopt split. Natural-language critique is useful for
finding omissions and explaining trade-offs, calibrated typed judgment is
useful for checking one semantic claim at a time, and deterministic code is
suited to citations, feasibility and state transitions. Keeping the final
choice with the author preserves accountability.

Showing both the engine default and effective adopted design prevents
preference from masquerading as objective selection. Rechecking adoption on
every analysis prevents a stale model review from pinning a design after its
facts or catalog have changed.

## Compatibility

Existing inputs contain no adoption and retain the deterministic engine
selection. New review logs, evidence and adoption fields are additive. Optional
fields that are absent must leave current input and design hashes unchanged.

Clients unaware of adoption may continue to display the engine-selected
architecture. Updated clients must distinguish engine selection, review
recommendation and effective author adoption. Existing judged semantic evidence
keeps its meaning; design review does not broaden what a judgment may establish.

## Alternatives

- Let the LLM choose the architecture. Its result would not be reproducible or
  constrained by Plug's obligation closure.
- Let Jev rank whole designs in one prompt. A broad judgment is harder to
  calibrate and cannot replace per-claim evidence and deterministic checks.
- Auto-adopt a high-confidence answer. Probability is not authorization, and
  architectural trade-offs remain the author's decision.
- Permit adoption of any named stack. That would let preference bypass known
  infeasibility and hard requirements.
- Omit the critic and show only the frontier. This remains a supported path,
  but it does not provide the requested independent review.

## Security implications

Model input is minimized and scrubbed. It excludes request bindings, secrets,
raw samples and workspace files. Model output is untrusted data: strict parsing,
closed citations, bounded rendering and deterministic re-evaluation are
mandatory. Provider keys stay local and are never logged.

Review, judgment and adoption routes are loopback and same-origin in the local
workbench; the MCP transport is workspace-scoped stdio. Cancellation and
deadlines propagate to providers. A review cannot invoke a host, mutate
implementation files or grant probe permission.

## Implementation

The bounded review slice, strict parser, citation gate, providers, truth table
and Jev integration live under `packages/plug/src/review/`. Deterministic
re-verification lives in `packages/plug/src/recommender/planner.ts`; canonical
pin/clear mutations are in `packages/plug/src/adoption/`. The local route, MCP,
OpenSpec propagation and workbench component expose the same authority split.

## Calibration

On 2026-10-26, one live trial over each of the five scrubbed fixture cases
produced pass@1 1.0, engine agreement 1.0, abstention 0.2, critic disagreement
0, and zero claims dropped by the citation gate. Jev processed 8,734 input
tokens (estimated Jev cost USD 0.00036683); completion-provider cost was not
available. All 25 surfaced concerns remained unsettled, so this small run
supports the conservative abstention path but does not calibrate concern
resolution. The JSONL record is under `.plug/evals/`; these synthetic review
cases are evaluation evidence, not production measurements or an SLO.

## Validation

The
[judgment tests](../tests/judgment.test.ts),
[planner tests](../tests/planner.test.ts),
[recommender tests](../tests/recommender.test.ts),
[local server tests](../tests/ui-server.test.ts),
[MCP tests](../tests/mcp-server.test.ts) and
[browser suite](../tests/browser/playground.spec.ts) prove:

- malformed model output and unresolved citations cannot affect adoption;
- each Jev question is atomic, typed, versioned and thresholded by code;
- provider failure, uncertainty and abstention remain explicit;
- every alternative is re-evaluated by the deterministic engine;
- requirements and infeasibility cannot be overridden;
- adoption is author-initiated, revision-pinned, undoable and stale when its
  basis changes;
- the engine default and effective adopted design remain distinguishable; and
- review remains local, bounded per edge and absent from hosted analysis.

This proposal remains draft pending owner review and recorded calibration
findings below.
