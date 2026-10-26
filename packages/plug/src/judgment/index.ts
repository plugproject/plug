/**
 * Typed judgments: the one place a language model may enter the analysis.
 *
 * A judgment answers a registered question about supplied text with a strict
 * typed verdict (answer, confidence, bounded rationale). It is recorded as
 * `judged` evidence pinned to its exact inputs, and the deterministic engine
 * decides what the verdict is allowed to qualify. A judgment is never
 * production verification and never invents a fact: it only reads what the
 * author supplied. Providers run only in the local workbench.
 */
export interface JudgmentRequest {
  /** The registered question; each version fixes its prompt and answer shape. */
  question: 'output-equivalence';
  /** The downstream operation's declared output meaning. */
  outputMeaning: string;
  /** The experience's required useful output. */
  usefulOutput: string;
  /** Optional supplied context, e.g. the operation description. Never fetched. */
  context?: string;
}
export interface JudgmentVerdict {
  equivalent: boolean;
  /** The provider's stated confidence, 0–1. */
  confidence: number;
  /** Bounded explanation; stored in evidence notes. */
  rationale: string;
}
export interface JudgmentResult extends JudgmentVerdict {
  question: JudgmentRequest['question'];
  questionVersion: number;
  model: string;
  at: string;
}
/** A completion backend. `model` names what judged; "stub" marks the non-model stub. */
export interface CompletionJudgmentProvider {
  readonly model: string;
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
}
/**
 * A System One backend answers the registered question directly as typed data.
 * The result names the resolved model version that actually answered.
 */
export interface SystemOneJudgmentProvider {
  readonly model: string;
  ask(
    request: JudgmentRequest,
    signal?: AbortSignal,
  ): Promise<JudgmentVerdict & { model: string }>;
}
export type JudgmentProvider =
  CompletionJudgmentProvider | SystemOneJudgmentProvider;
