---
title: OpenAPI intake and complete fact editing in the workbench
status: draft
---

This proposal has no PR number, sponsor or approval yet. It builds on the local
discovery and workflow graph proposals and does not change the serialized
format: every field it surfaces already exists in the draft schema.

## Motivation

Dogfooding the workbench against a real four-service project (two HTTP
services, one MCP server, one A2A agent) showed that a plain HTTP downstream —
the most common kind of system — was the one Plug could not take in, and that
most relation facts could not be declared without hand-editing JSON:

- MCP tools and A2A skills could be listed from a URL; a REST service's OpenAPI
  document could not. Its operations and schemas had to be typed by hand, and
  the inspector offers no schema editor, so `contractCompatible` could never be
  established for an HTTP system described in the UI.
- A system drafted by `plug index` attaches its operations to the interface it
  _exposes_. `protocolCompatible` read only the caller operation's own
  interface, so every connection from an indexed caller was reported
  protocol-incompatible even when the system declared a matching `calls`
  interface. The adopted draft of the very project being analyzed could never
  reach a compatible verdict.
- The indexer dropped each OpenAPI operation's method and path, so an exported
  workflow task fell back to `post` against the bare endpoint instead of the
  real call.
- The inspector could not declare: workload request rate or key count
  (capacity verdicts), downstream availability, concurrency, response size,
  call cost, source timestamp, source lag or invalidation (age semantics),
  any remaining-path overhead (the live-path estimate stayed unknown, so the
  deadline and first-response verdicts stayed unknown), the final deadline,
  lost-request tolerance, field mappings (contract verdict), operation output
  meaning, scope, key dimensions, keys-complete, idempotency-key support or
  live-validation requirement, a system's trust domain (trust-boundary verdict)
  or message-channel semantics, or the infrastructure numbers.

## Specification

### OpenAPI discovery and import

`POST /api/discover` accepts `protocol: "http"` with the URL of one OpenAPI
document. The workbench GETs that URL under the existing discovery rules (same
single 15-second deadline, 1 MB response cap, up to three same-origin
redirects, headers used once and never kept, URLs kept without credentials,
query or fragment), parses JSON or YAML (alias expansion disabled), and
requires `openapi` (or `swagger`) and `paths`. It never calls an operation.

The result carries the document URL, `info.title`/`info.version`, the
document's version string, the first `servers` entry resolved against the
document URL (per OpenAPI, a missing `servers` means `/`, which resolves to the
document origin) kept as the interface endpoint when it is http(s), and the
drafted operations in path order, capped at 500 with `complete: false` beyond
that. Operation drafting is shared with the indexer: id from `operationId` (or
`method-path`), summary as description, effect from the HTTP method (`get`/
`head` read, `post` unknown, others write), `idempotencyKeySupported: true`
when an `Idempotency-Key` header parameter is declared, inline
`application/json` request/response schemas without `$ref`, and — new — an
input schema synthesized from `query` and `path` parameters that carry inline
schemas when there is no request body, with `path` and `required` parameters
listed as required.

Each drafted operation keeps `{ method, path }` under `metadata.http`.

The inspector shows the server panel for every exposing system: MCP endpoint,
agent URL, or OpenAPI document URL. For HTTP systems the typed URL is
provenance, not the endpoint: applying a discovery sets the interface endpoint
from the resolved `servers` entry, and the document URL is kept under
`metadata.discovery` for the next visit. Applying passes the chosen operations
through a new `openApiSystem` importer (symmetric to `importMcp`/`importA2a`):
the chosen operations, the standard QoS gaps, dialect review of each schema,
`metadataUnderstood` only for OpenAPI 3.x, and a gap when no absolute server
URL exists. The metadata panel accepts a pasted or uploaded OpenAPI document
(`importDescription(text, 'openapi')`), so the hosted playground, which never
contacts servers, takes the same facts by paste.

### Caller capability in protocol compatibility

`protocolCompatible` holds when the downstream interface is exposed and the
caller can call it: the caller operation's own interface matches as before, or
any interface of the caller system with `direction: "calls"` and the same
protocol, version and binding. The fact's reason names the matching interface
when it is not the operation's own, and states that no caller interface
matches when the fact is false. `livePathMs` inherits the widened check for
its adapter term. The catalog version is bumped (`catalog-2`) because the same
input can now produce different verdicts.

### Method and path through export

