# Plug — Public Alpha Implementation Plan

**Outcome:** Put Plug on a public URL where developers describe two systems, their operational behavior, and the UX they need. Plug recommends explainable system design patterns that bridge the gap, demonstrates a supported design, and exports an implementation recipe.

**Status:** Plan for Codex to implement; no implementation or deployment is claimed. Architecture recommendation is Plug’s core idea. The repository must follow the specification/schema/docs/SEP organization of `modelcontextprotocol/modelcontextprotocol`, as detailed in section 11.

**Basis:** The original blueprint, earlier Plug discussion, and the owner’s flight-booking example. The previous alpha plan overemphasized provider selection and orchestration. This revision makes system design recommendation the primary product. The existing `plug` repository has not been inspected; Codex must inspect it before changing code.

## 1. The product

**Plug takes system details + QoS + data/workload characteristics + required UX, and proposes the system design needed to deliver that UX.**

The input describes what the systems can do and what users need. The output may introduce a cache, scheduled refresh, prefetching, or a progressive response path. These components need not exist in the original connection. Choosing providers or invocation order is only one possible design decision.

```text
Two systems and their protocols/operations
  + QoS, data behavior, workload evidence
  + required UX and allowed infrastructure
                    |
                    v
          Plug design recommender
                    |
                    v
Architecture candidates + feasibility + reasons + tradeoffs
                    |
                    v
Selected design + configuration + implementation recipe
                    |
                    v
Supported executable proof + measurements
```

A visitor should be able to describe two systems manually or import supported MCP/A2A metadata; supply missing operational facts; specify useful-response, latency, and freshness requirements; and click **Suggest design**. They should see the direct baseline, proposed patterns, reasons, and remaining prerequisites. Changing an input must recompute the comparisons and parameters; explain when the same design remains appropriate. They can then run the bundled proof and download the report/configuration.

The public alpha must accept developers’ own system descriptions for analysis without credentials and include a working local HTTP example. Animated, hard-coded recommendations are insufficient.

## 2. Launch scope

| Build now | Defer |
|---|---|
| Two-system intake, selected operations, explicit mappings | Unbounded system discovery and large capability graphs |
| Manual HTTP description, MCP tool-list import, A2A Agent Card import | Full hosted MCP/A2A execution clients and authenticated discovery |
| QoS, freshness, change-frequency, cacheability, and workload profiles | Automatically inferring every operational fact |
| Deterministic architecture pattern catalog | LLM architect, general optimizer, arbitrary infrastructure synthesis |
| Direct request, cache-aside, scheduled refresh/prefetch, progressive response evaluation | Every distributed-system pattern and unrestricted composition |
| Diagrams, parameters, evidence, tradeoffs, implementation tasks | Automatic deployment into customers’ infrastructure |
| Real HTTP cache/refresh proof and reusable local example | Booking/payment execution and commercial flight-provider integration |
| Bounded cache/scheduler in one process | Durable jobs, distributed cache, high availability, restart recovery |
| Public playground, package, quickstart, tests, deployment | Accounts, billing, marketplace |
| MCP-style specification/schema/docs/SEP layout, generation checks, contribution and governance files | Large committees, automated SEP lifecycle bots, unrelated ecosystem infrastructure |

Keep the name **Plug**. The author states requirements and permits infrastructure; they must not have to prescribe “add a cache” or “use cron.” Plug proposes the design and parameters. A user can then choose a candidate.

Remove mandatory provider switching, general fallback planning, six-node DAG optimization, and the vehicle-support demo from the launch critical path. Retain useful existing code, but do not build those features before the architecture recommendation journey works.

## 3. System intake: include MCP and A2A now

Support exactly two systems. Each has an ID, role, interfaces it exposes or can call, operations, input/output descriptions, and semantics. The connection selects caller/downstream operations with explicit field mappings. Preserve protocol identity and direction: exposing A2A does not imply the ability to call MCP.

| Input | Normalize into Plug |
|---|---|
| Manual form or JSON/YAML | Interfaces, versions, operations, schemas, mappings, semantics, operational facts |
| MCP `tools/list` response | Tool names/descriptions, required input schema, optional output schema, annotations, task support |
| A2A Agent Card | Identity, interfaces, protocol versions, skills, media types, advertised capabilities; user selects/maps the operation |

