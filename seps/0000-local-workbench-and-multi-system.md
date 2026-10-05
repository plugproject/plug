---
title: Local workbench, workspace indexing and multi-system pattern inference
status: draft
---

This proposal has no PR number, sponsor or approval yet. It builds on the
public alpha design proposal and changes the serialized format.

## Motivation

The alpha evaluates one connection between exactly two hand-described systems
against a fixed catalog of cache, refresh and progressive designs. Three gaps
block adoption on real projects:

1. The reference package exposes only a CLI and a hosted playground. A developer
   cannot open the Systems / Required experience / Suggested designs workflow
   locally against their own project.
2. The project the developer is working in is never described automatically.
   Every interface, operation and schema is typed by hand, and nothing tells the
   developer which operational metrics Plug still needs.
3. Real integrations involve more than one counterpart (for example an MCP tool
   server and an A2A agent) and more problems than a slow read: protocol and
   contract mismatch, overload, unsafe retries, duplicate delivery, trust
   boundaries. A flat catalog of single patterns cannot express that a pattern
   solves one problem while introducing obligations that other patterns must
   discharge.

## Specification

The serialized format becomes `0.2-alpha.1`. The engine has five layers:
system understanding, relation engine, pattern knowledge base, composition
planner and explanation. All five are deterministic; no layer calls a model or
the network.

### Local workbench

`plug ui [--port N] [--workspace dir]` serves the packaged playground on
`127.0.0.1` only and rejects foreign Host and Origin headers. It
exposes the hosted endpoints (`/api/examples`, `/api/analyze`, bounded
single-sandbox `/api/demo`) plus local-only workspace endpoints
(`GET /api/workspace`, `POST /api/workspace/index`). The hosted playground never
exposes workspace endpoints; the UI shows workspace features only when
`GET /api/workspace` succeeds.

The Required experience form is the goal descriptor. `Experience` keeps its
alpha fields and adds optional `priorities` (distinct, lexicographic order over
`correctness`, `latency`, `availability`, `simplicity`, `cost`), `firstAckMs`,
`silenceBudgetMs`, `availabilityTarget`, `duplicateEffectForbidden`,
`lostRequestAllowed` and `orderingRequired`. An absent requirement field means
no requirement was declared; an explicit `null` or `unknown` means the
requirement itself is unknown.

### Workspace indexing

`plug index [dir] [--out file]` performs a bounded scan of the local workspace
and emits a `WorkspaceIndex`: findings, a draft `SystemDescription` for the
project, a content fingerprint for freshness, and `gaps`. The scan parses
OpenAPI documents, A2A Agent Cards, package manifests and source text for
interfaces, operations, schemas, brokers, caches, schedulers, retry/timeout
handling, idempotency keys and trace propagation.

Each finding carries `Evidence` of kind `static` with `source.type` and
`source.location` (a workspace-relative path). Static analysis yields only
structural facts. Latency, quota, concurrency, change frequency, cache
permission, sharing scope, key completeness and delivery guarantees remain
unknown and are listed in `gaps` as the metrics Plug needs. The draft system is
reviewed before it is adopted; it never enters analysis automatically.

Model-assisted semantic extraction is deferred. If later added, its facts must
be marked inferred with a confidence, can never satisfy a correctness or
security hard constraint, and require confirmation.

### Multi-system intake and relation engine

`DesignInput.systems` holds two to four systems. `connections` holds one to
three caller-to-downstream connections, each with its own mappings, adapter,
`profile`, `workload`, `experience` and `remainingPath`. `infrastructure` is
shared across connections. Descriptor extensions are optional: operation
`interaction` (callback, polling, streaming, cancellation), system
`trustDomain` and `messaging` (delivery, ordering, durability, dead-letter),
semantics `reversible` and `idempotencyKeySupported`, profile `availability`
and workload `burstPerMinute`.

For each connection the relation engine derives `RelationFacts`, three-valued
predicates (`true`, `false`, or `null` for unknown) with reasons and evidence:
protocol, contract and semantic compatibility, deadline risk, first-response
gap, capacity and burst mismatch, availability shortfall, side effects, unsafe
retry, duplicate delivery, atomic publish, ordering gap, later-result path,
deferral permission and trust-boundary crossing. Missing facts are never false.

Cross-connection checks compare the summed call rate of the selected designs
against the shared call budget and against each shared downstream quota.

### Pattern knowledge base and composition planner

Patterns are versioned data (`PatternDefinition`): family, scope,
preconditions, contraindications, required-one-of conditions, solved problems,
introduced obligations, conflicts, ordinal trade-offs, evidence needs, tasks
and executable support. The six alpha designs are seed entries and keep their
detailed age, schedule, coverage and quota evaluation. The first expansion
tranche, design-evaluated only, is: protocol adapter, message translator and
anti-corruption layer as distinct mediation rules; asynchronous request-reply
with correlation identifier; timeout; queue-based load leveling with optional
competing consumers; rate limiting; retry with backoff and jitter; circuit
breaker; idempotent consumer; dead-letter channel; transactional outbox with
relay; sequential convoy; and boundary authentication. Patterns that need
context beyond a pair (backend for frontend, canonical data model, message
bus, deployment stamps, service decomposition) evaluate to
`needs_global_context`.

