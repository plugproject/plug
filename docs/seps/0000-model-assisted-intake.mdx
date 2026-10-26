---
title: Quote-gated, author-adopted fact drafting
status: draft
---

This proposal has no PR number, sponsor or approval yet. It adds no serialized
field or evidence kind. Before adoption every proposal is local workbench state;
after adoption the author has made an ordinary declaration.

## Motivation

Plug keeps unknown facts unknown so its deterministic engine never designs from
guesses. That guarantee also creates an intake bottleneck: API descriptions and
schemas often contain an output meaning, field correspondence or hard quota, but
the author must transcribe each one before the relevant gate can run. Index-first
intake finds the material without interpreting it. The next useful step is to
draft the declarations that material supports without silently turning model
output into fact.

The goal is not an LLM architect. Detection, pattern composition, obligation
closure, ranking and proofs stay deterministic. A completion model proposes a
small allowlisted fact, code verifies its structure and source quote, Jev may
judge whether the quote supports it, and the author decides whether to adopt it.

## Specification

### Local, author-initiated drafting

The local workbench adds **Draft missing facts** beside the existing
**Facts still needed** guide. The action sends only the selected caller and
downstream operation descriptions, bounded schemas and sanitized stored
metadata to `POST /api/draft`. It never sends interface endpoints, request
headers, credentials, discovery URLs or the synthetic `fetchMs` observation.
It never fetches an endpoint.

The hosted playground exposes no drafting route. The local route retains the
workbench's loopback Host check, same-origin rule, 256 KB request limit, caller
cancellation and 30-second deadline. At most twelve 4 KB source excerpts, three
requested fact kinds and four returned proposals are accepted.

The completion provider is selected explicitly or from available credentials:

- `PLUG_DRAFT_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`;
- `PLUG_DRAFT_PROVIDER=openai` with `OPENAI_API_KEY`; or
- `PLUG_DRAFT_PROVIDER=stub`, the named non-model test provider.

Every real provider requires an exact `PLUG_DRAFT_MODEL`. There is no implicit
stub fallback. `plug ui` loads the selected workspace's ignored `.env.local`.

### The v1 allowlist

The drafter can propose only:

1. `output-meaning` for the selected downstream operation;
2. `contract-mappings`, as complete caller-input → downstream-input and
   downstream-output → caller-output arrays; and
3. `calls-per-minute`, as a positive downstream quota explicitly stated with
   a per-minute unit.

It cannot propose arbitrary paths. Adoption dispatches on this closed union.

Cache permission, trust domains, workload, latency, availability, source
timestamp meaning and production observations are excluded. In particular, a
provider's uptime statement is not the fraction of calls succeeding within
Plug's timeout, and `experience.availabilityTarget` is a caller requirement,
not a downstream capability. Neither may be drafted from provider metadata.
Discovery duration remains synthetic and can never become source latency.

### Three honesty gates

Every proposal carries `{sourceId, quote, rationale}`.

1. **Verbatim quote gate.** Code requires a nonempty quote of at most 500
   characters that occurs byte-for-byte in the named supplied source. A
   proposal with a fabricated or stale quote is discarded.
2. **Mechanical value gate.** Output meanings are bounded text. A quota must
   repeat its exact numeric value and a per-minute unit in the quote. Mapping
   fields must exist at the top level, have equal property schemas and cover
   every required target field. Incompatible or partial mappings are
   discarded.
3. **Typed support judgment.** When `TYPESAFE_API_KEY` and
   `PLUG_JUDGE_MODEL` are configured, one TypeSafe Noul per surviving proposal
   asks whether that proposal's quote explicitly supports that proposal's
   fact. Questions share one request and named state. The probability and
   resolved Jev model are shown; a probability below 0.7 disables adoption.
   A configured Jev call that fails is an error, never a negative answer or a
   silent skipped check.

Successful drafting changes no design input. The review shows the proposed
value, exact quote, source label, completion model and Jev probability. If the
source basis changes, the review is stale and adoption is disabled.

