---
title: Integration probing and measured facts
status: draft
---

This proposal has no PR number, sponsor or approval. It extends local discovery
into authorized measurement and changes the evidence model. The reference
implementation and regression coverage now exist; the proposal remains draft
pending owner review and calibration evidence.

## Motivation

The local workbench can inventory an OpenAPI document, an MCP tool list or an
A2A Agent Card, but inventory does not establish how an integration point
behaves. Authors must currently transcribe latency, availability, payload size
and similar facts, even when a bounded local observation could establish a
useful workbench-vantage measurement.

Calling arbitrary operations would be unsafe, and a few development-machine
requests cannot establish production behavior. Plug therefore needs a narrow
authorization event, a closed definition of read-safe inspection, provenance
that cannot be mistaken for an SLO, and a reversible way to apply a measurement
without losing the fact it replaces.

## Specification

### Authorization and locality

Adding a host is the authorization event. Before confirmation, every local
surface must disclose that Plug will inventory everything the host exposes,
invoke the read-safe subset from the author's machine, record requests and
responses within stated bounds, and apply supported measurements to the
OpenSpec. Confirmation authorizes that inspection for the host; it is not
inferred from a URL already present in an older document.

Inspection exists only in the local workbench, local CLI and workspace-scoped
stdio MCP server. Hosted analysis has no probe route, tool or fallback and
never contacts a supplied host.

### Read-safe inspection

Automatic inspection may perform only:

- HTTP `GET` and `HEAD`;
- the MCP initialization needed for `tools/list`, followed only by
  `tools/list` and session cleanup; and
- retrieval of an A2A Agent Card.

Any other HTTP method, MCP tool call, A2A message or protocol operation is
ineligible until the author explicitly marks that exact operation both `read`
and `idempotent`. Plug must not derive either property from a name,
description, OpenAPI annotation, MCP annotation or model judgment. Inventorying
everything a host exposes does not authorize invoking every listed operation.

Cache headers and read-only hints may be retained as static metadata. They
never grant cache permission. Cache permission remains an explicit author
declaration.

### Plug-owned bounded harness

Plug owns the probe harness as TypeScript in the reference package. Pi, Harbor
and other agent or evaluation harnesses are neither runtime dependencies nor
named integration targets.

There is no serialized maximum number of systems, operations or connections.
Each operation run remains bounded by a call budget, rate ceiling, concurrency
ceiling, per-call timeout, total wall-clock deadline, response-byte limit,
same-host redirect policy and cancellation signal. A rate-limit response stops
that operation rather than deliberately searching for the host's limit. Work
over many operations is scheduled through those bounds; removing graph-count
limits never creates an unbounded run.

Credentials are resolved only in the local process, sent only to the authorized
host under the redirect policy, and never written to the OpenSpec, manifest,
evidence or logs.

### Manifest and measured facts

The harness records bounded raw events and derives a content-addressed
integration manifest. Mechanical summaries may include latency distribution,
successes within the probe timeout, response sizes, status counts, rate-limit
headers, cache headers and changes actually observed during the window.
Absence of a change proves only that no change was observed during that window.

Jev may answer registered, atomic typed questions about bounded samples, such
as whether a response contains the described useful output, which candidate
field is a source snapshot timestamp, or whether an ambiguous body represents
a rate-limit error. Each answer records its exact state, question version,
resolved model and probability. Code applies fixed thresholds. A missing,
failed or unsettled judgment leaves the semantic fact unknown.

Probe-derived evidence uses a distinct `probed` kind and records at least the
manifest hash, local workbench vantage, measurement time, sample count and
window. It is never production evidence, a traffic percentile or an SLO.
Synthetic observations, including discovery fetch duration, remain synthetic
and are not promoted to probed facts.

Applying a manifest may overwrite an unknown, previously probed, declared or
observed value. The replacement evidence must preserve the complete previous
value and evidence, identify the conflict in the workbench, and offer one-click
restoration through OpenSpec revision history. The overwrite cannot silently
erase provenance. Requirements, workload, trust, cost, hard timeout and cache
permission remain declared or unknown unless a separate authoritative source
establishes them.

