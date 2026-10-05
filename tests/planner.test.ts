import { describe, it, expect } from 'vitest';
import { flightInput, fact } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import { deriveRelation } from '../packages/plug/src/recommender/relation';
import {
  comparePriorities,
  dominates,
  evaluatePatterns,
  planArchitectures,
} from '../packages/plug/src/recommender/planner';
import { knowledge } from '../packages/plug/src/patterns/knowledge';
import type {
  Candidate,
  DesignInput,
  RelationFacts,
  RelationPredicate,
  TradeoffVector,
} from '../packages/plug/src/contracts/index';
const flight = () => {
  const input = flightInput();
  return { input, report: suggestDesign(input).connections[0] };
};
const relationWith = (
  overrides: Partial<Record<RelationPredicate, boolean | null>>,
  input: DesignInput = flightInput(),
): RelationFacts => {
  const relation = deriveRelation(input, input.connections[0]);
  for (const [k, v] of Object.entries(overrides))
    relation[k as RelationPredicate] = {
      value: v,
      reason: `Test sets ${k}.`,
      evidence: [],
    };
  return relation;
};
const applicability = (relation: RelationFacts, candidates: Candidate[]) =>
  Object.fromEntries(
    evaluatePatterns(relation, candidates, null).map((e) => [
      e.id,
      e.applicability,
    ]),
  );
const vector = (v: Partial<TradeoffVector>): TradeoffVector => ({
  usefulLatencyMs: 100,
  trafficSuccessRate: 0.9,
  costPerMinute: null,
  consistencyWeakening: 1,
  runtimeCoupling: 1,
  operationalComplexity: 1,
  statefulness: 1,
  componentCount: 3,
  ...v,
});

describe('relation engine', () => {
  it('derives the flight relation without unknowns', () => {
    const { report } = flight();
    expect(report.relation.deadlineRisk.value).toBe(true);
    expect(report.relation.capacityMismatch.value).toBe(true);
    expect(report.relation.burstMismatch.value).toBe(true);
    expect(report.relation.protocolCompatible.value).toBe(true);
    expect(report.relation.trustBoundaryCrossed.value).toBe(false);
    expect(
      Object.values(report.relation).filter((f) => f.value === null),
    ).toEqual([]);
  });
  it('keeps undeclared facts unknown rather than false', () => {
    const input = flightInput();
    delete input.systems[1].trustDomain;
    delete input.systems[1].messaging;
    delete input.systems[1].operations[0].interaction;
    input.connections[0].workload.burstPerMinute = fact(null);
    input.connections[0].experience.firstAckMs = null;
    const r = suggestDesign(input).connections[0];
    expect(r.relation.trustBoundaryCrossed.value).toBeNull();
    expect(r.relation.duplicateDeliveryPossible.value).toBeNull();
    expect(r.relation.laterResultPath.value).toBeNull();
    expect(r.relation.burstMismatch.value).toBeNull();
    expect(r.relation.firstResponseGap.value).toBeNull();
    expect(r.selectedArchitectureId).toBeNull();
    for (const a of r.architectures.filter((a) => a.status !== 'infeasible')) {
      expect(a.status).not.toBe('feasible_under_declared_assumptions');
      expect(a.proof.unknowns.join(' ')).toContain('trust domain');
    }
    expect(r.missingInformation.join(' ')).toContain('trust domain');
  });
  it('treats an exactly-once claim as unproven', () => {
    const input = flightInput();
    input.systems[1].messaging!.delivery = 'exactly-once-claimed';
    expect(
      deriveRelation(input, input.connections[0]).duplicateDeliveryPossible
        .value,
    ).toBeNull();
  });
});