Pin and test importer versions initially against MCP `2025-11-25` and A2A `1.0`. Show extracted facts for review. Preserve unfamiliar metadata but do not treat unsupported semantics as understood. Missing operation schemas/mappings remain gaps; skill prose cannot establish a structured contract. [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [A2A specification](https://a2a-protocol.org/v1.0.0/specification/)

For MCP, accept either a full JSON-RPC response or its result object. Require an import wrapper/manual fields for server identity and negotiated protocol version, which the tool list itself does not provide. Mark a response with `nextCursor` as incomplete; combine supplied pages explicitly rather than assuming discovery is complete. A missing required input schema is an import error, not an inferred empty contract.

The descriptors do not generally supply the QoS, change frequency, cache permissions, and workload evidence this analysis needs. Collect these in a supplemental **Plug System Profile**. MCP annotations are hints, and tool-list changes are not business-data invalidations. A2A streaming/push support likewise does not establish invalidation or latency guarantees. [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [A2A specification](https://a2a-protocol.org/v1.0.0/specification/)

Incompatible interfaces or missing conversion produce an `ADAPTER_REQUIRED` prerequisite whose overhead remains unknown until supplied. Do not omit it from estimates. Plug can recommend architecture around MCP/A2A while marking execution unsupported. Label **metadata understood**, **design evaluated**, and **executable here** separately.

Imports are pasted/uploaded documents, processed in the browser where practical. No hosted endpoint crawling, tool invocation on import, remote schema fetching, or credential collection. Local live discovery can follow later.

## 4. Minimum input contract

Use `formatVersion: "0.1-alpha.2"` for this revised design-input format. Document that it replaces the earlier alpha draft. Define public serialized contracts in `schema/draft/schema.ts`; generate JSON Schema and schema-reference documentation from that source. Forms, imports, CLI, and recommender consume these canonical types/validators, with additional semantic checks for cross-field rules.

| Area | Required facts or explicit unknowns |
|---|---|
| Connection | Two systems, selected operations, interface compatibility, input/output mappings |
| Semantics | Read/write, idempotency, output meaning, cache permission, public/user/tenant scope, exact key dimensions |
| QoS | Completion latency and percentile if known, timeout/bounded duration, rate/concurrency limits, response size, optional call cost |
| Evidence | Per fact: declared/observed/synthetic/unknown; measurement date, sample size, and window when available |
| Data | Change-frequency estimate/window, source timestamp semantics or maximum source lag, invalidation signals if available |
| Workload | Request volume, hot-key distribution, enumerable prewarm keys, usable-hit coverage, key count/cache capacity |
| UX | Useful initial output, latency target and scope, accepted age, permission for indicative results and later live updates, final deadline |
| Infrastructure | Cache/scheduling permission, memory/call budget, refresh concurrency, scheduling allowance |
| Remaining path | Agent/model, mapping, network, serialization/rendering overhead needed for a complete UX estimate |

Allow declared estimates; no telemetry platform is required to start. Missing facts stay unknown. Ask only for information relevant to promising patterns. Cache permission, key scope, and accepted result age cannot be inferred from a tool name or read-only hint.

Separate **result age**, **change frequency**, and **required correctness**. Infrequent observed change does not prove a cached value remains correct. Indicative options, live availability, and completed booking are different outputs.

Latency scope is `warmHits`, `trafficPercentile` with a target percentile, or `everyRequest`. A warm-hit result cannot establish an all-traffic claim. A progress acknowledgement does not count as useful flight options.

Use milliseconds and bounded finite numeric values. Preserve imported schema dialects; do not silently rewrite MCP schemas into draft-07. The executable HTTP example uses a fixed, tested contract subset.

## 5. The proof: a 15-second source and a two-second UX

Use synthetic flight data and one slow aggregator. There is no faster alternate provider; improvement must come from the architecture.

System A is a flight-search agent; System B has a read-only search operation. A real HTTP fixture call takes 15 seconds and returns timestamped indicative offers. Live revalidation is included as a separate boundary in the design; purchasing tickets is outside this release.

| Illustrative fact | Value |
|---|---|
| Aggregator search | 15,000 ms fixture latency; 20,000 ms timeout bound |
| Fast-path estimate | 200 ms cache lookup + 800 ms remaining agent/network/rendering overhead |
| Useful output | Indicative options under 2,000 ms; not guaranteed availability or booking confirmation |
| Accepted age | 90,000 ms; fixture has a trustworthy snapshot timestamp and zero additional source lag |
| Change interval | 300,000 ms, explicitly synthetic |
| Hot set | Two exact predefined queries account for 98% of supplied query traffic; this is a coverage ceiling, not automatically a usable-hit rate |
| Workload evidence | A bounded synthetic trace of 500 requests over ten minutes, with 98% on those keys and 2% on other keys; timestamps/order included |
| Within-target warm responses | 99% under two seconds, a separately declared synthetic complete-path assumption; not derived from adding latency point estimates |
| Upstream capacity | Six calls/minute, two simultaneous calls; reserve two calls/minute for foreground/miss traffic |
| Refresh allowance | Two simultaneous refreshes, 5,000 ms scheduling allowance; cache and scheduling permitted |
| Default SLO | 95% of stated post-warmup search traffic; coverage/full-path latency remain assumptions to validate |

Keys include every output-changing dimension: route, dates, passenger composition, cabin, currency, locale, and relevant user/tenant/fare context. Prewarming routes alone does not cover every query combination. The fixture uses public, non-personalized fares; unknown sharing scope blocks a shared-cache recommendation.

```text
Request:      Agent -> exact-key cache -> indicative options + age
Maintenance:  Scheduled refresh -> slow aggregator -> validated cache entry
Miss/expiry:  Explicit slow/live path if allowed; otherwise target unmet
Commit:       Live revalidation -> booking flow (outside the demo)
```

Explain that the source still takes 15 seconds. Precomputation moves the work before a covered request. Freshness, coverage, load, and cold-start behavior determine whether the tradeoff is acceptable.

| Scenario | Required outcome |
|---|---|
| Live source result required under two seconds | Reject direct and cached designs for this requirement; report infeasible under current facts/catalog. |
| Indicative results allowed, age ≤90 seconds, coverage sufficient | Recommend cache + scheduled refresh/prefetch with evidence, assumptions, and configuration. |
| Cache or scheduling disallowed | Reevaluate remaining patterns; cache-aside alone still needs usable-hit evidence. |
| Accepted age reduced to five seconds | Reject the cached design under the fixture’s snapshot-at-request-start semantics: the source call alone exceeds the age bound. |
| Inadequate quota, unknown coverage, unbounded key space | Report violated requirements or unmet prerequisites; warm-hit speed cannot stand in for traffic coverage. |
| Cold/expired cache or failed refresh | Show the slow/failure path and target miss; expired entries cannot count as fast useful success. |

These fixture assumptions are not claims about real flight aggregators’ caching permissions or behavior.

## 6. Pattern catalog and algorithm

Each deterministic template defines prerequisites, introduced components/edges, parameter derivation, failure behavior, tradeoffs, evidence needs, and executable-support status.

| Pattern | Purpose | Main checks |
|---|---|---|
| Direct request | Already-fast interactions | Complete path budget, correct output, compatible interfaces |
| Cache-aside | Repeated exact reads | Permission/scope, accepted age, usable-hit evidence; cold misses remain slow |
| Scheduled refresh/prefetch + cache | Slow reads ahead of predictable demand | Above checks plus enumerable keys, bounded work, quota/concurrency, capacity, maintainable age |
| Progressive/deferred response | Useful information before a later live result | An identified initial output available in time, permission for later results, final deadline |

Allow two compositions: scheduled refresh with cache-aside miss filling; eligible cached initial output followed by a live refresh. A general pattern search engine is unnecessary. Parallel independent reads can follow later; parallelizing one slow dependency does not solve this example.

Algorithm:

1. Normalize and validate systems, semantics, UX, mappings, and evidence.
2. Evaluate the direct baseline; locate gaps against each UX criterion.
3. Evaluate templates/compositions and derive parameters from the inputs.
4. Estimate useful-response latency, live completion, age, refresh load, storage, coverage, and cold start separately. Include adapter and agent-path overhead.
5. Mark each criterion `pass_under_assumptions`, `fail`, or `unknown`, with compared values and evidence.
6. Classify each candidate: `feasible_under_declared_assumptions`; `conditional` when a concrete design still needs evidence/operational prerequisites; `infeasible` for known violations; `insufficient_information` when essential semantics/facts prevent meaningful evaluation.
7. Rank evaluated feasible designs first, conditional ones next; then apply latency/call-cost preference, component count, and stable pattern ID. Missing cost never equals zero: mark cost ranking unavailable and fall back to complexity/stable ordering.
8. Return alternatives and rejection reasons. No feasible candidate is a valid result. Infeasibility refers to the supplied facts and supported catalog, not all possible architectures.

The same normalized input/evidence and catalog version produce the same hash. No network access, ambient telemetry lookup, or LLM planning inside the recommender. Warnings cannot turn failed hard requirements into passing designs.

## 7. Cache and refresh reasoning is part of the product

**Age:** Store trustworthy source snapshot time, fetched-at time, and provenance. With only fetch time available, label “age since observation”; bounded source-data age also needs source-lag evidence. Check age on every read. A refresh completing now must not make an older snapshot appear newly generated. Cache-aside alone does not establish consistency. [Cache-aside considerations](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)

**Cadence:** Define result age at delivery to the caller. For start-to-start interval `I`, bounded fetch duration `D`, scheduling/queue allowance `J`, extra source lag `L`, and remaining delivery allowance `U`, use `I + D + J + L + U <= maxAge` as a conservative envelope under the documented snapshot assumptions and successful refreshes. Reserve `U` in cache-read eligibility as well. Use bounded durations, not p95, for this envelope. Missing bounds make the claim conditional.

Using a separately declared one-second delivery allowance, the fixture allows `90s - 20s - 5s - 0s - 1s = 64s`; propose 60-second refresh. Candidate intervals are 1, 5, 10, 15, 30, 60, 120, 300, and 600 seconds. Within a pattern, prefer the largest feasible interval to reduce calls. A soft heuristic can further prefer an interval no greater than half the supplied typical change interval. Label it a heuristic, not a guarantee. If capacity prevents that preference, explain the tradeoff while preserving hard age limits. Bursty change and sparse observations reduce confidence.

**Load:** Scheduled calls/minute are `60,000 × keyCount / I`; add miss/live traffic and reserve, including calls added by compositions. Respect shared quota and concurrency. Construct a deterministic per-key schedule to verify completion allowances; average concurrency alone is insufficient. Spread work and prevent overlapping refreshes for a key. Reject an unschedulable design or report the missing capacity.

**Coverage:** Hot-key traffic share is an upper bound. Derive usable-hit coverage separately for each design, accounting for cold misses, expiry, refresh failure, eviction, unenumerated keys, and restarts. Use matching observed evidence or replay a supplied bounded synthetic workload with the candidate's exact cache/refresh policy and an injected clock; otherwise mark coverage unknown. Do not assign cache-aside the benefit of scheduled prewarming. The flight fixture caches only the enumerated hot keys; other keys take the declared miss path without displacing them.

If misses exceed the latency target, target success is at most `usableHitRate × fractionOfHitsWithinTarget`. Retain evidence for both factors; a latency point estimate does not establish the second. With missing evidence, classify the traffic-SLO claim as conditional. The illustrative 98% hot-key share does not prove a production SLO. Test that replay includes cache-aside expiry/refill gaps, and recompute when parameters change. A warm cache with a slow miss path cannot satisfy `everyRequest`.

**Miss/failure:** Retain the last successful entry only while permitted by age. Failed refresh must not advance freshness timestamps. Use single-flight fills per scoped key. Miss/expiry follows the explicitly allowed slow/deferred path or returns target-unmet. Never relabel a spinner as useful options. Serving data beyond the configured age is unsupported in the alpha.

**Correctness:** Only eligible reads enter cache patterns. Booking/payment writes stay live. Preserve any required live validation at commitment in the design and implementation recipe. No pattern may silently substitute indicative results for live confirmation.

## 8. Outputs a developer can implement

Every suggestion includes:

- Direct and proposed diagrams distinguishing existing systems from introduced components.
- Selected patterns, per-requirement verdicts, source facts, assumptions, gaps, rejected alternatives.
- Exact key/scope, maximum age, capacity, refresh cadence, prewarm keys, concurrency/quota allocation, timeout, miss/failure policy.
- Warm/cold/refresh/live timings, call volume, storage, and declared cost where known.
- Execution support, adapter/infrastructure prerequisites, and validation steps.
- Ordered tasks to place the cache, form keys, fill/refresh, attach timestamps, integrate the caller, preserve live validation, and measure results.

Export `design.json`, `design.md` with a Mermaid diagram, and versioned runner configuration. Include input/catalog hashes. Generate reports from structured decisions and separate estimated values from demo measurements.

Expose `normalizeSystems(...)`, `suggestDesign(input)`, and `runDemo(design, options)`. CLI commands: `analyze`, `explain`, `demo`. Analysis never executes submitted endpoints. A general protocol runtime is not required for launch.

## 9. Executable proof and lifecycle

Implement the direct HTTP path, cache-aside, scheduled refresh, and the two compositions against bundled fixtures and trusted local HTTP configuration. A separate local sample service performs the 15-second read and returns versioned snapshots. Playground and local example share the same pattern/configuration code.

The hosted proof uses an isolated sandbox per demo session: at most two cached keys, bounded memory, a controlled scheduler, and a 120-second lifetime. This allows a real 60-second refresh to be observed. Request UX timers are separate from sandbox duration.

Begin empty and show the actual 15-second warmup. Then allow measured warm requests. Keep setup time outside warm-request timing but visibly report it. Perform a real later refresh; no invisible seeded successes. Accelerated time, if added, requires an explicit simulation label. Tests use a fake clock, but at least one deployed run verifies full-speed source latency and a fast valid cache hit.

Display cache-path duration separately from any unimplemented agent/model overhead. A stub agent cannot establish full production agent latency. Measurements apply to the synthetic demonstration’s stated scope.

Provide sandbox-local controls for unprewarmed queries, expiry, failing the next refresh, and changing fixture data. Verify the new source version appears after refresh. Other users’ state must be unaffected. Cancel/disconnect, lifetime expiry, or process shutdown aborts that sandbox’s calls/timers and clears its cache. No resume/durability claim.

The local example keeps its scheduler running while its service is alive and shuts down cleanly. Its recipe shows where an always-running scheduler/cron and a suitable cache belong in a real deployment. Multi-instance operation, durable scheduling, and restart continuity require additional components; the alpha does not certify them. Restart begins cold.

Events include warmup, request start, cache hit/miss/expiry, refresh start/success/failure, source completion, result delivery, target miss, and sandbox termination. Distinguish data age, observed time, and declared cost per started upstream call. Validate responses, abort timeout calls, ignore late completions, and release resources exactly once.

## 10. Public UX and service

One page has **Systems**, **Required experience**, **Suggested designs**, and **Try design**. Preload the flight example; provide manual forms, metadata import, advanced JSON/YAML, and a missing-information checklist. Edits stale the recommendations. Executing a supported design requires its current hash.

Changing latency, age, cache permission, change frequency, coverage, or quota must recompute the design and show updated comparisons/configuration, including when the architecture remains unchanged. Include test inputs that do change the verdict or pattern. Explain why it helps, where it fails, and what to build. Include downloads/quickstart, keyboard access, readable mobile layout, and status beyond color.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Cheap readiness/liveness |
| `GET /api/examples` | Bundled descriptions/profiles/inputs |
| `POST /api/analyze` | Validated descriptions + UX → candidates; no endpoint invocation |
| `POST /api/demo` | Bundled scenario + design hash/config → streamed NDJSON from bounded sandbox |
| `POST /api/demo/:id/actions` | Scoped request/expiry/fault/data-change action within the existing sandbox |

Serve the UI/API from one Node process/origin. Recompute the bundled design server-side before execution; reject stale/tampered hashes. User descriptions are hosted analysis-only. Their URLs/headers cannot become executable targets. Fixtures use a private loopback listener and server-owned bindings.

The demo's first event returns an ephemeral opaque session ID and unguessable action token. Keep the token in browser memory; send it in an action-request header, never URLs/logs. Accept only fixed action enums and fixture keys, with at most twenty actions per session and bounded source-call admission. A successful action response only acknowledges receipt; results arrive on the existing stream with an action ID. Unknown/expired sessions or wrong tokens fail. Disconnect invalidates the token and deletes sandbox state; actions must never create a new sandbox implicitly.

Default caps: 256 KB descriptions, four selected operations per system, nesting sixteen, two cache entries and 1 MB output per sandbox, four simultaneous sandboxes globally, two upstream calls per sandbox, 120-second lifetime. Reject executable expressions, remote references, YAML aliases/custom tags, oversized input, and excess admission. No unbounded queue. Use bounded per-IP limits with correct hosting-proxy configuration and clear `Retry-After` errors.

Same-origin APIs; no raw rendering of imported HTML. Do not persist descriptions or log credentials/documents/payloads. Record aggregate design/outcome/timing/cache metrics. Cancel immediately marks the browser cancelled and aborts the stream; unexpected EOF is interrupted. Record one server-side terminal state even when no event can reach the disconnected browser.

## 11. Required repository structure: follow MCP

Use [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) as the structural reference. Its central artifacts are specification, schemas, and documentation; Plug adopts that organization and adds its reference implementation and playground in separate folders for the bootstrap. This is a required repository convention, not an optional future cleanup.

MCP maintains a TypeScript schema source with generated JSON Schema and a generated documentation reference. Its contribution workflow identifies source versus generated files explicitly. Plug must preserve the same separation. [MCP contribution workflow](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/CONTRIBUTING.md)

Required layout, adapting existing work into these locations:

```text
plug/
  .github/
    ISSUE_TEMPLATE/
    PULL_REQUEST_TEMPLATE.md
    workflows/
      ci.yml
      generated.yml
  schema/
    draft/
      schema.ts                  # Canonical public TypeScript contracts
      schema.json                # Generated JSON Schema
      schema.mdx                 # Schema-reference page template
      examples/
        DesignInput/
        SystemProfile/
        DesignRecommendation/
        DemoEvent/
  docs/
    docs.json                    # Mintlify navigation/configuration
    introduction.mdx
    docs/
      quickstart.mdx
      concepts.mdx
      flight-search.mdx
    specification/
      draft/
        index.mdx
        architecture.mdx
        system-profile.mdx
        experience.mdx
        patterns.mdx
        recommendations.mdx
        schema.mdx               # Generated reference
        changelog.mdx
    development/
      setup.mdx
      deployment.mdx
    community/
      design-principles.mdx
      sep-guidelines.mdx
    seps/                        # Generated pages from root seps/
  seps/
    README.md
    template.md
    0000-public-alpha-design.md   # Provisional number until its PR exists
  scripts/
    generate-schemas.ts
    validate-examples.ts
    render-schema-docs.ts
    render-seps.ts
    check-seps.ts
  packages/
    plug/
      src/
        contracts/               # Canonical type exports + semantic validators
        importers/
        patterns/
        recommender/
        demo/
        cli.ts
        index.ts
  apps/playground/               # Browser + Node service
  examples/
    flight-search/
    your-http-api/
  tests/
  AGENTS.md
  CONTRIBUTING.md
  GOVERNANCE.md
  MAINTAINERS.md
  CODE_OF_CONDUCT.md
  SECURITY.md
  LICENSE
  README.md
  IMPLEMENTATION.md
  package.json
  package-lock.json
  tsconfig.json
  eslint.config.mjs
  .gitattributes
  .gitignore
  .nvmrc
  .prettierrc.json
  .prettierignore
  render.yaml
```

MCP uses draft and dated schema directories, MDX specification pages, root SEPs, and documentation navigation configuration. Use those conventions for Plug's own artifacts and versions. [MCP schemas](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema), [MCP documentation tree](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs)

### Canonical contracts and versioning

`schema/draft/schema.ts` owns serialized design inputs, system profiles, evidence, UX requirements, pattern/configuration descriptors, recommendations, and events. Use documented TypeScript interfaces/types with generation-compatible constraints. Define exportable root types explicitly. Generate JSON Schema with a pinned deterministic generator and validate payloads/examples with AJV; keep cross-field feasibility logic in semantic validators. Never maintain a second handwritten Zod or application schema for the same public contract.

Generate `schema/draft/schema.json` and `docs/specification/draft/schema.mdx`; do not edit either by hand. Bundle the types and generated validators/schema into the published package so a packed install does not depend on files outside the package. Application-only state may have private types, but cannot redefine public contracts.

Develop in `draft`. When publishing a versioned specification, snapshot its schema and normative docs into matching `schema/YYYY-MM-DD/` and `docs/specification/YYYY-MM-DD/` directories, using the actual publication date. Record the mapping from the serialized `formatVersion` to that snapshot and the implementation release; folder names do not silently alter the serialized format. Keep released snapshots immutable and put subsequent work in draft. Do not copy MCP's historical releases into Plug.

Schema examples are small contract-valid documents. Root `examples/` contains runnable integrations using those contracts; CI validates both. Explain semantics in the draft specification and generate field-level reference material from the schema. Only specify the supported alpha; unsupported future patterns remain explicitly deferred.

### Documentation and SEPs

Use MDX and `docs/docs.json` for a locally previewable Mintlify documentation tree. Quickstart and deployment instructions live in the paths above; remove earlier duplicate `docs/quickstart.md`, `docs/format.md`, and `docs/deploy.md` plans. README links to the demo, quickstart, current specification, reference implementation, and SEP process. Public repository docs remain usable without purchasing separate documentation hosting.

Adopt root Markdown SEPs with rendered documentation pages and PR-based numbering. Major contract/behavior changes and process changes use SEPs; fixes and clarifications use ordinary PRs. Proposals start with `0000`, then use their actual PR number. Track `draft`, `in-review`, `accepted`, `final`, `rejected`, `withdrawn`, `superseded`, and `dormant`. Finalization of behavioral changes requires the implementation, specification update, and relevant tests. [MCP SEP guidelines](https://modelcontextprotocol.io/community/sep-guidelines)

For Plug, keep review practical: the owner/actual maintainers review proposals through GitHub. The bootstrap SEP records this alpha's system-design model and scope while the prototype is built. Do not invent approval history, PR numbers, or nonexistent sponsors. The template includes motivation, specification, rationale, compatibility, alternatives, security implications, implementation, and validation. This adapts the process to Plug's current team; it does not require MCP working groups, external approvals, or a separate conformance service.

Write concise Plug-specific contribution, maintainer, governance, security, and conduct files. Populate identities/contact routes only from repository facts or owner input. Preserve the existing license and applicable notices; do not copy MCP's ownership, foundation membership, or legal commitments. Blog, plugin distribution, registry content, and SEP bots are not needed merely because the reference repository has them.

### Generation, CI, and tooling

Provide `generate:schema`, `generate:seps`, and aggregate `generate`; checks must cover schema source, generated JSON/reference pages, example validation, docs formatting/internal links, and SEP metadata/rendering. Offer `serve:docs` for local preview. These command families follow MCP's developer workflow; Plug's implementation tests are additional checks. [MCP package scripts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/package.json)

The generated-file CI job regenerates in a clean checkout and fails on differences. Generated files are committed; conflicts are resolved in their sources and then regenerated. No credentials or network discovery are needed to generate contracts or validate examples. Keep `AGENTS.md` explicit about source ownership, supported scope, generation commands, and never weakening UX requirements.

Use Node 24 LTS, TypeScript, npm workspaces, React/Vite, Express, appropriate AJV dialect validation, a safe YAML parser, Vitest, and Playwright. Pin compatible dependencies and use `.nvmrc` consistently with CI and hosting. Keep domain logic outside the web framework. [Node release information](https://nodejs.org/en/about/previous-releases)

One reference package and one deployed playground service still suffice. Keeping `packages/` and `apps/` alongside MCP-style specification artifacts is an explicit Plug bootstrap addition. A separate SDK repository, database, or distributed worker fleet is not a launch requirement.

## 12. Codex implementation order

| Milestone | Work | Acceptance gate |
|---|---|---|
| 0. Inspect and establish structure | Inspect existing work; establish the section 11 schema/docs/SEP layout, short community files, generation scripts, and CI. | Canonical contract generation and example checks run; bootstrap SEP is present without invented approval status. |
| 1. Suggest a design | Canonical input contracts, manual intake, direct baseline, scheduled-cache template, flight profile, explanations; document the implemented semantics in draft. | Slow source + fast UX proposes cache/refresh only when semantics/constraints permit; schema/docs/examples stay synchronized. |
| 2. Finish bounded catalog | Other patterns/compositions, age/load/coverage, statuses, configuration and report generation. | Age, quota, permission, and missing evidence produce expected recommendation changes. |
| 3. Import real descriptions | MCP/A2A importers, reviewable extracted facts, missing-information prompts, compatibility flags. | Independent HTTP/MCP/A2A descriptions work; execution support is labeled honestly. |
| 4. Demonstrate/export | Real HTTP, cache, scheduler, cold/warm/expiry/fault controls, events/config, local example. | Visible warmup, unchanged slow source, fast eligible hit, no false success on invalid cases. |
| 5. Adoption | Package/CLI, clean install/custom endpoint, concise docs. | Developer can analyze their own pair and run a supported local design. |
| 6. Launch | UI polish, resource limits, CI, production build/config, live smoke test, feedback link. | Fresh-browser public tryout and clean local quickstart pass. |

Implement `npm run dev`, `npm run example:flight`, `npm run example:http`, `npm run check`, `npm run test:browser`, `npm run build`, and `npm start`, plus section 11's generation/docs commands; installation uses `npm ci`. Aggregate `check` includes specification, generated artifacts, examples, docs/SEPs, and implementation checks. Explain which commands keep servers running.

Install an `npm pack` tarball outside the workspace, change endpoint/contract/profile, analyze the corresponding two-system description, and execute a supported local design. This tests real customization and packaging. Public npm publication is optional; a licensed clone-and-run path is enough initially.

Keep an existing license. If missing, resolve the owner’s distribution choice before calling the code open source or publishing a reusable package. Establish the required MCP-style structure at bootstrap, then develop the working suggestion and its specification together; do not expand into the deferred ecosystem features.

## 13. Focused tests

- Specification: deterministic TypeScript-to-JSON/reference generation, valid/invalid examples, packaged schema availability, docs links, and SEP metadata/rendering. New behavioral SEPs link to relevant regression tests.
- Importers: pinned MCP/A2A fixtures, missing schemas, unsupported versions, hints versus verified facts, protocol direction, no network during import.
- Recommender: deterministic hashes, direct infeasibility, cache eligibility, age/load/coverage, change heuristic, unknown evidence/cost, complete-path budget, both compositions.
- Boundaries: writes cannot be cached; scoped keys cannot cross users; live booking cannot become indicative search; a spinner cannot meet the useful-result requirement.
- Cache/runtime: source age versus write time, cold/warm/expired, failed refresh preserving age, single-flight, per-key nonoverlap, response validation, timeout/cancel/cleanup.
- Scheduler: exact schedule meets quota/concurrency; fake-clock refresh/expiry, cold restart, and a separate real 15-second HTTP integration test.
- Browser/API: own inputs → suggestions → changed constraints → changed verdict; demo → warm result → later refresh; fault controls, stale hashes, injection attempts, capacity and interruption.
- Distribution: clean checkout and packed-package custom HTTP example.

Do not infer end-to-end p95 from sums of component p95 values or a few runs. Expose estimator assumptions; production SLO validation needs representative traffic and sufficient observations. CI runs specification/generation checks, build, and focused implementation/browser tests; no separate general conformance framework is required.

## 14. Deploy and verify

Use an existing suitable host or provide a Render Node service as the default. Build `npm ci && npm run build`, start `npm start`, bind `0.0.0.0` and platform `PORT`, and serve production frontend assets. Include `/healthz`, one instance, caps, release commit ID, logs, rollback, and graceful cleanup. [Render deployment](https://render.com/docs/deploy-node-express-app), [Node version configuration](https://render.com/docs/node-version)

Verify progressive streaming and session limits through the host. Render free services sleep after fifteen idle minutes and can take about a minute to wake. State that limitation or choose an always-on tier with the owner’s budget authorization. The demo is not a durable refresh service. Use the host-provided domain. [Render free-instance limitations](https://render.com/docs/free)

Finish implementation, tests, and config before requesting missing hosting access/spending decisions. Deploy if authorized access exists; otherwise state the exact remaining step without claiming a live release.

Launch checklist:

- [ ] Required MCP-style schema, draft specification, docs, SEPs, community files, and generation/check workflow are present and synchronized.
- [ ] Public URL works without login/API keys and starts with the flight example.
- [ ] Own two-system descriptions, including supported MCP/A2A metadata, produce data-driven suggestions.
- [ ] Plug introduces components; the author need not prescribe cache or cron.
- [ ] A two-second live-source demand fails; eligible cached indicative results receive an appropriately qualified recommendation.
- [ ] Freshness, coverage, change behavior, quotas, and correctness alter recommendations.
- [ ] Report contains exact configuration, reasons, failure paths, adapter prerequisites, implementation tasks.
- [ ] Real deployed warmup/refresh retains source latency; valid warm reads show measured improvement.
- [ ] Cold/expired/failed-refresh cases cannot silently count as successful fast results.
- [ ] Cache-path measurements, estimated agent overhead, and unverified SLOs stay distinct.
- [ ] Submitted descriptions cannot trigger arbitrary calls; resources clean up on disconnect/cancel/restart.
- [ ] Clean checkout and packed-package customization work.
- [ ] README has verified URL, quickstart, supported patterns/importers, limitations, and feedback link.

Record commit, URL, verified cases, and limitations in `RELEASE_NOTES.md`. Collect minimal aggregate analyses, missing-information outcomes, demo completions, and quickstart usage. Learn from five outside users and two own-system integrations; these are targets, not claimed adoption.

## 15. After the alpha

Expand from demonstrated needs: local authenticated discovery, real MCP/A2A bindings, observed QoS/change profiles, more patterns, durable infrastructure adapters, or larger graphs. Event-driven invalidation and other patterns need applicability/evidence rules rather than generic advice.

**Codex handoff:** Implement **two systems + operational/data facts + UX → justified system design patterns → concrete implementation recipe → bounded executable proof** within the required MCP-style repository organization in section 11. The flight case is an acceptance test of the abstraction, not a hard-coded answer. Preserve public-release/local-adoption goals and keep specification, generated contracts, reference code, and SEPs synchronized. The original blueprint is future context; this revised scope and structure are the release plan.
