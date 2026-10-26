---
title: Typed judgments for semantic equivalence and index-first intake
status: draft
---

This proposal has no PR number, sponsor or approval yet. It adds one new
evidence kind and one new optional connection field to the draft schema, and
changes nothing else about the serialized format.

## Motivation

The design engine is deliberately deterministic: a versioned pattern catalog,
evidence-gated criteria, a bounded search and a Pareto frontier. One gate in
that machinery is not like the others. `semanticMatch` must decide whether the
output a downstream operation declares satisfies the output the caller
requires, and the alpha implements it as exact string equality. Dogfooding
showed what that costs: "indicative flight options" versus "flight options,
indicative" fails, so authors learn to copy one string into the other — a
ritual that proves nothing about meaning and quietly turns a semantic question
into a formatting rule. Equivalence of two natural-language texts is a
judgment, and the engine should either receive a recorded judgment or keep
saying `unknown`/`fail`; it should never guess.

Two adjacent gaps surfaced in the same exercise:

- Nothing nudges an author to index a newly added system before describing it
  by hand, even though discovery (OpenAPI, MCP, A2A) is the cheapest honest
  source of operations, schemas and metadata, and the workbench's own fetch
  timing is at least a synthetic hint about reachability.
- When an edge's verdicts sit at `unknown`, the inspector does not say which
  declarations are missing; authors diff the JSON against the criteria text to
  find out.

## Specification

### Judged evidence and the pinned judgment

- `Evidence.kind` gains `'judged'`: a model judgment pinned to its exact
  inputs. Judged facts qualify a verdict; they are never production
  verification and never establish an observed quantity.
- `Connection.semanticEquivalence` (optional `SemanticEquivalence`) records one
  judgment: `{ equivalent, outputMeaning, usefulOutput, evidence }`. The
  judgment binds to the exact judged strings. When either current string
  differs from the pinned one, the judgment is void and the strict comparison
  applies again. Clearing or re-judging is an explicit author action.

### The judgment harness

A new `judgment` module owns the only path by which a language model enters
the analysis:

- A question registry, currently the single question `output-equivalence`
  at version 1. Each version fixes its prompt and its answer shape.
- A TypeSafe System One shape over named, bounded state (meaning and required
  output ≤ 2000 characters, optional context ≤ 8000) and one Noul question.
  Jev returns the probability that the outputs denote the same result; code
  classifies `noul >= 0.7` as equivalent and records the resolved model ID.
- Completion providers retain deterministic prompts over the same bounded
  inputs that instruct strict JSON:
  `{"equivalent": boolean, "confidence": 0..1, "rationale": ≤ 240 chars}`.
  Acknowledgements, progress signals and subsets are instructed to fail; when
  unsure the judge is told to answer false with low confidence.
- A verdict parser that refuses anything but the typed shape, clamps
  confidence and bounds the rationale.
- A provider port with a typed TypeSafe Jev implementation, Anthropic and
  OpenAI completion implementations, and an explicit non-model stub (token-set
  comparison) whose verdicts name themselves `stub`. Provider selection is
  environment-driven: `PLUG_JUDGE_PROVIDER` (`typesafe` | `anthropic` |
  `openai` | `stub`), a required `PLUG_JUDGE_MODEL` for real providers, and
  the matching API key. `TYPESAFE_API_KEY` takes precedence when provider
  selection is implicit. The stub never runs unless asked for by name, so no
  judgment is silently non-model. Results carry the question, question
  version, resolved model and timestamp.

The local workbench exposes `POST /api/judge` under the existing loopback and
same-origin rules, with bounded JSON bodies, a 30-second deadline, caller
cancellation, and an append-only `.plug/judgments.jsonl` log beside the other
workspace artifacts. The hosted playground has no judge: judgments, like
discovery, run only where the author's credentials and servers live.

### Propose–verify wiring