### Adoption and provenance

Only **Adopt** enters the normal undo-aware editor transaction:

- output meaning updates `Operation.semantics.outputMeaning`;
- contract mappings atomically replace both mapping arrays; and
- calls per minute writes a `Fact` with `declared` evidence.

The output-meaning semantic evidence records that the author adopted the
specific draft. Mapping arrays have no evidence field in the current public
schema, so their detailed provenance remains in the local log. Every route
result is appended to `.plug/drafts.jsonl` with its model, basis hash, target,
requested kinds, proposals, quotes and judgments. Adopted evidence points to
the model and basis hash and records the exact quote plus the Jev model and
support probability when present; it never describes the model as the
declaring party.

## Rationale

This keeps the TypeSafe division of labor: models make narrow judgments and
draft language-aware inputs; code owns the decision table. A completion model
is suitable for extracting several structured candidates from mixed metadata.
Jev is suitable for the independent, calibrated support judgment. Exact quote
and mapping checks catch failures neither model should be trusted to police.

The review step is essential. A model proposal is not `inferred`, `declared` or
`judged` evidence and does not enter the serialized graph. Adoption is the
author's declaration, so existing deterministic analysis and proof semantics
remain intact.

## Compatibility

Existing DesignInput and OpenSpec documents are unchanged. No schema generation
is required beyond the normal drift check. Clients that do not use drafting
behave exactly as before. The endpoint and proposal types are private local
workbench contracts rather than public serialized Plug types.

The shared `Semantics.evidence` field cannot express field-level provenance and
`FieldMapping` has no evidence slot. This alpha records a narrowly worded
semantic note and keeps complete mapping provenance in the append-only local
log. A future public provenance model would require its own schema proposal.

## Alternatives

- **Let an LLM propose architectures.** This removes deterministic obligation
  closure, reproducibility and testable proofs—the properties Plug exists to
  provide.
- **Automatically accept extracted facts.** A quote can be real but ambiguous,
  scoped to another product or merely documentary. Author adoption preserves
  the source-of-truth boundary.
- **Ask Jev to extract every value.** Nouls answer judgments; they do not
  generate strings, numbers or mapping arrays. Completion drafting plus typed
  verification gives each model the task it fits.
- **Draft every missing inspector label.** Several labels are requirements or
  production measurements that provider metadata cannot establish. A small
  allowlist is safer and explainable.
- **Treat OpenAPI annotations as cache permission.** This violates an existing
  Plug guarantee; cache permission remains an explicit author declaration.

## Security implications

Model output is untrusted JSON. The parser rejects unknown root fields, bounds
all strings and arrays, and never accepts a JSON pointer or mutation path.
React renders proposal text as text. Source metadata is scrubbed of keys naming
URLs, endpoints, credentials, headers, secrets and synthetic fetch timing
before leaving the browser.

Keys stay in the local workbench process and are never logged or returned.
Logs contain the selected supporting quotes, so they may contain private API
documentation and remain local under `.plug/`. The existing body, timeout,
cancellation, loopback and same-origin bounds apply.

## Implementation

`packages/plug/src/judgment/draft.ts` owns the private request contract,
completion providers, strict parse, quote/value gates, optional Jev
cross-check and explicit stub. `packages/plug/src/ui/server.ts` exposes and
logs `POST /api/draft`. `apps/playground/src/workflow/FactDrafting.tsx`
constructs the sanitized basis, presents review state and applies allowlisted
adoptions through the existing editor transaction.

## Validation

Unit tests cover request and prompt bounds, strict JSON refusal, quote drops,
mechanical mapping and quota checks, provider fail-closed paths, stub naming
and injected Jev probabilities. Workbench-server tests cover the local route,
log, content type, body shape and missing-provider guidance. Browser coverage
proves drafting alone leaves DesignInput unchanged, adoption writes one
allowlisted fact and undo restores the unknown value. CI pins both providers
to explicit stubs, so tests never spend credentials.
