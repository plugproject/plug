import { askTypeSafe, type TypeSafeQuestion } from '../judgment/index';
import type { JsonValue, ResponseBinding } from '../contracts/index';

export const probeQuestionThresholds = Object.freeze({
  yes: 0.7,
  no: 0.3,
});

export type ThreeWayAnswer = true | false | null;

export function classifyNoul(probability: number): ThreeWayAnswer {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error('A Noul probability must be between zero and one.');
  if (probability >= probeQuestionThresholds.yes) return true;
  if (probability <= probeQuestionThresholds.no) return false;
  return null;
}

export interface TimestampQuestionCandidate {
  pointer: string;
  format: ResponseBinding['timestampFormat'];
}

export interface ProbeQuestionInput {
  operationDescription: string;
  outputMeaning: string | null;
  usefulOutputs: string[];
  responseSamples: { observedAt: string; sample: JsonValue }[];
  timestampCandidates: TimestampQuestionCandidate[];
  errorSamples: { status: number; observedAt: string; sample: JsonValue }[];
}

interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

type ProbeQuestion = NoulQuestion | ChoiceQuestion;

const errorCriteria = Object.freeze({
  rate_limited: 'The response says the caller is rate limited or over quota.',
  authentication:
    'The response says credentials are missing, invalid or unauthorized.',
  authorization: 'The response says the authenticated caller lacks permission.',
  not_found: 'The requested resource does not exist.',
  validation: 'The request or one of its supplied values is invalid.',
  transient: 'The response reports a temporary dependency or service failure.',
  other: 'The response is an error but none of the other classes applies.',
});

/** Every sentence sent to Jev lives in this registry. */
export const probeQuestionWording = Object.freeze({
  useful: {
    instructions:
      'Do the bounded `response_samples` contain the useful result requested in `useful_outputs`, rather than an acknowledgement, progress message, placeholder or error?',
    criteria: {
      true: 'At least one sample contains the requested useful result for the operation.',
      false:
        'The samples contain only errors, acknowledgements, progress, placeholders, or a different result.',
    },
  },
  timestampChoice:
    'Which `timestamp_candidates` field states when the returned source data was captured, rather than when the response was observed, created, cached or transmitted?',
  timestampCompanion: {
    instructions:
      'Does at least one field in `timestamp_candidates` state the source-data snapshot time?',
    criteria: {
      true: 'A listed field directly states when the returned source data was captured.',
      false:
        'No listed field is a source-data snapshot time, or the distinction is unclear.',
    },
  },
  timestampOption: (pointer: string) =>
    `The response field at JSON pointer ${JSON.stringify(pointer)}.`,
  errorChoice:
    'Which class best describes the bounded response in `error_samples`?',
  errorCompanion: {
    instructions:
      'Do the bounded `error_samples` actually represent an operation error?',
    criteria: {
      true: 'The response reports that the requested operation failed.',
      false:
        'The response is successful, informational, or too ambiguous to classify as an error.',
    },
  },
  errorCriteria,
});

export const probeQuestionNames = Object.freeze({
  useful: 'useful_output',
  timestampChoice: 'source_timestamp_field',
  timestampCompanion: 'source_timestamp_confirmed',
  errorChoice: 'error_class',
  errorCompanion: 'error_confirmed',
});

export interface ProbeQuestionBundle {
  state: {
    operation_description: string;
    declared_output_meaning: string | null;
    useful_outputs: string[];
    response_samples: { observed_at: string; sample: JsonValue }[];
    timestamp_candidates: {
      option: string;
      pointer: string;
      format: ResponseBinding['timestampFormat'];
    }[];
    error_samples: {
      status: number;
      observed_at: string;
      sample: JsonValue;
    }[];
  };
  questions: Record<string, ProbeQuestion>;
  timestampOptions: Record<string, TimestampQuestionCandidate>;
}

const boundText = (text: string, length: number) =>
  text.trim().slice(0, length);
const sensitiveStateKey =
  /(?:authorization|cookie|password|secret|token|api[-_]?key|credential)/i;

