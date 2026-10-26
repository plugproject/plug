import type {
  TypeSafeChoiceQuestion,
  TypeSafeNoulQuestion,
  TypeSafeQuestion,
} from '../judgment/index';

export const yesAt = 0.7;
export const noAt = 0.3;

export const reviewQuestionRegistry = {
  concernSupport: {
    type: 'noul',
    instructions:
      'Does `concern.cited_text` support the specific claim in `concern.text`?',
    criteria: {
      true: 'The cited text directly supports the stated concern.',
      false:
        'The citation is irrelevant, contradicts the concern, or needs facts that are not stated.',
    },
  } satisfies TypeSafeNoulQuestion,
  operationalConflict: {
    type: 'noul',
    instructions:
      'Does `architecture.operational_context` state a constraint that this `architecture.components` design violates?',
    criteria: {
      true: 'The supplied context states a concrete constraint the design violates.',
      false:
        'The context is compatible with the components or does not state such a constraint.',
    },
  } satisfies TypeSafeNoulQuestion,
  contextDistinguishes: {
    type: 'noul',
    instructions:
      'Does `operational_context` state a concrete requirement that distinguishes between the designs in `shortlist`?',
    criteria: {
      true: 'The context contains a requirement that favors some listed designs over others.',
      false:
        'The context is absent, generic, or does not distinguish the listed designs.',
    },
  } satisfies TypeSafeNoulQuestion,
} as const;

export const bestFitQuestion = (
  criteria: Record<string, string>,
): TypeSafeChoiceQuestion => ({
  type: 'choice',
  instructions:
    'Which design in `shortlist` best fits the concrete requirements in `operational_context`?',
  criteria,
});

export type ReviewQuestionSet = Record<string, TypeSafeQuestion>;
