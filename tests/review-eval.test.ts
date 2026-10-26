import { describe, expect, it } from 'vitest';
import { hash } from '../packages/plug/src/recommender/policy';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import {
  buildReviewBasis,
  decideReview,
} from '../packages/plug/src/review/index';
import { loadReviewEvalCases } from './review-eval/cases';

describe('design-review evaluation invariants', () => {
  for (const testCase of loadReviewEvalCases())
    it(`${testCase.id}: never recommends outside the engine-verified adoptable set`, () => {
      const first = suggestDesign(testCase.input);
      const second = suggestDesign(structuredClone(testCase.input));
      expect(second).toEqual(first);
      const report = first.connections[0];
      expect(report.selectedArchitectureId).toBe(testCase.expectedEngine);
      const basis = buildReviewBasis(
        testCase.input,
        first,
        report.connectionId,
        testCase.operationalContext,
      );
      const decision = decideReview(
        basis,
        {
          concerns: [],
          preferred: null,
          alternatives: [],
          droppedClaims: 0,
        },
        null,
      );
      expect(decision.adoptable).toEqual(testCase.expectedAdoptable);
      if (decision.recommendation)
        expect(testCase.expectedAdoptable).toContain(decision.recommendation);
      for (const architectureId of decision.adoptable) {
        const architecture = report.architectures.find(
          (item) => item.id === architectureId,
        )!;
        expect(architecture.frontier).toBe(true);
        expect(architecture.status).toBe('feasible_under_declared_assumptions');
        expect(architecture.dominatedBy).toBeNull();
      }
      expect(
        hash(
          buildReviewBasis(
            structuredClone(testCase.input),
            second,
            report.connectionId,
            testCase.operationalContext,
          ),
        ),
      ).toBe(hash(basis));
    });
});