export class JudgmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const bound = (text: string, limit: number, name: string) => {
  if (typeof text !== 'string' || !text.trim())
    throw new JudgmentError(400, `${name} must be non-empty text.`);
  if (text.length > limit)
    throw new JudgmentError(400, `${name} exceeds ${limit} characters.`);
  return text;
};
export const questionVersion = 1;
export const equivalentAt = 0.7;
/** Deterministic prompt for the registered question; versioned with the registry. */
export function buildPrompt(request: JudgmentRequest): {
  system: string;
  user: string;
} {
  if (request.question !== 'output-equivalence')
    throw new JudgmentError(400, 'Unknown judgment question.');
  const meaning = bound(request.outputMeaning, 2000, 'outputMeaning');
  const useful = bound(request.usefulOutput, 2000, 'usefulOutput');
  const context =
    request.context === undefined
      ? ''
      : bound(request.context, 8000, 'context');
  return {
    system: [
      'You judge one question about an integration design: does the output a',
      'downstream operation declares satisfy the output the caller requires,',
      'for the same request? Judge only the supplied text. Phrasing may',
      'differ; the denoted result must be the same. An acknowledgement,',
      'progress signal or subset does not satisfy a required result. When',
      'unsure, answer false with low confidence. Answer with strict JSON',
      'only: {"equivalent": boolean, "confidence": number between 0 and 1,',
      '"rationale": string of at most 240 characters}.',
    ].join(' '),
    user: [
      `Declared output meaning: ${JSON.stringify(meaning)}`,
      `Required useful output: ${JSON.stringify(useful)}`,
      ...(context ? [`Context: ${JSON.stringify(context)}`] : []),
    ].join('\n'),
  };
}
export interface TypeSafeSystemOneRequest {
  model: string;
  state: {
    declared_output_meaning: string;
    required_useful_output: string;
    context?: string;
  };
  questions: {
    output_equivalence: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
  };
}
/** The registered output-equivalence question in TypeSafe's typed wire shape. */
export function buildTypeSafeRequest(
  request: JudgmentRequest,
  model: string,
): TypeSafeSystemOneRequest {
  if (request.question !== 'output-equivalence')
    throw new JudgmentError(400, 'Unknown judgment question.');
  const outputMeaning = bound(request.outputMeaning, 2000, 'outputMeaning');
  const usefulOutput = bound(request.usefulOutput, 2000, 'usefulOutput');
  const context =
    request.context === undefined
      ? undefined
      : bound(request.context, 8000, 'context');
  return {
    model: bound(model, 200, 'model'),
    state: {
      declared_output_meaning: outputMeaning,
      required_useful_output: usefulOutput,
      ...(context === undefined ? {} : { context }),
    },
    questions: {
      output_equivalence: {
        type: 'noul',
        instructions:
          'Does `declared_output_meaning` denote the same useful result as `required_useful_output` for the same request?',
        criteria: {
          true: 'Both fields denote the same result. Their phrasing may differ.',
          false:
            'The declared output is a different result, an acknowledgement, a progress signal, or only a subset of the required result.',
        },
      },
    },
  };
}
interface TypeSafeSystemOneResponse {
  model?: unknown;
  answers?: {
    output_equivalence?: {
      type?: unknown;
      noul?: unknown;
    };
  };
}
/** Converts Jev's Noul into the decision input consumed by deterministic code. */
export function parseTypeSafeVerdict(
  value: unknown,
): JudgmentVerdict & { model: string } {
  const response = value as TypeSafeSystemOneResponse;
  const answer = response?.answers?.output_equivalence;
  if (
    typeof response?.model !== 'string' ||
    !response.model.trim() ||
    answer?.type !== 'noul' ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  )
    throw new JudgmentError(
      502,
      'TypeSafe returned an invalid output-equivalence answer.',
    );
  const equivalent = answer.noul >= equivalentAt;
  return {
    equivalent,
    confidence: equivalent ? answer.noul : 1 - answer.noul,
    rationale:
      `Jev Noul=${answer.noul}; code threshold ${equivalentAt} ` +
      `classified the outputs as ${equivalent ? 'equivalent' : 'not equivalent'}.`,
    model: response.model,
  };
}
/** Parses and bounds a provider answer; refuses anything but the typed shape. */
export function parseVerdict(text: string): JudgmentVerdict {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match)
    throw new JudgmentError(502, 'The judge returned no JSON verdict.');
  let value: unknown;
  try {
    value = JSON.parse(match[0]);
  } catch {
    throw new JudgmentError(502, 'The judge returned invalid JSON.');
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.equivalent !== 'boolean' ||
    typeof v.confidence !== 'number' ||
    !Number.isFinite(v.confidence) ||
    typeof v.rationale !== 'string'
  )
    throw new JudgmentError(502, 'The judge verdict is not the typed shape.');
  return {
    equivalent: v.equivalent,
    confidence: Math.min(1, Math.max(0, v.confidence)),
    rationale: v.rationale.slice(0, 240),
  };
}
export async function judge(
  request: JudgmentRequest,
  provider: JudgmentProvider,
  signal?: AbortSignal,
): Promise<JudgmentResult> {
  let answered: JudgmentVerdict & { model: string };
  if ('ask' in provider) answered = await provider.ask(request, signal);
  else {
    const { system, user } = buildPrompt(request);
    answered = {
      ...parseVerdict(await provider.complete(system, user, signal)),
      model: provider.model,
    };
  }
  const { model, ...verdict } = answered;
  return {
    ...verdict,
    question: request.question,
    questionVersion,
    model,
    at: new Date().toISOString(),
  };
}
const stopWords = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'from',
  'current',
  'this',
  'that',
]);
const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !stopWords.has(t)),
  );
/**
 * The explicit test stub: a token-set comparison, not a model. It exists so
 * tests and demos run without credentials; its verdicts say so in the model
 * name and must never be a silent default.
 */