The indexer no longer strips the drafted `metadata.http`. The Open Workflow
Specification exporter uses it for HTTP tasks: the task method is the declared
method, and when the interface has an endpoint the task endpoint is the
endpoint joined with the declared path (template braces kept verbatim).
Without `metadata.http` the previous fallback (`get` for reads, else `post`,
bare endpoint) is unchanged. Re-import keeps the metadata through the embedded
canonical input, so the round trip stays lossless.

### Inspector fact coverage

The inspector declares every input the relation derivation reads, always
through the existing editing chokepoint, with explicit unknowns preserved:

- Connection — workload: requests/minute, burst/minute, hot-key ceiling,
  distinct keys. Downstream behavior: source latency, hard timeout, change
  interval, upstream calls/minute, concurrency, availability, response bytes,
  call cost, source lag, source timestamp, invalidation signal, source cache
  permission. Caller path: agent/model, network, mapping, rendering, cache
  lookup, delivery allowance. Experience: adds final deadline and
  lost-request tolerance. Field mappings: input and output mapping rows with
  property-name suggestions drawn from the structured contracts.
- Operation — adds idempotency-key support, output meaning, sharing scope,
  key dimensions, keys-complete and requires-live-validation.
- System — adds trust domain and message-channel semantics (delivery,
  ordering, durability, dead-letter queue; "not declared" removes the
  channel).
- Shared infrastructure — adds cache capacity, cache memory, refresh
  concurrency, foreground reserve, scheduling allowance and call budget.

Numeric facts entered here carry `declared` evidence, as the existing fields
do; clearing one records an explicit unknown. No annotation is promoted to a
verified fact: imported OpenAPI semantics remain hints with `static` evidence
and the standard gaps.

## Rationale

- OpenAPI is read at a URL the author supplies, exactly like MCP and A2A, and
  under the same transport rules, because a REST downstream is the common case
  and its document is the only machine-readable contract most services have.
- The caller-capability check matches the declared-facts model: a system that
  declares an `http` `calls` interface has stated it can make HTTP calls; which
  of its operations makes the call does not change wire compatibility. The
  operation-level match is kept first so existing inputs keep their reason
  text.
- Keeping `method`/`path` as operation metadata rather than schema fields
  avoids a format change: `Operation.metadata` is already an open object.
- The inspector grows field-by-field rather than gaining a JSON panel because
  explicit labeled unknowns are the product's UX requirement.

## Compatibility

No serialized-format change. Existing documents validate unchanged. Exported
workflows gain truthful HTTP methods and paths only when `metadata.http`
exists; otherwise output is byte-identical. The relation change can turn a
previously false `protocolCompatible` into true for inputs whose caller system
declared a matching `calls` interface; the catalog version bump marks this.

## Alternatives

- A free-form schema editor in the inspector: more general, but invites
  invalid dialects; importing the document the service already publishes is
  both easier and more truthful.
- Modeling the caller operation's interface as always `calls`: would misstate
  indexed systems, whose operations genuinely sit on the exposed interface.
- Putting method/path into the Interface or Operation schema: a format change
  for data that is protocol-specific provenance.

## Security implications

OpenAPI discovery reuses the existing discovery boundary: loopback-only
workbench, same-origin redirect policy so headers never leave the origin,
response caps, no credential, query or fragment retention, and no invocation
of the described service. Documents pass the same structural guards as pasted
metadata (`guardDocument`, alias-free YAML). The hosted playground still never
contacts a server.

## Implementation

In this repository: `packages/plug/src/importers/index.ts` (shared
`openApiOperations`, `openApiSystem`, `importOpenApi`, `importDescription`
kind), `packages/plug/src/discovery/index.ts` (`discoverOpenApi`, request
parsing), `packages/plug/src/indexer/index.ts` (shared drafting, kept
metadata), `packages/plug/src/openspec/index.ts` (HTTP task method/path),
`packages/plug/src/recommender/relation.ts` (`callingInterface`),
`packages/plug/src/patterns/catalog.ts` (catalog-2), and the playground
inspector, discovery and import panels.

## Validation

Unit coverage in `tests/discovery.test.ts` (JSON and YAML documents, server
resolution, failure explanations), `tests/contracts-importers.test.ts`
(drafting, parameter synthesis, idempotency marker, version claims, bounds),
`tests/recommender.test.ts` (caller-capability compatibility and its reasons),
`tests/openspec.test.ts` (method/path export and lossless round trip),
`tests/indexer.test.ts` (kept metadata); browser coverage in
`tests/browser/playground.spec.ts` (hosted fact editing across connection,
system, operation and infrastructure; local OpenAPI discovery end to end,
keeping no headers). Specification text updated in
`docs/specification/draft/architecture.mdx`.