function boundedStateValue(
  value: JsonValue,
  budget = { remaining: 16 * 1024 },
  key = '',
  depth = 0,
): JsonValue {
  if (sensitiveStateKey.test(key.trim())) return '[redacted]';
  if (budget.remaining <= 0 || depth > 10) return '[truncated]';
  if (typeof value === 'string') {
    const bounded = value.slice(0, Math.min(2_048, budget.remaining));
    budget.remaining -= bounded.length + 2;
    return bounded;
  }
  if (typeof value === 'number') {
    budget.remaining -= 24;
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean' || value === null) {
    budget.remaining -= 5;
    return value;
  }
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) => boundedStateValue(item, budget, '', depth + 1));
  const bounded: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [childKey, child] of Object.entries(value).slice(0, 100)) {
    if (budget.remaining <= 0) break;
    budget.remaining -= childKey.length + 3;
    bounded[childKey] = boundedStateValue(child, budget, childKey, depth + 1);
  }
  return bounded;
}

/** Pure builder for one bundled request for an operation. */
export function buildProbeQuestionBundle(
  input: ProbeQuestionInput,
): ProbeQuestionBundle {
  const timestampOptions: Record<string, TimestampQuestionCandidate> = {};
  const timestampCriteria: Record<string, string> = {};
  const timestampCandidates = input.timestampCandidates
    .slice(0, 32)
    .map((candidate, index) => {
      const option = `candidate_${index + 1}`;
      const pointer = boundText(candidate.pointer, 500);
      timestampOptions[option] = { ...candidate, pointer };
      timestampCriteria[option] = probeQuestionWording.timestampOption(pointer);
      return { option, pointer, format: candidate.format };
    });
  const state: ProbeQuestionBundle['state'] = {
    operation_description: boundText(input.operationDescription, 2_000),
    declared_output_meaning:
      input.outputMeaning === null
        ? null
        : boundText(input.outputMeaning, 2_000),
    useful_outputs: input.usefulOutputs
      .map((value) => boundText(value, 2_000))
      .filter(Boolean)
      .slice(0, 20),
    response_samples: input.responseSamples.slice(0, 5).map((row) => ({
      observed_at: boundText(row.observedAt, 100),
      sample: boundedStateValue(row.sample),
    })),
    timestamp_candidates: timestampCandidates,
    error_samples: input.errorSamples.slice(0, 5).map((row) => ({
      status: row.status,
      observed_at: boundText(row.observedAt, 100),
      sample: boundedStateValue(row.sample),
    })),
  };
  const questions: Record<string, ProbeQuestion> = {};
  if (state.useful_outputs.length && state.response_samples.length)
    questions[probeQuestionNames.useful] = {
      type: 'noul',
      ...probeQuestionWording.useful,
    };
  if (timestampCandidates.length) {
    questions[probeQuestionNames.timestampChoice] = {
      type: 'choice',
      instructions: probeQuestionWording.timestampChoice,
      criteria: timestampCriteria,
    };
    questions[probeQuestionNames.timestampCompanion] = {
      type: 'noul',
      ...probeQuestionWording.timestampCompanion,
    };
  }
  if (state.error_samples.length) {
    questions[probeQuestionNames.errorChoice] = {
      type: 'choice',
      instructions: probeQuestionWording.errorChoice,
      criteria: { ...probeQuestionWording.errorCriteria },
    };
    questions[probeQuestionNames.errorCompanion] = {
      type: 'noul',
      ...probeQuestionWording.errorCompanion,
    };
  }
  return { state, questions, timestampOptions };
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ProbeQuestionResult {
  model: string;
  usefulOutput: {
    probability: number;
    verdict: ThreeWayAnswer;
    model: string;
  } | null;
  sourceTimestamp: {
    pointer: string;
    format: ResponseBinding['timestampFormat'];
    probability: number;
    model: string;
  } | null;
  errorClass: {
    value: keyof typeof errorCriteria;
    probability: number;
    model: string;
  } | null;
}

const probability = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

function noulAnswer(value: unknown, name: string): NoulAnswer {
  const answer = value as Partial<NoulAnswer> | null;
  if (answer?.type !== 'noul' || !probability(answer.noul))
    throw new Error(`The probe checker returned an invalid ${name} Noul.`);
  return answer as NoulAnswer;
}

function choiceAnswer(
  value: unknown,
  name: string,
  choices: readonly string[],
): ChoiceAnswer {
  const answer = value as Partial<ChoiceAnswer> | null;
  if (
    answer?.type !== 'choice' ||
    typeof answer.choice !== 'string' ||
    !choices.includes(answer.choice) ||
    !probability(answer.confidence) ||
    !answer.probabilities ||
    typeof answer.probabilities !== 'object' ||
    choices.some((choice) => !probability(answer.probabilities?.[choice]))
  )
    throw new Error(`The probe checker returned an invalid ${name} Choice.`);
  return answer as ChoiceAnswer;
}

/**
 * Applies the code-owned truth table. A Choice is ignored unless its companion
 * Noul is a definite yes.
 */
export function parseProbeQuestionResult(
  bundle: ProbeQuestionBundle,
  value: unknown,
): ProbeQuestionResult {
  const response = value as {
    model?: unknown;
    answers?: Record<string, unknown>;
  } | null;
  if (
    typeof response?.model !== 'string' ||
    !response.model.trim() ||
    response.model.length > 200
  )
    throw new Error('The probe checker returned no resolved model.');
  const answers = response.answers ?? {};
  let usefulOutput: ProbeQuestionResult['usefulOutput'] = null;
  if (bundle.questions[probeQuestionNames.useful]) {
    const answer = noulAnswer(
      answers[probeQuestionNames.useful],
      probeQuestionNames.useful,
    );
    usefulOutput = {
      probability: answer.noul,
      verdict: classifyNoul(answer.noul),
      model: response.model,
    };
  }
  let sourceTimestamp: ProbeQuestionResult['sourceTimestamp'] = null;
  if (bundle.questions[probeQuestionNames.timestampChoice]) {
    const companion = noulAnswer(
      answers[probeQuestionNames.timestampCompanion],
      probeQuestionNames.timestampCompanion,
    );
    if (classifyNoul(companion.noul) === true) {
      const choice = choiceAnswer(
        answers[probeQuestionNames.timestampChoice],
        probeQuestionNames.timestampChoice,
        Object.keys(bundle.timestampOptions),
      );
      const candidate = bundle.timestampOptions[choice.choice];
      sourceTimestamp = {
        ...candidate,
        probability: companion.noul,
        model: response.model,
      };
    }
  }
  let errorClass: ProbeQuestionResult['errorClass'] = null;
  if (bundle.questions[probeQuestionNames.errorChoice]) {
    const companion = noulAnswer(
      answers[probeQuestionNames.errorCompanion],
      probeQuestionNames.errorCompanion,
    );
    if (classifyNoul(companion.noul) === true) {
      const choice = choiceAnswer(
        answers[probeQuestionNames.errorChoice],
        probeQuestionNames.errorChoice,
        Object.keys(errorCriteria),
      );
      errorClass = {
        value: choice.choice as keyof typeof errorCriteria,
        probability: companion.noul,
        model: response.model,
      };
    }
  }
  return {
    model: response.model,
    usefulOutput,
    sourceTimestamp,
    errorClass,
  };
}

export type ProbeQuestionChecker = (
  bundle: ProbeQuestionBundle,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Optional seam used by tests and callers; no checker means no semantic facts. */
export async function crossCheckProbeQuestions(
  bundle: ProbeQuestionBundle,
  checker?: ProbeQuestionChecker,
  signal?: AbortSignal,
): Promise<ProbeQuestionResult | null> {
  if (!checker || !Object.keys(bundle.questions).length) return null;
  return parseProbeQuestionResult(bundle, await checker(bundle, signal));
}

export function createTypeSafeProbeChecker(
  apiKey: string,
  model: string,
): ProbeQuestionChecker {
  return (bundle, signal) =>
    askTypeSafe(
      apiKey,
      model,
      bundle.state,
      bundle.questions as Record<string, TypeSafeQuestion>,
      signal,
    );
}

/**
 * The only live TypeSafe adapter in the probe harness. It sends the complete
 * operation bundle in one request; callers must opt in explicitly.
 */
export async function askProbeQuestionsWithTypeSafe(
  apiKey: string,
  model: string,
  bundle: ProbeQuestionBundle,
  signal?: AbortSignal,
): Promise<ProbeQuestionResult> {
  return crossCheckProbeQuestions(
    bundle,
    createTypeSafeProbeChecker(apiKey, model),
    signal,
  ).then((result) => {
    if (!result) throw new Error('The probe operation has no Jev questions.');
    return result;
  });
}