Each pattern evaluates to `required`, `supported`, `optional`,
`contraindicated`, `not_applicable`, `unknown` or `needs_global_context`.
Retry is contraindicated when the operation is a side effect that is neither
idempotent nor keyed; asynchronous request-reply is contraindicated without
callback, polling or streaming.

Selection is a closure problem. For each seed base design the planner opens the
problems the base does not solve, expands solving patterns in a fixed order,
adds the obligations each pattern introduces unless a fact discharges them,
rejects conflicting sets, and bounds stacks to six added patterns. An
architecture is `infeasible` if its base is infeasible or a known problem has
no supported solver, `insufficient_information` if its base lacks essential
facts, and `conditional` if an obligation stays open, a selected pattern is
unknown, or a problem predicate is unknown.

Each architecture has a trade-off vector: useful latency, traffic success rate,
cost, consistency weakening, runtime coupling, operational complexity,
statefulness and component count. Valid architectures are Pareto-filtered;
an unknown dimension never dominates. The frontier is ordered by status, then
the goal priorities, then a stable pattern-set key. When the top two feasible
architectures tie on every priority, the report sets `policyDecisionNeeded`.
Every architecture carries a proof: the facts it relies on, rejected
alternatives with reasons and the decision-critical unknowns.

### Report

`DesignRecommendation` contains one `ConnectionReport` per connection: the
relation, the six evaluated seed candidates (unchanged criteria and
configuration), pattern evaluations, architectures, the selected candidate and
architecture, and missing information. It also contains cross-connection
criteria and the input, catalog and design hashes.

## Rationale

Collapsing architecture into one scalar score trades correctness for latency
whenever coefficients drift and cannot express composition. Rules with explicit
obligations are inspectable and testable, and three-valued evaluation is the
alpha's "unknown facts stay unknown" rule applied to pattern logic. Keeping the
six seed evaluators unchanged preserves the cache and refresh reasoning that
the alpha already validates. Local indexing uses evidence the project already
contains without uploading code anywhere.

## Compatibility

`0.2-alpha.1` replaces `0.1-alpha.2`. `migrateInput` lifts an alpha document
mechanically: the two systems stay, the single connection and its top-level
profile, workload, experience and remaining path become `connections[0]` with
ID `primary`, and `preference` becomes priorities
`correctness, <preference>, …remaining default order`. The CLI, local UI and
hosted analysis endpoint accept both versions. Candidate verdicts for a
migrated document equal those of the native document. Report consumers move
from top-level `candidates` and `selectedId` to `connections[i]`. No released
snapshot exists, so no dated schema changes.

## Alternatives

- A weighted score per pattern: rejected because it cannot represent obligations
  or mutually exclusive choices and hides hard-constraint failures.
- A model as architect: rejected because outputs are not reproducible or
  verifiable; deferred only as a fact-proposal aid.
- Hosted repository upload for indexing: rejected for privacy and because
  hosted analysis must never read or call user infrastructure.
- A separate SDK repository for the UI: rejected; it would duplicate contracts
  and drift from the reference implementation.
- A general SAT or answer-set solver: deferred; the bounded catalog does not need
  it and a fixed expansion order keeps hashes stable.

## Security implications

The indexer reads only the selected local directory, does not follow symbolic
links, skips `.env*`, key and certificate files, test files and dependency,
build or test directories, caps file count and bytes, never copies endpoint URLs beyond
host names and never opens network connections. `plug ui` binds to loopback,
applies same-origin checks and the alpha's size, nesting and remote-reference
guards, and runs at most one demo sandbox. Hosted analysis still never crawls,
indexes or invokes endpoints. Boundary authentication is a hard obligation the
planner cannot trade away for latency or cost.

## Implementation

- Contracts: `schema/draft/schema.ts`; migration and validation in
  `packages/plug/src/contracts/index.ts`.
- Relation engine: `packages/plug/src/recommender/relation.ts`.
- Knowledge base: `packages/plug/src/patterns/knowledge.ts`.
- Planner: `packages/plug/src/recommender/planner.ts`, orchestrated by
  `suggestDesign` in `packages/plug/src/recommender/index.ts`.
- Indexer: `packages/plug/src/indexer/index.ts`; CLI `plug index`.
- Local workbench: `packages/plug/src/ui/server.ts`; CLI `plug ui`.
- Playground: `apps/playground/src/App.tsx` and `apps/playground/service.ts`.

Remaining work before finalization: owner review, real-project trials of the
indexer, and executable support for any tranche pattern beyond design
evaluation.

## Validation

See [relation and planner tests](../tests/planner.test.ts),
[indexer tests](../tests/indexer.test.ts),
[local workbench tests](../tests/ui-server.test.ts),
[recommender tests](../tests/recommender.test.ts),
[contract and migration tests](../tests/contracts-importers.test.ts) and
[API tests](../tests/api.test.ts). The draft specification pages describe the
implemented behavior. This proposal remains draft pending owner review.
