import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  askTypeSafe,
  buildPrompt,
  buildTypeSafeRequest,
  equivalentAt,
  judge,
  JudgmentError,
  parseTypeSafeVerdict,
  parseVerdict,
  providerFromEnv,
  questionVersion,
  stubProvider,
} from '../packages/plug/src/judgment/index';
import type {
  JudgmentProvider,
  JudgmentRequest,
} from '../packages/plug/src/judgment/index';
const request = (over: Partial<JudgmentRequest> = {}): JudgmentRequest => ({
  question: 'output-equivalence',
  outputMeaning: 'indicative flight options',
  usefulOutput: 'flight options, indicative',
  ...over,
});
afterEach(() => vi.unstubAllGlobals());
describe('judgment prompts', () => {
  it('builds a deterministic prompt carrying both texts and optional context', () => {
    const { system, user } = buildPrompt(request({ context: 'quote tool' }));
    expect(system).toContain('strict JSON');
    expect(system).toContain('does not satisfy a required result');
    expect(user).toContain('"indicative flight options"');
    expect(user).toContain('"flight options, indicative"');
    expect(user).toContain('Context: "quote tool"');
    expect(buildPrompt(request()).user).not.toContain('Context:');
  });
  it('bounds every supplied text and refuses unknown questions', () => {
    expect(() => buildPrompt(request({ outputMeaning: ' ' }))).toThrow(
      /outputMeaning must be non-empty/,
    );
    expect(() =>
      buildPrompt(request({ usefulOutput: 'x'.repeat(2001) })),
    ).toThrow(/exceeds 2000 characters/);
    expect(() => buildPrompt(request({ context: 'x'.repeat(8001) }))).toThrow(
      /exceeds 8000 characters/,
    );
    expect(() =>
      buildPrompt({ ...request(), question: 'other' as 'output-equivalence' }),
    ).toThrow(/Unknown judgment question/);
    try {
      buildPrompt(request({ outputMeaning: '' }));
    } catch (e) {
      expect((e as JudgmentError).status).toBe(400);
    }
  });
  it('builds the registered TypeSafe Noul over named, bounded state', () => {
    const built = buildTypeSafeRequest(
      request({ context: 'quote tool' }),
      'jev-1.14.0',
    );
    expect(built).toEqual(
      buildTypeSafeRequest(request({ context: 'quote tool' }), 'jev-1.14.0'),
    );
    expect(built.model).toBe('jev-1.14.0');
    expect(built.state).toEqual({
      declared_output_meaning: 'indicative flight options',
      required_useful_output: 'flight options, indicative',
      context: 'quote tool',
    });
    expect(built.questions.output_equivalence).toMatchObject({
      type: 'noul',
      criteria: {
        true: expect.stringContaining('same result'),
        false: expect.stringContaining('progress signal'),
      },
    });
    expect(
      buildTypeSafeRequest(request(), 'jev-1.14.0').state,
    ).not.toHaveProperty('context');
    expect(() =>
      buildTypeSafeRequest(
        request({ context: 'x'.repeat(8001) }),
        'jev-1.14.0',
      ),
    ).toThrow(/exceeds 8000 characters/);
    expect(() => buildTypeSafeRequest(request(), ' ')).toThrow(
      /model must be non-empty/,
    );
  });
});
describe('judgment verdicts', () => {
  it('validates mixed Noul and Choice answers and returns provider usage', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: {
            useful: { type: 'noul', noul: 0.91 },
            timestamp: {
              type: 'choice',
              choice: 'snapshot_at',
              confidence: 0.8,
              probabilities: { snapshot_at: 0.8, created_at: 0.2 },
            },
          },
          usage: { input_tokens: 123, output_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await askTypeSafe(
      'test-key',
      'jev-latest',
      {
        response_sample: { data: [], snapshot_at: '2026-01-01T00:00:00Z' },
      },
      {
        useful: {
          type: 'noul',
          instructions: 'Does `response_sample` contain a useful result?',
          criteria: {
            true: 'It contains the requested result.',
            false: 'It is an error, acknowledgement or placeholder.',
          },
        },
        timestamp: {
          type: 'choice',
          instructions: 'Which field states when the data was captured?',
          criteria: {
            snapshot_at: 'The source-data snapshot time.',
            created_at: 'The response envelope creation time.',
          },
        },
      },
    );
    expect(result).toEqual({
      model: 'jev-1.14.0',
      answers: {
        useful: { type: 'noul', noul: 0.91 },
        timestamp: {
          type: 'choice',
          choice: 'snapshot_at',
          confidence: 0.8,
          probabilities: { snapshot_at: 0.8, created_at: 0.2 },
        },
      },
      usage: { input_tokens: 123, output_tokens: 7 },
    });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.questions.timestamp.criteria).toHaveProperty('snapshot_at');
    expect(JSON.stringify(sent)).not.toContain('test-key');
    expect(fetch.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer test-key' }),
    );
  });
  it('refuses an invalid Choice or missing usage instead of inventing an answer', async () => {
    for (const body of [
      {
        model: 'jev-1.14.0',
        answers: {
          pick: {
            type: 'choice',
            choice: 'missing',
            confidence: 1,
            probabilities: { first: 1, second: 0 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        model: 'jev-1.14.0',
        answers: {
          pick: {
            type: 'choice',
            choice: 'first',
            confidence: 1,
            probabilities: { first: 1, second: 0 },
          },
        },
      },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      await expect(
        askTypeSafe(
          'test-key',
          'jev-latest',
          {},
          {
            pick: {
              type: 'choice',
              instructions: 'Pick one.',
              criteria: { first: 'First.', second: 'Second.' },
            },
          },
        ),
      ).rejects.toMatchObject({ status: 502 });
    }
  });
  it('parses the typed shape out of surrounding prose and bounds it', () => {
    const verdict = parseVerdict(
      `Sure! {"equivalent": true, "confidence": 1.4, "rationale": "${'r'.repeat(300)}"}`,
    );
    expect(verdict.equivalent).toBe(true);
    expect(verdict.confidence).toBe(1);
    expect(verdict.rationale).toHaveLength(240);
  });
  it('refuses missing, invalid or untyped answers with a 502', () => {
    for (const bad of [
      'no json here',
      '{not json}',
      '{"equivalent": "yes", "confidence": 1, "rationale": ""}',
      '{"equivalent": true, "confidence": null, "rationale": ""}',
    ]) {
      try {
        parseVerdict(bad);
        expect.unreachable(bad);
      } catch (e) {
        expect((e as JudgmentError).status).toBe(502);
      }
    }
  });
  it('stamps results with the question version and the provider model', async () => {
    const canned: JudgmentProvider = {
      model: 'test-model',
      complete: () =>
        Promise.resolve(
          '{"equivalent": false, "confidence": 0.2, "rationale": "differs"}',
        ),
    };
    const result = await judge(request(), canned);
    expect(result).toMatchObject({
      equivalent: false,
      confidence: 0.2,
      question: 'output-equivalence',
      questionVersion,
      model: 'test-model',
    });
    expect(Date.parse(result.at)).toBeGreaterThan(0);
  });
  it('turns Jev probability into a code-owned verdict and resolved model', async () => {
    const positive = parseTypeSafeVerdict({
      model: 'jev-1.14.0',
      answers: {
        output_equivalence: { type: 'noul', noul: equivalentAt },
      },
    });
    expect(positive).toMatchObject({
      equivalent: true,
      confidence: equivalentAt,
      model: 'jev-1.14.0',
    });
    expect(positive.rationale).toContain(`threshold ${equivalentAt}`);
    const negative = parseTypeSafeVerdict({
      model: 'jev-1.14.0',
      answers: { output_equivalence: { type: 'noul', noul: 0.2 } },
    });
    expect(negative).toMatchObject({
      equivalent: false,
      confidence: 0.8,
    });
    const result = await judge(request(), {
      model: 'jev-latest',
      ask: () =>
        Promise.resolve({
          equivalent: false,
          confidence: 0.8,
          rationale: 'typed',
          model: 'jev-1.14.0',
        }),
    });
    expect(result).toMatchObject({
      questionVersion,
      model: 'jev-1.14.0',
      equivalent: false,
    });
  });
  it('refuses malformed TypeSafe responses instead of treating them as no', () => {
    for (const bad of [
      {},
      {
        model: 'jev-1.14.0',
        answers: { output_equivalence: { type: 'choice', noul: 0.8 } },
      },
      {
        model: 'jev-1.14.0',
        answers: { output_equivalence: { type: 'noul', noul: 1.1 } },
      },
    ]) {
      try {
        parseTypeSafeVerdict(bad);
        expect.unreachable(JSON.stringify(bad));
      } catch (e) {
        expect((e as JudgmentError).status).toBe(502);
      }
    }
  });
});
describe('the stub provider', () => {
  it('says so in its model name and compares token sets, not meaning', async () => {
    const stub = stubProvider();
    expect(stub.model).toBe('stub');
    const same = await judge(request(), stub);
    expect(same.equivalent).toBe(true);
    expect(same.rationale).toContain('not a model judgment');
    const subset = await judge(
      request({ usefulOutput: 'flight options' }),
      stub,
    );
    expect(subset.equivalent).toBe(false);
  });
  it('answers malformed JSON when the prompt lacks its markers', async () => {
    try {
      parseVerdict(await stubProvider().complete('system', 'nothing'));
      expect.unreachable();
    } catch (e) {
      expect((e as JudgmentError).status).toBe(502);
    }
  });
});
describe('provider selection', () => {
  it('uses the stub only when named and real providers only when configured', () => {
    expect(providerFromEnv({ PLUG_JUDGE_PROVIDER: 'stub' }).model).toBe('stub');
    const typesafe = providerFromEnv({
      TYPESAFE_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'also-present',
      PLUG_JUDGE_MODEL: 'jev-1.14.0',
    });
    expect(typesafe.model).toBe('jev-1.14.0');
    expect('ask' in typesafe).toBe(true);
    expect(
      providerFromEnv({ ANTHROPIC_API_KEY: 'k', PLUG_JUDGE_MODEL: 'm' }).model,
    ).toBe('m');
    expect(
      providerFromEnv({ OPENAI_API_KEY: 'k', PLUG_JUDGE_MODEL: 'm' }).model,
    ).toBe('m');
    for (const [env, message] of [
      [{}, /No judge is configured/],
      [{ TYPESAFE_API_KEY: 'k' }, /PLUG_JUDGE_MODEL/],
      [{ PLUG_JUDGE_PROVIDER: 'typesafe' }, /needs its API key/],
      [{ ANTHROPIC_API_KEY: 'k' }, /PLUG_JUDGE_MODEL/],
      [{ PLUG_JUDGE_PROVIDER: 'anthropic' }, /needs its API key/],
      [
        { PLUG_JUDGE_PROVIDER: 'openai', OPENAI_API_KEY: 'k' },
        /PLUG_JUDGE_MODEL/,
      ],
    ] as const) {
      try {
        providerFromEnv(env);
        expect.unreachable(JSON.stringify(env));
      } catch (e) {
        expect((e as JudgmentError).status).toBe(503);
        expect((e as JudgmentError).message).toMatch(message);
      }
    }
  });
});
