import { describe, it, expect } from 'vitest';
import { flightInput, fact } from '../packages/plug/src/demo/flight';
import {
  catalogVersion,
  suggestDesign,
  explainDesign,
} from '../packages/plug/src/recommender/index';
import {
  exactKey,
  hash,
  makeSchedule,
  replayCoverage,
} from '../packages/plug/src/recommender/policy';
import { deriveRelation } from '../packages/plug/src/recommender/relation';
import type {
  DesignInput,
  PatternId,
} from '../packages/plug/src/contracts/index';
const cx = (input: DesignInput) => input.connections[0];
const report = (input: DesignInput) => suggestDesign(input).connections[0];
const candidate = (input: DesignInput, id: PatternId = 'scheduled-cache') =>
  report(input).candidates.find((c) => c.id === id)!;
describe('relation facts', () => {
  it('derives protocol compatibility from any calls interface of the caller system', () => {
    const input = flightInput();
    const c = cx(input);
    const caller = input.systems.find((s) => s.id === c.callerSystemId)!;
    const op = caller.operations.find((o) => o.id === c.callerOperationId)!;
    // The indexed-draft shape: the caller operation sits on an exposes interface.
    const client = caller.interfaces.find((i) => i.direction === 'calls')!;
    caller.interfaces = [
      { ...client, id: 'own-api', direction: 'exposes' },
      client,
    ];
    op.interfaceId = 'own-api';
    const relation = deriveRelation(input, c);
    expect(relation.protocolCompatible.value).toBe(true);
    expect(relation.protocolCompatible.reason).toContain(client.id);
    // Without any matching calls interface the connection is incompatible.
    caller.interfaces = [{ ...client, id: 'own-api', direction: 'exposes' }];
    const without = deriveRelation(input, c);
    expect(without.protocolCompatible.value).toBe(false);
    expect(without.protocolCompatible.reason).toContain(
      'no caller interface matches',
    );
  });
  it('lets a pinned judgment qualify differing semantic texts, and only that', () => {
    const judged = (equivalent: boolean, outputMeaning: string) => ({
      equivalent,
      outputMeaning,
      usefulOutput: 'flight options, indicative',
      evidence: {
        kind: 'judged' as const,
        note: 'test-model: the denoted result is the same.',
        confidence: 0.9,
      },
    });
    const differing = () => {
      const input = flightInput();
      cx(input).experience.usefulOutput = 'flight options, indicative';
      return input;
    };
    // Strict comparison without a judgment: differing strings fail.
    const strict = differing();
    expect(deriveRelation(strict, cx(strict)).semanticMatch.value).toBe(false);
    // A judgment pinned to exactly these strings qualifies the verdict.
    const input = differing();
    cx(input).semanticEquivalence = judged(true, 'indicative flight options');
    const relation = deriveRelation(input, cx(input));
    expect(relation.semanticMatch.value).toBe(true);
    expect(relation.semanticMatch.reason).toContain('Judged equivalent');
    expect(
      relation.semanticMatch.evidence.some((e) => e.kind === 'judged'),
    ).toBe(true);
    const semantics = candidate(input, 'direct').criteria.find(
      (criterion) => criterion.id === 'semantics',
    )!;
    expect(semantics.verdict).toBe('pass_under_assumptions');
    expect(semantics.evidence!.some((e) => e.kind === 'judged')).toBe(true);
    // A judgment pinned to other text is void: the strict comparison rules.
    const stale = differing();
    cx(stale).semanticEquivalence = judged(true, 'something else entirely');
    expect(deriveRelation(stale, cx(stale)).semanticMatch.value).toBe(false);
    expect(deriveRelation(stale, cx(stale)).semanticMatch.reason).toContain(
      'compared with required',
    );
    // A negative judgment keeps the failure and carries its evidence.
    const negative = differing();
    cx(negative).semanticEquivalence = judged(
      false,
      'indicative flight options',
    );
    const no = deriveRelation(negative, cx(negative));
    expect(no.semanticMatch.value).toBe(false);
    expect(no.semanticMatch.reason).toContain('not equivalent');
  });
});
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

