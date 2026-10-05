import { describe, it, expect } from 'vitest';
import { flightInput, fact } from '../packages/plug/src/demo/flight';
import {
  suggestDesign,
  explainDesign,
} from '../packages/plug/src/recommender/index';
import {
  exactKey,
  hash,
  makeSchedule,
  replayCoverage,
} from '../packages/plug/src/recommender/policy';
import type {
  DesignInput,
  PatternId,
} from '../packages/plug/src/contracts/index';
const cx = (input: DesignInput) => input.connections[0];
const report = (input: DesignInput) => suggestDesign(input).connections[0];
const candidate = (input: DesignInput, id: PatternId = 'scheduled-cache') =>
  report(input).candidates.find((c) => c.id === id)!;
describe('architecture evaluation', () => {
  it('introduces scheduled cache from slow-source facts and replays each policy separately', () => {
    const input = flightInput(),
      r = report(input),
      cache = candidate(input);
    expect(r.selectedId).toBe('scheduled-cache');
    expect(r.selectedArchitectureId).toBe('scheduled-cache');
    expect(cache.config.refreshIntervalMs).toBe(60000);
    expect(cache.estimates.ageEnvelopeMs).toBe(86000);
    expect(cache.estimates.usableHitRate).toBe(0.98);
    expect(cache.estimates.trafficSuccessRate).toBeCloseTo(0.9702);
    expect(
      candidate(input, 'cache-aside').estimates.usableHitRate,
    ).toBeLessThan(0.9);
    expect(candidate(input, 'direct').status).toBe('infeasible');
    expect(r.costRankingAvailable).toBe(false);
    expect(explainDesign(suggestDesign(input))).toContain('```mermaid');
  });
  it('is deterministic under object key reordering and changes hash for facts', () => {
    const input = flightInput();
    expect(suggestDesign(input)).toEqual(
      suggestDesign(JSON.parse(JSON.stringify(input))),
    );
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    const before = suggestDesign(input);
    cx(input).experience.maxAgeMs = 100000;
    expect(suggestDesign(input).designHash).not.toBe(before.designHash);
  });
  it.each([
    'live',
    'five-second-age',
    'no-cache',
    'write',
    'low-quota',
    'every-request',
    'scope',
    'key',
    'low-coverage',
  ] as const)('rejects known violation %s', (scenario) => {
    const input = flightInput(),
      c = cx(input);
    if (scenario === 'live') c.experience.correctness = 'live';
    if (scenario === 'five-second-age') c.experience.maxAgeMs = 5000;
    if (scenario === 'no-cache') input.infrastructure.cacheAllowed = false;
    if (scenario === 'write')
      input.systems[1].operations[0].semantics.effect = 'write';
    if (scenario === 'low-quota') c.profile.callsPerMinute = fact(1);
    if (scenario === 'every-request') c.experience.scope = 'everyRequest';
    if (scenario === 'scope') {
      input.systems[1].operations[0].semantics.scope = 'user';
    }
    if (scenario === 'key')
      input.systems[1].operations[0].semantics.keysComplete = false;
    if (scenario === 'low-coverage')
      c.workload.hotKeyShare = {
        value: 0.5,
        evidence: c.workload.traceEvidence,
      };
    expect(candidate(input).status).toBe('infeasible');
  });
  it('does not infer permission, coverage or source lag', () => {
    const input = flightInput();
    input.systems[1].operations[0].semantics.cachePermission = null;
    expect(candidate(input).status).toBe('insufficient_information');
    input.systems[1].operations[0].semantics.cachePermission = true;
    cx(input).workload.trace = null;
    expect(candidate(input).status).toBe('conditional');
    cx(input).profile.sourceLagMs = fact(null);
    expect(
      candidate(input).criteria.find((c) => c.id === 'age-bound')?.verdict,
    ).toBe('unknown');
  });
  it('changing cadence, cache capacity and change frequency recomputes replay', () => {
    const input = flightInput();
    cx(input).profile.callsPerMinute = fact(20);
    cx(input).profile.changeIntervalMs = fact(60000);
    expect(candidate(input).config.refreshIntervalMs).toBe(30000);
    cx(input).profile.changeIntervalMs = fact(30000);
    expect(candidate(input).tradeoffs.join(' ')).toContain('half-change');
    input.infrastructure.cacheCapacity = 1;
    expect(candidate(input).status).toBe('infeasible');
  });
  it('requires adapter overhead and preserves protocol direction', () => {
    const input = flightInput();
    input.systems[0].interfaces[0].direction = 'exposes';
    const c = candidate(input);
    expect(c.status).toBe('conditional');
    expect(c.estimates.usefulLatencyMs).toBeNull();
    expect(c.prerequisites.join(' ')).toContain('ADAPTER_REQUIRED');
    cx(input).adapter = { supplied: true, overheadMs: fact(2000) };
    expect(candidate(input).status).toBe('infeasible');
  });
  it('requires structured schema mappings rather than matching prose', () => {
    const input = flightInput();
    input.systems[1].operations[0].outputSchema = null;
    expect(candidate(input).status).toBe('insufficient_information');
  });
  it('includes live composition quota and rejects a spinner', () => {
    const input = flightInput(),
      x = cx(input).experience;
    x.allowDeferred = true;
    x.initialOutput = {
      meaning: x.usefulOutput,
      useful: false,
      latencyMs: fact(10),
      evidence: cx(input).profile.latencyMs.evidence,
    };
    expect(
      candidate(input, 'progressive').criteria.find(
        (c) => c.id === 'initial-useful',
      )?.verdict,
    ).toBe('fail');
    expect(candidate(input, 'cached-live').estimates.callsPerMinute).toBe(50);
    expect(
      candidate(input, 'cached-live').criteria.find((c) => c.id === 'quota')
        ?.verdict,
    ).toBe('fail');
  });
  it('does not reuse a mismatched observed policy hash', () => {
    const input = flightInput(),
      w = cx(input).workload;
    w.trace = null;
    w.usableHitObservation = {
      policyHash: 'wrong',
      hitRate: { value: 1, evidence: cx(input).profile.latencyMs.evidence },
    };
    expect(candidate(input).estimates.usableHitRate).toBeNull();
  });
  it('never treats hot share alone as usable traffic evidence', () => {
    const input = flightInput();
    cx(input).workload.trace = null;
    cx(input).workload.hotKeyShare.value = 1;
    expect(candidate(input).estimates.trafficSuccessRate).toBeNull();
  });
  it('scheduling disabled cannot donate prewarm hits to cache-aside', () => {
    const input = flightInput();
    input.infrastructure.schedulingAllowed = false;
    expect(candidate(input).status).toBe('infeasible');
    expect(candidate(input, 'cache-aside').status).toBe('infeasible');
  });
  it('validates cyclic concurrency, per-key overlap and exact scope', () => {
    const keys = cx(flightInput()).workload.prewarmKeys!;
    expect(makeSchedule(keys, 30000, 20000, 1)).toBeNull();
    expect(makeSchedule(keys, 10000, 20000, 2)).toBeNull();
    expect(makeSchedule(keys, 60000, 25000, 1)).toHaveLength(2);
    expect(() => exactKey({ route: 'x' }, ['route'], 'user')).toThrow();
    expect(exactKey({ userId: 'a' }, ['userId'], 'user')).not.toBe(
      exactKey({ userId: 'b' }, ['userId'], 'user'),
    );
  });
  it('replay accounts for cache-aside expiry/refill and scheduled warmup explicitly', () => {
    const input = flightInput(),
      c = candidate(input, 'cache-aside');
    const w = {
      ...cx(input).workload,
      measurementStartMs: 0,
      trace: [0, 10000, 25000, 88000, 90000, 120000].map((atMs) => ({
        atMs,
        key: cx(input).workload.prewarmKeys![0],
      })),
    };
    expect(replayCoverage(c.config, w, 20000)).toBeCloseTo(3 / 6);
  });
});