export function stubProvider(): CompletionJudgmentProvider {
  return {
    model: 'stub',
    complete(system, user) {
      const meaning = /Declared output meaning: ("(?:[^"\\]|\\.)*")/.exec(user);
      const useful = /Required useful output: ("(?:[^"\\]|\\.)*")/.exec(user);
      if (!system || !meaning || !useful)
        return Promise.resolve('{"malformed":true}');
      const a = tokens(JSON.parse(meaning[1]) as string);
      const b = tokens(JSON.parse(useful[1]) as string);
      const equivalent =
        a.size > 0 && a.size === b.size && [...a].every((t) => b.has(t));
      return Promise.resolve(
        JSON.stringify({
          equivalent,
          confidence: 0.6,
          rationale:
            'Stub token comparison for tests and demos; not a model judgment.',
        }),
      );
    },
  };
}
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
      message?: unknown;
    } | null;
    const providerMessage =
      typeof detail?.error?.message === 'string'
        ? detail.error.message
        : typeof detail?.message === 'string'
          ? detail.message
          : '';
    throw new JudgmentError(
      502,
      `The model provider answered HTTP ${response.status}.` +
        (providerMessage ? ` ${providerMessage.slice(0, 240)}` : ''),
    );
  }
  return response.json();
}
export interface TypeSafeNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}
export interface TypeSafeChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Descriptive option names are part of the question sent to Jev. */
  criteria: Record<string, string>;
}
export type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeChoiceQuestion;
export interface TypeSafeNoulAnswer {
  type: 'noul';
  noul: number;
}
export interface TypeSafeChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer;
export interface TypeSafeUsage {
  input_tokens: number;
  output_tokens: number;
}
type AnswersFor<Q extends Record<string, TypeSafeQuestion>> = {
  [K in keyof Q]: Q[K] extends TypeSafeNoulQuestion
    ? TypeSafeNoulAnswer
    : Q[K] extends TypeSafeChoiceQuestion
      ? TypeSafeChoiceAnswer
      : TypeSafeAnswer;
};
const probability = (value: unknown) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
/**
 * Shared typed TypeSafe transport. Jev supplies judgments; callers keep the
 * truth table that decides what those judgments are allowed to change.
 */
export async function askTypeSafe<Q extends Record<string, TypeSafeQuestion>>(
  apiKey: string,
  model: string,
  state: unknown,
  questions: Q,
  signal?: AbortSignal,
): Promise<{
  model: string;
  answers: AnswersFor<Q>;
  usage: TypeSafeUsage;
}> {
  const names = Object.keys(questions);
  if (!names.length)
    throw new JudgmentError(400, 'TypeSafe needs at least one question.');
  const value = (await post(
    'https://api.typesafe.ai/v1/systemone',
    { authorization: `Bearer ${apiKey}` },
    { model: bound(model, 200, 'model'), state, questions },
    signal,
  )) as {
    model?: unknown;
    answers?: Record<
      string,
      {
        type?: unknown;
        noul?: unknown;
        choice?: unknown;
        confidence?: unknown;
        probabilities?: unknown;
      }
    >;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  if (typeof value.model !== 'string' || !value.model.trim())
    throw new JudgmentError(502, 'TypeSafe returned no resolved model.');
  if (
    !Number.isInteger(value.usage?.input_tokens) ||
    (value.usage?.input_tokens as number) < 0 ||
    !Number.isInteger(value.usage?.output_tokens) ||
    (value.usage?.output_tokens as number) < 0
  )
    throw new JudgmentError(502, 'TypeSafe returned invalid usage.');
  const answers: Record<string, TypeSafeAnswer> = {};
  for (const name of names) {
    const answer = value.answers?.[name];
    const question = questions[name];
    if (question.type === 'noul') {
      if (answer?.type !== 'noul' || !probability(answer.noul))
        throw new JudgmentError(
          502,
          `TypeSafe returned an invalid ${name} answer.`,
        );
      answers[name] = { type: 'noul', noul: answer.noul as number };
      continue;
    }
    const probabilities = answer?.probabilities;
    if (
      answer?.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !probability(answer.confidence) ||
      !probabilities ||
      typeof probabilities !== 'object' ||
      Array.isArray(probabilities) ||
      Object.keys(question.criteria).some(
        (option) =>
          !Object.hasOwn(probabilities, option) ||
          !probability((probabilities as Record<string, unknown>)[option]),
      )
    )
      throw new JudgmentError(
        502,
        `TypeSafe returned an invalid ${name} answer.`,
      );
    answers[name] = {
      type: 'choice',
      choice: answer.choice,
      confidence: answer.confidence as number,
      probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((option) => [
          option,
          (probabilities as Record<string, number>)[option],
        ]),
      ),
    };
  }
  return {
    model: value.model,
    answers: answers as AnswersFor<Q>,
    usage: {
      input_tokens: value.usage!.input_tokens as number,
      output_tokens: value.usage!.output_tokens as number,
    },
  };
}
/** Compatibility wrapper for integrations that only ask Nouls. */
export async function askTypeSafeNouls<
  Q extends Record<string, TypeSafeNoulQuestion>,
