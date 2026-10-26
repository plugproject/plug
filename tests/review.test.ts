import { describe, expect, it } from 'vitest';
import { flightInput } from '../packages/plug/src/demo/flight';
import {
  buildReviewBasis,
  decideReview,
  parseCritique,
  reviewerFromEnv,
  reviewCheckerFromEnv,
  reviewDesign,
  ReviewError,
  stubReviewProvider,
} from '../packages/plug/src/review/index';
import type {
  GatedCritique,
  ReviewJudgments,
} from '../packages/plug/src/review/index';
import { suggestDesign } from '../packages/plug/src/recommender/index';

const fixture = () => {
  const input = flightInput();
  input.systems[1].interfaces[0].endpoint =
    'https://secret.example.test/api?token=never-send';
  input.systems[1].metadata = {
    authorization: 'Bearer never-send',
  };
  const design = suggestDesign(input);
  const report = design.connections[0];
  const selected = report.architectures.find(
    (architecture) => architecture.id === report.selectedArchitectureId,
  )!;
  const alternative = {
    ...structuredClone(selected),
    id: `${selected.id}+review-alternative`,
    frontier: true,
    dominatedBy: null,
    components: [...selected.components, 'operator-owned-service'],
  };
  report.architectures.push(alternative);
  return {
    input,
    design,
    selected: selected.id,
    alternative: alternative.id,
  };
};
const emptyCritique = (): GatedCritique => ({
  concerns: [],
  preferred: null,
  alternatives: [],
  droppedClaims: 0,
});
const judgments = (over: Partial<ReviewJudgments> = {}): ReviewJudgments => ({
  model: 'jev-1.14.0',
  usage: { input_tokens: 10, output_tokens: 2 },
  concernSupport: [],
  operationalConflicts: {},
  contextDistinguishes: null,
  bestFit: null,
  bestFitProbabilities: {},
  ...over,
});

describe('design review basis and gates', () => {
  it('sends only a bounded report slice, never endpoints, headers or metadata', () => {
    const { input, design } = fixture();
    const basis = buildReviewBasis(
      input,
      design,
      input.connections[0].id,
      'The team cannot operate a queue.',
    );
    const text = JSON.stringify(basis);
    expect(text).not.toContain('secret.example');
    expect(text).not.toContain('never-send');
    expect(text).not.toContain('authorization');
    expect(basis.operationalContext).toContain('cannot operate');
  });

  it('keeps resolvable citations and drops invented claims and candidates', () => {
    const { input, design, selected } = fixture();
    const basis = buildReviewBasis(input, design, input.connections[0].id);
    const result = parseCritique(
      JSON.stringify({
        concerns: [
          {
            architectureId: selected,
            kind: 'latency',
            citation: 'relation.deadlineRisk',
            text: 'The direct path risks the deadline.',
          },
          {
            architectureId: selected,
            kind: 'cost',
            citation: 'relation.notARealFact',
            text: 'Invented.',
          },
          {
            architectureId: 'invented',
            kind: 'latency',
            citation: 'relation.deadlineRisk',
            text: 'Invented architecture.',
          },
        ],
        preferred: {
          architectureId: selected,
          citations: ['relation.deadlineRisk'],
        },
        alternatives: [
          { base: 'direct', patterns: ['timeout', 'timeout'] },
          { base: 3, patterns: [] },
        ],
      }),
      basis,
    );
    expect(result.concerns).toHaveLength(1);
    expect(result.concerns[0].citedText).toBeTruthy();
    expect(result.alternatives).toEqual([
      { base: 'direct', patterns: ['timeout'] },
    ]);
    expect(result.droppedClaims).toBe(3);
  });

  it('rejects malformed critic envelopes rather than guessing', () => {
    const { input, design } = fixture();
    const basis = buildReviewBasis(input, design, input.connections[0].id);
    for (const value of [
      'not-json',
      JSON.stringify({ concerns: [], alternatives: [], extra: true }),
      JSON.stringify({ concerns: 'none', alternatives: [] }),
    ])
      expect(() => parseCritique(value, basis)).toThrow(ReviewError);
  });
});

describe('code-owned review decisions', () => {
  it('uses Jev best fit only when context distinguishes an adoptable design', () => {
    const { input, design, selected, alternative } = fixture();
    const basis = buildReviewBasis(
      input,
      design,
      input.connections[0].id,
      'Prefer the operator-owned service.',
    );
    expect(
      decideReview(
        basis,
        emptyCritique(),
        judgments({
          contextDistinguishes: 0.9,
          bestFit: alternative,
          operationalConflicts: { [selected]: 0.1, [alternative]: 0.1 },
        }),
      ),
    ).toMatchObject({
      recommendation: alternative,
      disposition: 'recommend',
    });
    expect(
      decideReview(
        basis,
        emptyCritique(),
        judgments({
          contextDistinguishes: 0.5,
          bestFit: alternative,
        }),
      ),
    ).toMatchObject({
      recommendation: selected,
      disposition: 'engine-default',
    });
  });

  it('abstains when every feasible frontier design has a supported conflict', () => {
    const { input, design, selected, alternative } = fixture();
    const basis = buildReviewBasis(input, design, input.connections[0].id);
    expect(
      decideReview(
        basis,
        emptyCritique(),
        judgments({
          operationalConflicts: { [selected]: 0.8, [alternative]: 0.91 },
        }),
      ),
    ).toMatchObject({
      recommendation: null,
      disposition: 'abstain',
      adoptable: [],
    });
  });

  it('keeps the deterministic pick when Jev is not configured', async () => {
    const { input, design, selected } = fixture();
    const result = await reviewDesign(
      input,
      design,
      input.connections[0].id,
      stubReviewProvider(),
      null,
    );
    expect(result.decision).toMatchObject({
      recommendation: selected,
      disposition: 'engine-default',
    });
    expect(result.jevModel).toBeNull();
    expect(result.reviewHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('review provider selection', () => {
  it('is explicit and fail-closed', () => {
    expect(reviewerFromEnv({ PLUG_REVIEW_PROVIDER: 'stub' }).model).toBe(
      'stub-reviewer',
    );
    expect(reviewCheckerFromEnv({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(
      reviewCheckerFromEnv({
        TYPESAFE_API_KEY: 'k',
        PLUG_JUDGE_MODEL: 'jev-1.14.0',
      }),
    ).not.toBeNull();
    expect(() => reviewerFromEnv({})).toThrow(/No reviewer/);
    expect(() =>
      reviewCheckerFromEnv({
        PLUG_JUDGE_PROVIDER: 'typesafe',
        TYPESAFE_API_KEY: 'k',
      }),
    ).toThrow(/PLUG_JUDGE_MODEL/);
  });
});