it('evaluates direct and progressive designs with independent complete-path evidence', () => {
  const input = flightInput(),
    c = cx(input),
    x = c.experience;
  c.workload.requestsPerMinute = fact(1);
  c.workload.burstPerMinute = fact(1);
  c.profile.latencyMs = fact(100);
  c.profile.timeoutMs = fact(200);
  x.directWithinTarget = {
    thresholdMs: 2000,
    fraction: { value: 0.99, evidence: c.profile.latencyMs.evidence },
  };
  expect(candidate(input, 'direct').status).toBe(
    'feasible_under_declared_assumptions',
  );
  x.latencyTargetMs = 1000;
  expect(candidate(input, 'direct').status).toBe('conditional');
  x.latencyTargetMs = 2000;
  c.profile.latencyMs = fact(15000);
  c.profile.timeoutMs = fact(20000);
  x.allowDeferred = true;
  x.usefulOutput = 'local shortlist';
  x.initialOutput = {
    meaning: 'local shortlist',
    useful: true,
    latencyMs: fact(20),
    evidence: c.profile.latencyMs.evidence,
    withinTarget: {
      thresholdMs: 2000,
      fraction: { value: 0.99, evidence: c.profile.latencyMs.evidence },
    },
  };
  expect(candidate(input, 'progressive').status).toBe(
    'feasible_under_declared_assumptions',
  );
});
it('cannot reuse hit probability at a stricter latency threshold', () => {
  const input = flightInput();
  cx(input).experience.latencyTargetMs = 1500;
  expect(
    candidate(input).criteria.find((c) => c.id === 'traffic-slo')?.verdict,
  ).toBe('unknown');
});
it('preserves unsupported schemas as an evaluation prerequisite', () => {
  const input = flightInput();
  input.systems[1].operations[0].inputSchema!.$schema =
    'https://example.test/future-dialect';
  expect(
    candidate(input).criteria.find((c) => c.id === 'contract')?.verdict,
  ).toBe('unknown');
});