describe('author architecture adoption', () => {
  const evidence = {
    kind: 'declared' as const,
    note: 'Adopted by the author in a test.',
  };
  const adopt = (
    input: DesignInput,
    architectureId: string,
    patterns: string[],
    version = catalogVersion,
  ) => {
    cx(input).adoptedArchitecture = {
      architectureId,
      patterns,
      catalogVersion: version,
      evidence,
    };
  };

  it('omits optional adoption fields and preserves the flight design hash', () => {
    const design = suggestDesign(flightInput());
    const connection = design.connections[0];
    expect(design.designHash).toBe(
      '19667d19c6f9148485d3db4eb98bba6c41b2a228270de53b00ebce415696ba3d',
    );
    expect(Object.hasOwn(connection, 'adoption')).toBe(false);
    expect(Object.hasOwn(connection, 'adoptedArchitectureId')).toBe(false);
    expect(
      connection.architectures.some((architecture) =>
        Object.hasOwn(architecture, 'origin'),
      ),
    ).toBe(false);
  });

  it('honors an existing architecture by canonical pattern set', () => {
    const input = flightInput();
    input.systems[1].trustDomain = 'external';
    const initial = suggestDesign(input);
    const initialConnection = initial.connections[0];
    const selected = initialConnection.architectures.find(
      (architecture) =>
        architecture.id === initialConnection.selectedArchitectureId,
    )!;
    expect(selected.patterns.length).toBeGreaterThan(1);
    adopt(
      input,
      selected.id,
      [...selected.patterns].reverse(),
      initial.catalogVersion,
    );

    const analyzed = suggestDesign(input).connections[0];
    expect(analyzed.adoption).toMatchObject({ status: 'honored' });
    expect(analyzed.adoptedArchitectureId).toBe(selected.id);
    expect(analyzed.selectedArchitectureId).toBe(selected.id);
    expect(
      analyzed.architectures.find(
        (architecture) => architecture.id === selected.id,
      )?.patterns,
    ).toEqual(selected.patterns);
  });

  it('inserts an adopted stack before dominance and reports dominated', () => {
    const input = flightInput();
    adopt(input, 'scheduled-cache+timeout', ['timeout', 'scheduled-cache']);
    const analyzed = suggestDesign(input).connections[0];
    const inserted = analyzed.architectures.find(
      (architecture) => architecture.id === 'scheduled-cache+timeout',
    );
    expect(inserted).toMatchObject({
      origin: 'adopted',
      frontier: false,
      dominatedBy: 'scheduled-cache',
      patterns: ['scheduled-cache', 'timeout'],
    });
    expect(analyzed.adoption).toMatchObject({ status: 'dominated' });
    expect(Object.hasOwn(analyzed, 'adoptedArchitectureId')).toBe(false);
    expect(analyzed.selectedArchitectureId).toBe('scheduled-cache');
  });

  it('reports infeasible and conditional adoptions as not feasible', () => {
    const infeasible = flightInput();
    adopt(infeasible, 'direct', ['direct']);
    expect(report(infeasible).adoption).toMatchObject({
      status: 'not_feasible',
    });

    const conditional = flightInput();
    cx(conditional).profile.responseBytes = fact(null);
    adopt(conditional, 'scheduled-cache', ['scheduled-cache']);
    const analyzed = report(conditional);
    expect(
      analyzed.architectures.find(
        (architecture) => architecture.id === 'scheduled-cache',
      )?.status,
    ).toBe('conditional');
    expect(analyzed.adoption).toMatchObject({ status: 'not_feasible' });
    expect(Object.hasOwn(analyzed, 'adoptedArchitectureId')).toBe(false);
  });

  it('reports unknown architectures and catalog changes explicitly', () => {
    const unknown = flightInput();
    adopt(unknown, 'scheduled-cache+unknown-pattern', [
      'scheduled-cache',
      'unknown-pattern',
    ]);
    const unknownReport = report(unknown);
    expect(unknownReport.adoption).toMatchObject({
      status: 'unknown_architecture',
    });
    expect(unknownReport.adoption?.reason).toContain('unknown-pattern');

    const changed = flightInput();
    adopt(changed, 'scheduled-cache', ['scheduled-cache'], 'old-catalog');
    const changedReport = report(changed);
    expect(changedReport.adoption).toMatchObject({
      status: 'catalog_changed',
    });
    expect(changedReport.adoption?.reason).toContain(catalogVersion);
    expect(Object.hasOwn(changedReport, 'adoptedArchitectureId')).toBe(false);
  });

  it('invalidates an honored adoption when reanalysis makes it infeasible', () => {
    const input = flightInput();
    adopt(input, 'scheduled-cache', ['scheduled-cache']);
    expect(report(input).adoption).toMatchObject({ status: 'honored' });

    input.infrastructure.cacheAllowed = false;
    const reanalyzed = report(input);
    expect(reanalyzed.adoption).toMatchObject({ status: 'not_feasible' });
    expect(Object.hasOwn(reanalyzed, 'adoptedArchitectureId')).toBe(false);
    expect(reanalyzed.selectedArchitectureId).not.toBe('scheduled-cache');
  });
});

it('analyzes two hundred connections without a count ceiling', () => {
  const input = flightInput();
  const template = input.connections[0];
  const operation = input.systems[0].operations[0];
  input.systems[0].operations = Array.from({ length: 200 }, (_, index) => ({
    ...structuredClone(operation),
    id: `caller-operation-${index + 1}`,
  }));
  input.connections = Array.from({ length: 200 }, (_, index) => ({
    ...structuredClone(template),
    id: `connection-${index + 1}`,
    callerOperationId: `caller-operation-${index + 1}`,
  }));
  const started = performance.now();
  const design = suggestDesign(input);
  expect(design.connections).toHaveLength(200);
  expect(performance.now() - started).toBeLessThan(2000);
});