>(
  apiKey: string,
  model: string,
  state: unknown,
  questions: Q,
  signal?: AbortSignal,
): Promise<{
  model: string;
  answers: AnswersFor<Q>;
  usage: TypeSafeUsage;
}> {
  return askTypeSafe(apiKey, model, state, questions, signal);
}
/** TypeSafe's Jev endpoint, using the typed System One question directly. */
export function typesafeProvider(
  apiKey: string,
  model: string,
): SystemOneJudgmentProvider {
  return {
    model,
    async ask(request, signal) {
      const built = buildTypeSafeRequest(request, model);
      return parseTypeSafeVerdict(
        await askTypeSafeNouls(
          apiKey,
          built.model,
          built.state,
          built.questions,
          signal,
        ),
      );
    },
  };
}
export function anthropicProvider(
  apiKey: string,
  model: string,
  maxTokens = 300,
): CompletionJudgmentProvider {
  return {
    model,
    async complete(system, user, signal) {
      const value = (await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        },
        signal,
      )) as { content?: { type: string; text?: string }[] };
      const text = value.content?.find((c) => c.type === 'text')?.text;
      if (!text) throw new JudgmentError(502, 'The judge returned no text.');
      return text;
    },
  };
}
export function openaiProvider(
  apiKey: string,
  model: string,
): CompletionJudgmentProvider {
  return {
    model,
    async complete(system, user, signal) {
      const value = (await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        signal,
      )) as { choices?: { message?: { content?: string } }[] };
      const text = value.choices?.[0]?.message?.content;
      if (!text) throw new JudgmentError(502, 'The judge returned no text.');
      return text;
    },
  };
}
/**
 * Selects the provider from the environment. Real providers need an API key
 * and an explicit PLUG_JUDGE_MODEL; the stub only runs when asked for by
 * name, so no judgment is ever silently non-model.
 */
export function providerFromEnv(
  env: Record<string, string | undefined>,
): JudgmentProvider {
  const kind =
    env.PLUG_JUDGE_PROVIDER ??
    (env.TYPESAFE_API_KEY
      ? 'typesafe'
      : env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : env.OPENAI_API_KEY
          ? 'openai'
          : '');
  if (kind === 'stub') return stubProvider();
  const model = env.PLUG_JUDGE_MODEL;
  if (kind === 'typesafe' || kind === 'anthropic' || kind === 'openai') {
    const key =
      env[
        kind === 'typesafe'
          ? 'TYPESAFE_API_KEY'
          : kind === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
      ];
    if (!key)
      throw new JudgmentError(
        503,
        `PLUG_JUDGE_PROVIDER=${kind} needs its API key in the environment.`,
      );
    if (!model)
      throw new JudgmentError(
        503,
        'Set PLUG_JUDGE_MODEL to the exact model the judge should use.',
      );
    if (kind === 'typesafe') return typesafeProvider(key, model);
    return kind === 'anthropic'
      ? anthropicProvider(key, model)
      : openaiProvider(key, model);
  }
  throw new JudgmentError(
    503,
    'No judge is configured. Set TYPESAFE_API_KEY (preferred), ' +
      'ANTHROPIC_API_KEY or OPENAI_API_KEY with PLUG_JUDGE_MODEL, or use ' +
      'PLUG_JUDGE_PROVIDER=stub for the non-model test stub.',
  );
}
