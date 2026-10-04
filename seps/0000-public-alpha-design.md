---
title: Public alpha system-design recommendations
status: draft
---

This is a provisional bootstrap proposal. No PR number or approval is claimed.

## Motivation

Connecting a slow system to a fast UX may require introduced infrastructure;
provider selection and orchestration order alone cannot solve the gap.

## Specification

Accept exactly two systems, explicit mappings, operational facts with evidence,
and required useful output. Evaluate direct, cache-aside, scheduled refresh,
progressive output and two bounded compositions. Format version is `0.1-alpha.2`.
Preserve unknowns, source age, protocol direction and hard UX requirements.

## Rationale

A deterministic catalog is explainable and testable. Exact-key policy replay avoids
confusing hot-key popularity with usable cache hits. Bounded execution demonstrates
mechanics while keeping production claims separate from synthetic evidence.

## Compatibility

This revised alpha replaces the earlier draft. No previous released snapshot is
present. Future dated snapshots map explicit serialized versions and stay immutable.

## Alternatives

An LLM architect, arbitrary DAG search, provider switching and durable distributed
execution remain deferred until demonstrated needs justify their complexity.

## Security implications

Analysis never calls user endpoints. Hosted execution binds only private fixtures;
limits, tokens, no remote schema fetching and cancellation isolate each sandbox.

## Implementation

The reference code is in `packages/plug`; the playground is in `apps/playground`.
The current draft specification describes supported behavior and limitations.

## Validation

See [recommender tests](../tests/recommender.test.ts),
[runtime tests](../tests/runtime.test.ts) and [API tests](../tests/api.test.ts).
This proposal remains draft pending actual owner review and release validation.