The deterministic engine remains the sole authority on feasibility.
`semanticMatch` (and the recommender's `semantics` criterion) pass when the
strings are equal, as today; otherwise a pinned, still-binding judgment with
`equivalent: true` turns the verdict into a pass whose fact carries both the
declared evidence and the judged evidence. A negative or stale judgment leaves
the strict verdict in place (the negative judgment's evidence is still
recorded). The progressive candidate's initial-output comparison takes no
judgment: pinning is defined against the downstream output meaning. The
pattern catalog version is bumped (`catalog-3`) because recorded designs can
now cite judged evidence.

In the inspector, when the required output and the declared output meaning
differ, the workbench offers "Judge equivalence" and shows the recorded
verdict, its model, its rationale and its staleness; the hosted playground
explains that judgment runs in the local workbench.

### Index-first intake and the facts guide

- Discovery results gain `fetchMs`, the wall-clock time this workbench spent
  fetching the listing — surfaced in the panel and stored under
  `metadata.discovery` with the explicit framing "a synthetic observation, not
  a production measurement". It is a reachability hint, not QoS: per-endpoint
  latency, availability and quota remain facts to declare or observe.
- A freshly added system (no endpoint, never discovered) focuses the discovery
  URL field, and Enter runs discovery, so indexing is the path of least
  resistance before any hand-description.
- The connection inspector lists "Facts still needed": the declarations this
  edge still lacks (deadline, availability targets, workload, downstream
  profile, caller path, mappings, output meaning, cache permission, trust
  domains). Plug names the missing facts; it never fills them in.

## Rationale

The design is a propose–verify split. The deterministic engine keeps sole
authority over feasibility, estimates and the frontier; the model answers one
registered question at a time with a typed, recorded, pinned verdict, and the
engine decides what that verdict may qualify. This keeps every proof
explainable — a passing semantics gate names the judgment, its model, its
confidence and its rationale — and keeps "unknown stays unknown": an absent or
stale judgment changes nothing. Pinning to the exact strings makes staleness
decidable without any further model call.

## Compatibility

Existing documents parse unchanged: `semanticEquivalence` is optional and the
new evidence kind only widens an enum. Analyses without judgments behave
exactly as before. Recorded designs cite `catalog-3`; a recorded `catalog-2`
design replays against the new catalog only by re-analysis, as with prior
catalog bumps. Discovery results gain a required `fetchMs`, which is produced
by the discovery entry point itself, so stored metadata written by older
workbenches simply lacks the field and is read as absent.

## Alternatives

- **Let the model edit facts or propose designs directly.** That dissolves the
  evidence discipline: the engine could no longer say _why_ a design holds.
  Judgments answer registered questions with typed verdicts; the engine decides
  what a verdict may qualify.
- **Fuzzy string matching (stemming, embeddings) inside the engine.** Hidden
  thresholds are still guesses, just unaccountable ones, and they run on every
  analysis instead of once per explicit author action.
- **A hard dependency on an external judgment service (e.g. a Jev-style
  deployment).** The provider port is deliberately small (one completion call)
  so a hosted judge, a local model or a different vendor can implement it; the
  workbench works with none configured by failing closed with instructions.

## Implementation

A new `packages/plug/src/judgment/` module owns the question registry, prompt
construction, verdict parsing, the provider port with Anthropic/OpenAI/stub
implementations and environment selection. `deriveRelation` exposes
`judgedEquivalence` (the pinning rule) and `semanticMatch` consumes it; the
recommender's `semantics` criterion applies the same rule, skipping the
progressive candidate's initial-output comparison. The workbench server adds
`POST /api/judge` and the JSONL log; the playground inspector adds the judge
row, the staleness display and the "Facts still needed" list; the discovery
module stamps `fetchMs` at its single entry point. The pattern catalog version
moves to `catalog-3`.

## Validation

Unit suites cover prompt and System One request bounds and determinism, verdict
parsing and refusal, Noul thresholding, stub behavior and naming, provider
selection (including every fail-closed
path), the pinned/stale/negative judgment matrix through `deriveRelation` and
the `semantics` criterion, the `/api/judge` route (stub verdict, local log,
content-type and body validation, 503 guidance) and `fetchMs` presence.
Browser tests drive the hosted facts-needed list and workbench hint, and the
full local flow: differing texts, stub judgment, pinned evidence in the design
input, staleness on edit, and clearing — with the Playwright workbench pinned
to `PLUG_JUDGE_PROVIDER=stub` so no test spends or needs credentials.

## Security implications

Judgment providers run only in the local workbench, under the same loopback
binding and same-origin checks as discovery. Only the two author-supplied
texts (plus optional context) are sent to the configured provider — never
endpoints, headers or workspace contents. Keys stay in the environment; the
JSONL log records verdicts, not credentials. The stub provider cannot be
selected implicitly, so a missing key can never silently downgrade a judgment
to a non-model heuristic.