describe('pattern knowledge base', () => {
  it('contraindicates retry for unsafe writes and keeps circuit breaker', () => {
    const { report } = flight();
    const a = applicability(
      relationWith({ availabilityShortfall: true, unsafeRetry: true }),
      report.candidates,
    );
    expect(a['retry-backoff']).toBe('contraindicated');
    expect(a['circuit-breaker']).toBe('required');
  });
  it('closes retry obligations and prefers the simpler non-dominated stack', () => {
    const { report } = flight();
    const plan = planArchitectures(
      report.candidates,
      relationWith({ availabilityShortfall: true }),
      ['correctness', 'simplicity'],
      null,
    );
    const retry = plan.architectures.find(
      (a) => a.id === 'scheduled-cache+retry-backoff+timeout',
    )!;
    const breaker = plan.architectures.find(
      (a) => a.id === 'scheduled-cache+circuit-breaker+timeout',
    )!;
    expect(retry.status).toBe('feasible_under_declared_assumptions');
    expect(retry.obligations).toContainEqual({
      id: 'duplicate_attempts',
      coveredBy: null,
      dischargedBy: 'unsafeRetry',
    });
    expect(retry.obligations).toContainEqual({
      id: 'bounded_attempt',
      coveredBy: 'timeout',
      dischargedBy: null,
    });
    expect(retry.frontier).toBe(true);
    expect(breaker.frontier).toBe(false);
    expect(breaker.dominatedBy).toBe(retry.id);
    expect(plan.selectedArchitectureId).toBe(retry.id);
  });
  it('requires an idempotent consumer when an outbox may redeliver effects', () => {
    const { report } = flight();
    const plan = planArchitectures(
      report.candidates,
      relationWith({ atomicPublishRequired: true, sideEffecting: null }),
      ['correctness'],
      null,
    );
    const ids = plan.architectures.map((a) => a.id);
    expect(ids).toContain(
      'scheduled-cache+transactional-outbox+outbox-relay+idempotent-consumer',
    );
    const discharged = planArchitectures(
      report.candidates,
      relationWith({ atomicPublishRequired: true }),
      ['correctness'],
      null,
    );
    expect(discharged.selectedArchitectureId).toBe(
      'scheduled-cache+transactional-outbox+outbox-relay',
    );
  });
  it('async request-reply needs a later-result path and is never acknowledgement-only', () => {
    const { report } = flight();
    const base = { firstResponseGap: true, deferredAllowed: true };
    expect(
      applicability(
        relationWith({ ...base, laterResultPath: false }),
        report.candidates,
      )['async-request-reply'],
    ).toBe('contraindicated');
    expect(
      applicability(
        relationWith({ ...base, laterResultPath: null }),
        report.candidates,
      )['async-request-reply'],
    ).toBe('unknown');
    const plan = planArchitectures(
      report.candidates,
      relationWith({ ...base, laterResultPath: true }),
      ['correctness'],
      null,
    );
    const arr = plan.architectures.find((a) =>
      a.patterns.includes('async-request-reply'),
    )!;
    expect(arr.patterns).toEqual(
      expect.arrayContaining(['correlation-identifier', 'timeout']),
    );
    expect(arr.tasks.join(' ')).toContain(
      'An acknowledgement is not useful output',
    );
    const blocked = planArchitectures(
      report.candidates,
      relationWith({ ...base, laterResultPath: false }),
      ['correctness'],
      null,
    );
    expect(blocked.selectedArchitectureId).toBeNull();
    expect(blocked.architectures.every((a) => a.status === 'infeasible')).toBe(
      true,
    );
  });
  it('reports global patterns as needing global context and never selects them', () => {
    const { report } = flight();
    const globals = knowledge
      .filter((k) => k.scope === 'global')
      .map((k) => k.id);
    expect(globals.length).toBeGreaterThan(0);
    for (const id of globals) {
      expect(report.patterns.find((p) => p.id === id)?.applicability).toBe(
        'needs_global_context',
      );
      expect(report.architectures.some((a) => a.patterns.includes(id))).toBe(
        false,
      );
    }
  });
  it('never trades away a trust boundary', () => {
    const { report } = flight();
    const plan = planArchitectures(
      report.candidates,
      relationWith({ trustBoundaryCrossed: true }),
      ['cost', 'simplicity'],
      null,
    );
    expect(plan.selectedArchitectureId).toBe(
      'scheduled-cache+boundary-authentication',
    );
  });
});

describe('frontier and ranking', () => {
  it('does not dominate across an unknown dimension present in only one vector', () => {
    expect(dominates(vector({ componentCount: 2 }), vector({}))).toBe(true);
    expect(
      dominates(
        vector({ componentCount: 2 }),
        vector({ usefulLatencyMs: null }),
      ),
    ).toBe(false);
    expect(dominates(vector({}), vector({}))).toBe(false);
  });
  it('a priority flip changes selection between non-dominated designs', () => {
    const { report } = flight();
    const scheduled = report.candidates.find(
      (c) => c.id === 'scheduled-cache',
    )!;
    const candidates = report.candidates.map((c) =>
      c.id === 'cache-aside'
        ? {
            ...structuredClone(c),
            status: 'feasible_under_declared_assumptions' as const,
            estimates: structuredClone(scheduled.estimates),
            criteria: structuredClone(scheduled.criteria),
          }
        : c,
    );
    const relation = relationWith({ burstMismatch: false });
    const pick = (p: Parameters<typeof planArchitectures>[2]) =>
      planArchitectures(candidates, relation, p, null);
    expect(pick(['correctness', 'availability']).selectedArchitectureId).toBe(
      'scheduled-cache',
    );
    expect(pick(['correctness', 'simplicity']).selectedArchitectureId).toBe(
      'cache-aside',
    );
    expect(pick(['correctness']).policyDecisionNeeded).toBe(true);
    expect(pick(['correctness', 'simplicity']).policyDecisionNeeded).toBe(
      false,
    );
    expect(
      comparePriorities(
        vector({ costPerMinute: 1 }),
        vector({ costPerMinute: 2 }),
        ['cost'],
      ),
    ).toBeLessThan(0);
  });
  it('is deterministic and keeps the infeasible tier off the frontier', () => {
    const a = suggestDesign(flightInput()),
      b = suggestDesign(JSON.parse(JSON.stringify(flightInput())));
    expect(a).toEqual(b);
    const r = a.connections[0];
    expect(r.architectures.map((x) => x.id)).toEqual(
      b.connections[0].architectures.map((x) => x.id),
    );
    for (const x of r.architectures.filter((x) => x.status === 'infeasible'))
      expect(x.frontier).toBe(false);
    expect(
      r.architectures.find((x) => x.id === 'scheduled-cache-aside')
        ?.dominatedBy,
    ).toBe('scheduled-cache');
  });
});

describe('multiple connections', () => {
  it('checks a shared downstream quota across connections', () => {
    const input = flightInput();
    input.systems.push({
      ...structuredClone(input.systems[0]),
      id: 'agent-2',
      name: 'Second agent',
    });
    input.connections.push({
      ...structuredClone(input.connections[0]),
      id: 'second',
      callerSystemId: 'agent-2',
    });
    const design = suggestDesign(input);
    expect(design.connections.map((c) => c.connectionId)).toEqual([
      'primary',
      'second',
    ]);
    const single = design.connections[0].candidates.find(
      (c) => c.id === design.connections[0].selectedId,
    )!.estimates.callsPerMinute!;
    const shared = design.crossConnection.find(
      (c) => c.id === 'shared-quota:aggregator/search',
    )!;
    expect(shared.actual).toBe(single * 2);
    expect(shared.required).toBe(
      input.connections[0].profile.callsPerMinute.value,
    );
    expect(shared.verdict).toBe(
      single * 2 <= (shared.required as number)
        ? 'pass_under_assumptions'
        : 'fail',
    );
  });
});
