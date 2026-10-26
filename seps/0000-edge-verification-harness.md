---
title: Edge verification harness
status: draft
---

This proposal has no PR number, sponsor or approval. It proposes local
demonstration of an edge and its selected design. The reference harness and
surfaces are implemented; the proposal remains draft pending owner review.

## Motivation

Plug's deterministic engine can decide whether declared and measured facts make
an edge feasible as-is, conditional, insufficiently known or in need of a
system design. That proof is not the same as exercising an authorized
integration point. Authors also need to see whether a bounded run from their
workbench delivered the required useful output in time, and whether a runnable
candidate changed that result.

Without a separate verification record, a demo can be mistaken for feasibility
logic or, worse, for a production SLO. Verification therefore needs its own
typed result, exact input and revision pins, and a strict division of authority
between deterministic analysis, measured execution and semantic judgment.

## Specification

### Per-edge verification

For one connection and its declared business requirement, the local workbench
may verify:

1. the direct or **as-is** path; and
2. a selected or author-adopted architecture that Plug can execute.

Every run pins the connection, canonical input hash, design hash, catalog
version, OpenSpec revision and exact runner configuration. A changed input,
requirement, binding, manifest, design or revision makes the record stale; Plug
does not silently reuse it.

The deterministic engine remains the sole authority on feasibility and the
architecture frontier. Verification produces only `demonstrated`,
`not_demonstrated` or `inconclusive` for the stated bounded run. A demonstration
cannot turn a failed hard requirement into a feasible design, and a failed run
cannot prove that no feasible implementation exists.

### Plug-owned bounded harness

Probe and verification execution share a Plug-owned TypeScript harness with
typed adapters. Plug does not embed, depend on or name Pi, Harbor or another
agent harness. A protocol adapter renders the authorized request binding,
resolves local secret references at call time, validates and bounds the
response, and maps it into the runner's normalized result without changing its
source timestamp.

Verification is local-only. The hosted playground remains limited to
server-owned fixtures and never executes a supplied endpoint or binding.

There is no maximum number of connections, systems or operations in the
serialized model. Verification is scheduled per edge. Each edge keeps call,
rate, concurrency, response-size and wall-clock bounds, propagates
cancellation, and stops on a rate-limit response. Bulk verification cannot
multiply those into an unbounded request queue.

The harness may invoke only a host already authorized for inspection and only
an operation eligible under the read-safe policy: HTTP `GET` or `HEAD`, MCP
`tools/list`, an A2A Agent Card, or another exact operation explicitly marked
both read and idempotent. A design that requires an ineligible call is
non-executable here and yields an explanation rather than an invocation.

### Verification record

A `VerificationRecord` includes:

- mode, edge, input, design and revision pins;
- workbench vantage, start and end time, sample count and workload scope;
- requested useful output, latency/freshness requirement and any traffic scope;
- response status and timing summaries, target-hit fraction and relevant age
  measurements;
- the architecture and configuration actually exercised;
- semantic judgments used, with question version, model and probability;
- terminal status, cancellation or bound that ended the run; and
- the `demonstrated`, `not_demonstrated` or `inconclusive` result with
  code-produced reasons.

Jev may answer one registered atomic typed question about whether a bounded
delivered sample is the useful output the edge requires. Code validates the
answer, applies fixed thresholds and computes the record. Jev does not choose a
design, alter the requirement, aggregate latency or declare feasibility. If the
judgment is unavailable or unsettled, output usefulness stays unknown and the
run is inconclusive where that fact is required.

The UI, report, OpenSpec guide and MCP result must label every record
**workbench-vantage demonstration, not a production measurement or SLO**.
Observed target hits are not extrapolated to traffic percentiles, and component
percentiles are never summed into an end-to-end percentile.

## Rationale

Separating engine proof from execution preserves both forms of evidence. The
engine can explain what follows from the facts, while the harness can show what
happened in a bounded trial. Pinning both to the same revision lets an author
compare them without implying that one substitutes for the other.

A typed in-package harness is sufficient because request admission, adapters,
timers, event traces and verdict calculation are deterministic programs. Jev is
useful only for the narrow natural-language question of whether the returned
sample satisfies the requested output meaning.

## Compatibility

Existing designs and OpenSpec documents have no verification records and
continue to analyze unchanged. Verification records are additive workspace
artifacts and optional report references. Their absence means “not verified,”
not failure.

The existing bundled fixture runner remains supported through its adapter.
Locally authorized bindings add a new adapter without making arbitrary remote
execution available to hosted analysis. Removing graph count maxima widens
input acceptance; all existing per-run resource bounds remain.

## Alternatives

- Use probe latency as verification. A probe characterizes an operation; it
  does not execute the complete edge or a proposed architecture.
- Let a model decide whether the edge works. That would replace reproducible
  criteria with an untestable opinion.
- Treat one successful run as an SLO. A bounded local sample has neither the
  production vantage nor representative traffic.
- Execute write paths in a sandbox. A sandbox around Plug does not remove side
  effects at the remote host.
- Adopt an external agent or evaluation harness. The required behavior is
  typed and bounded and belongs beside Plug's existing runtime.

## Security implications

Verification inherits host authorization, read-safe eligibility and secret
handling from probing. It never broadens permission because an architecture
contains a call. Redirects, bytes, deadlines, concurrency and request rate are
bounded; late responses are ignored after cancellation; every resource is
released once.

Returned content is untrusted data. Response mappings cannot execute
expressions, follow remote references or select a new host. Records and traces
stay local and omit credentials. A rate-limit response halts the edge run
instead of triggering retries.

## Implementation

`packages/plug/src/verify/index.ts` implements direct and selected-design
verification and bounded JSONL records. `packages/plug/src/demo/source-adapters.ts`
provides the fixture-envelope and authorized REST adapters used by the bounded
runtime. The deterministic planner, OpenSpec bundle, local routes, CLI, MCP and
workbench surfaces carry the resulting pins and honesty labels.

## Validation

The
[runtime tests](../tests/runtime.test.ts),
[real HTTP tests](../tests/real-http.test.ts),
[planner tests](../tests/planner.test.ts),
[local server tests](../tests/ui-server.test.ts) and
[browser suite](../tests/browser/playground.spec.ts) prove:

- the direct and design modes pin and report the exact edge and revision;
- only authorized read-safe operations execute, with no hosted counterpart;
- every timeout, byte, rate, concurrency and cancellation bound is enforced;
- stale records are detected after any relevant input or design change;
- code, not a model, computes the terminal result and never weakens a
  requirement;
- an absent or uncertain Jev answer remains unknown;
- measurements retain source timestamps and the workbench-vantage label; and
- many edges can be modeled without a count cap while each verification stays
  independently bounded.

This proposal remains draft pending owner review and trials against additional
author-controlled REST contracts.