The deterministic engine consumes applied values under its ordinary rules.
The probe, completion model and Jev never decide feasibility or choose an
architecture.

## Rationale

Host addition is a comprehensible consent boundary and avoids repeated
per-request prompts while keeping inspection explicit. A closed read-safe
allowlist prevents descriptive metadata from becoming authority to cause side
effects. Building the harness in Plug keeps request bounds, cancellation,
evidence and hashing under the same deterministic contracts as the engine;
an agent loop would add nondeterminism without adding a required capability.

Allowing measurements to replace stale values makes inspection useful, while
preserving the displaced value, showing the conflict and restoring by revision
mitigate the risk that a development-machine observation replaces a better
production fact.

## Compatibility

Existing documents contain no `probed` evidence and continue to analyze as
before. New bindings, manifests and evidence are additive until an author
authorizes a host and a probe applies a value. Optional fields that are absent
must not change existing input hashes.

Existing stored endpoints are not retroactive authorization. Their authors
must confirm the disclosure before the first probe. Hosted behavior and the
existing parse-only import path remain unchanged. Removing collection maxima
widens accepted inputs; per-operation runtime bounds and cancellation remain
mandatory.

## Alternatives

- Keep all operational facts manual. This is safe but leaves Plug unable to
  test the integration points that motivate a design.
- Invoke every listed operation. Names and annotations do not establish safety,
  and this could create writes, messages, charges or duplicate effects.
- Review every measured value before applying it. This weakens automatic
  inspection; preserved evidence, conflict display and revision restore provide
  the chosen recovery boundary instead.
- Treat probe percentiles as production observations. The sample and vantage do
  not represent production traffic, so this would manufacture an SLO.
- Embed an agent harness. Probing has typed inputs, fixed operations and
  deterministic bounds; an open-ended agent loop is unnecessary.

## Security implications

The trust boundary expands only in the local process after the add-host
disclosure. The host allowlist is workspace-scoped. DNS resolution, redirects,
response streaming and decompression must remain inside explicit byte, origin
and time bounds. The runner stops on cancellation and rate limiting, never
retries a write, and renders returned text without executing it.

Probe samples may contain private data. Raw events and manifests stay under the
local `.plug/` workspace, must exclude credentials, and are never sent to a
completion provider. Jev receives only the bounded named state needed for its
question. Hosted services expose none of these capabilities.

## Implementation

The public contracts are in `schema/draft/schema.ts`. Planning, execution,
scrubbing, Jev questions, summaries, manifest persistence and application live
under `packages/plug/src/probe/`; local routes are in
`packages/plug/src/ui/server.ts`, CLI exposure is in `cli.ts`, and the workbench
surfaces are in `apps/playground/src/App.tsx`. Discovery remains parse/list-only;
probing starts only after the separate host disclosure and authorization.

## Calibration

On 2026-10-26, one live Jev 1.14.0 request exercised all five registered probe
questions over one scrubbed synthetic fare response and one synthetic HTTP 429.
It classified useful output at 0.98, selected `/capturedAt` as the source
snapshot field with companion probability 0.96, and classified the error as
`rate_limited` with companion probability 0.97. All expected outcomes crossed
the fixed 0.7 threshold. One fixture bundle is only a transport and wording
smoke test; it does not calibrate probabilities across real integrations and is
not a production measurement or SLO.

## Validation

The
[discovery tests](../tests/discovery.test.ts),
[local server tests](../tests/ui-server.test.ts) and
[browser suite](../tests/browser/playground.spec.ts) prove:

- hosted analysis has no probe capability or outbound request;
- only the authorized host and read-safe operations are invoked;
- limits, cancellation, redirects, response caps and first-429 stopping work;
- secrets do not enter persisted events, manifests or evidence;
- every measured fact states its vantage, sample and window and is never
  presented as production or an SLO;
- cache permission is never inferred;
- an overwritten value remains in evidence, shows a conflict and can be
  restored in one action; and
- large graphs have no count maximum while each operation remains bounded.

This proposal remains draft pending owner review and broader calibration against
author-controlled integration fixtures.
