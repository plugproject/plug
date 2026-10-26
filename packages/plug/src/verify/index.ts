import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertContract,
  validateInput,
  type AuthorizedHost,
  type Candidate,
  type DemoEvent,
  type DesignInput,
  type ExactKey,
  type JsonObject,
  type VerificationRecord,
} from '../contracts/index';
import { HttpBindingAdapter } from '../demo/source-adapters';
import { runDemo } from '../demo/runtime';
import {
  JudgmentError,
  judge,
  providerFromEnv,
  type JudgmentProvider,
} from '../judgment/index';
import { readAuthorizedHosts } from '../probe/hosts';
import {
  draftRequestSample,
  requestSampleRequired,
  requestSampleDrafterFromEnv,
  type RequestSampleDrafter,
} from '../probe/samples';
import { suggestDesign } from '../recommender/index';
import { endpoints } from '../recommender/relation';
import { operationIsReadSafe } from '../probe/plan';

export type VerifyMode = 'as-is' | 'design';

export interface VerifyEdgeOptions {
  workspace: string;
  revisionId?: string | null;
  authorizedHosts?: readonly AuthorizedHost[];
  env?: Record<string, string | undefined>;
  provider?: JudgmentProvider | null;
  sampleDrafter?: RequestSampleDrafter | null;
  signal?: AbortSignal;
  /** Kept small by default; verification is a bounded demonstration, not a load test. */
  sampleCount?: number;
  lifetimeMs?: number;
  onEvent?: (event: DemoEvent) => void;
}

export class VerificationError extends Error {}

const percentile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
};

const configuredJudge = (env: Record<string, string | undefined>) =>
  Boolean(
    env.PLUG_JUDGE_PROVIDER ||
    env.TYPESAFE_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY,
  );

const uniqueKeys = (values: JsonObject[]) => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
];

function samples(
  input: DesignInput,
  connectionId: string,
  count: number,
  ephemeral: readonly JsonObject[] = [],
): ExactKey[] {
  const connection = input.connections.find(
    (candidate) => candidate.id === connectionId,
  )!;
  const { op } = endpoints(input, connection);
  const values = uniqueKeys([
    ...(op.binding?.request.samples ?? []),
    ...(connection.workload.prewarmKeys ?? []),
    ...ephemeral,
  ]).filter((value): value is ExactKey =>
    Object.values(value).every(
      (item) =>
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean',
    ),
  );
  const available: ExactKey[] = values.length ? values : [{}];
  return Array.from({ length: count }, (_, index) =>
    structuredClone(available[index % available.length]),
  );
}

function selectedCandidate(
  input: DesignInput,
  connectionId: string,
  mode: VerifyMode,
): {
  candidate: Candidate | null;
  architectureId: string | null;
  reason?: string;
} {
  const design = suggestDesign(input);
  const report = design.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  )!;
  if (mode === 'as-is')
    return {
      candidate:
        report.candidates.find((candidate) => candidate.id === 'direct') ??
        null,
      architectureId: null,
    };
  const effectiveId =
    report.adoption?.status === 'honored' && report.adoptedArchitectureId
      ? report.adoptedArchitectureId
      : report.selectedArchitectureId;
  if (!effectiveId)
    return {
      candidate: null,
      architectureId: null,
      reason: 'The engine has no feasible selected architecture.',
    };
  const architecture = report.architectures.find(
    (candidate) => candidate.id === effectiveId,
  );
  if (!architecture)
    return {
      candidate: null,
      architectureId: effectiveId,
      reason: 'The effective architecture is not in the current report.',
    };
  if (architecture.patterns.length !== 1)
    return {
      candidate: null,
      architectureId: effectiveId,
      reason:
        'This composed architecture cannot be faithfully executed by the local runner.',
    };
  return {
    candidate:
      report.candidates.find(
        (candidate) => candidate.id === architecture.base,
      ) ?? null,
    architectureId: effectiveId,
  };
}

async function appendVerification(
  workspace: string,
  record: VerificationRecord,
) {
  assertContract<VerificationRecord>('VerificationRecord', record);
  const directory = join(workspace, '.plug');
  await mkdir(directory, { recursive: true });
  await appendFile(
    join(directory, 'verifications.jsonl'),
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function readVerificationRecords(
  workspace: string,
): Promise<VerificationRecord[]> {
  const path = join(workspace, '.plug', 'verifications.jsonl');
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new VerificationError('Verification log exceeds the local limit.');
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new VerificationError('Verification log is not valid JSONL.');
      }
      assertContract<VerificationRecord>('VerificationRecord', value);
      return value;
    });
}

/**
 * Runs a bounded local-workbench demonstration. It never turns the result into
 * an SLO and never runs an operation whose semantics are not explicitly read.
 */
export async function verifyEdge(
  raw: unknown,
  connectionId: string,
  mode: VerifyMode,
  options: VerifyEdgeOptions,
): Promise<VerificationRecord> {
  const input = validateInput(raw);
  const connection = input.connections.find(
    (candidate) => candidate.id === connectionId,
  );
  if (!connection)
    throw new VerificationError(`Unknown connection ${connectionId}.`);
  const design = suggestDesign(input);
  const { op, downstreamInterface } = endpoints(input, connection);
  const selection = selectedCandidate(input, connectionId, mode);
  const startedAt = Date.now();
  const measuredAt = new Date(startedAt).toISOString();
  const requirement = {
    usefulOutput: connection.experience.usefulOutput,
    latencyTargetMs: connection.experience.latencyTargetMs,
    scope: connection.experience.scope,
    targetPercentile: connection.experience.targetPercentile,
  };
  const record = async (values: {
    verdict: VerificationRecord['verdict'];
    architectureId: string | null;
    windowMs: number;
    sampleSize: number;
    withinTarget: number | null;
    latencyP95Ms: number | null;
    usefulOutputProbability: number | null;
    judgeModel: string | null;
    note: string;
  }) => {
    const result: VerificationRecord = {
      formatVersion: input.formatVersion,
      connectionId,
      mode,
      verdict: values.verdict,
      inputHash: design.inputHash,
      designHash: design.designHash,
      revisionId: options.revisionId ?? null,
      architectureId: values.architectureId,
      measuredAt,
      windowMs: values.windowMs,
      sampleSize: values.sampleSize,
      vantage: 'local-workbench',
      requirement,
      result: {
        withinTarget: values.withinTarget,
        latencyP95Ms: values.latencyP95Ms,
        usefulOutputProbability: values.usefulOutputProbability,
        judgeModel: values.judgeModel,
      },
      evidence: {
        kind: 'probed',
        note:
          `${values.note} Demonstration from this local-workbench vantage; ` +
          'not a production measurement or SLO.',
        measuredAt,
        sampleSize: values.sampleSize,
        windowMs: values.windowMs,
        source: {
          type: 'verification',
          location: '.plug/verifications.jsonl',
        },
      },
    };
    await appendVerification(options.workspace, result);
    return result;
  };

  const cannotRun =
    selection.reason ??
    (!selection.candidate
      ? 'The selected runner candidate is unavailable.'
      : !operationIsReadSafe(op)
        ? 'Write and unknown-effect operations are never run by verification unless the protocol operation is intrinsically read-safe.'
        : !op.binding
          ? 'Verification needs a request binding.'
          : op.binding.request.protocol !== downstreamInterface.protocol
            ? 'The request binding protocol does not match its downstream interface.'
            : !downstreamInterface.endpoint
              ? 'Verification needs a downstream endpoint.'
              : !op.outputSchema
                ? 'Verification needs an output contract.'
                : null);
  if (cannotRun)
    return record({
      verdict: 'inconclusive',
      architectureId: selection.architectureId,
      windowMs: 0,
      sampleSize: 0,
      withinTarget: null,
      latencyP95Ms: null,
      usefulOutputProbability: null,
      judgeModel: null,
      note: cannotRun,
    });

  const env = options.env ?? process.env;
  let ephemeralSamples: JsonObject[] = [];
  if (
    op.binding!.request.samples.length === 0 &&
    (connection.workload.prewarmKeys?.length ?? 0) === 0 &&
    requestSampleRequired(op)
  ) {
    const drafter =
      options.sampleDrafter === undefined
        ? requestSampleDrafterFromEnv(env)
        : options.sampleDrafter;
    if (!drafter)
      return record({
        verdict: 'inconclusive',
        architectureId: selection.architectureId,
        windowMs: Date.now() - startedAt,
        sampleSize: 0,
        withinTarget: null,
        latencyP95Ms: null,
        usefulOutputProbability: null,
        judgeModel: null,
        note:
          'Verification needs a request sample. Declare one or configure ' +
          'PLUG_DRAFT_PROVIDER and PLUG_DRAFT_MODEL.',
      });
    try {
      ephemeralSamples = [
        (await draftRequestSample(op, drafter, options.signal)).sample,
      ];
    } catch (error) {
      return record({
        verdict: 'inconclusive',
        architectureId: selection.architectureId,
        windowMs: Date.now() - startedAt,
        sampleSize: 0,
        withinTarget: null,
        latencyP95Ms: null,
        usefulOutputProbability: null,
        judgeModel: null,
        note:
          error instanceof Error
            ? error.message
            : 'Request sample drafting failed.',
      });
    }
  }

  const hosts =
    options.authorizedHosts ?? (await readAuthorizedHosts(options.workspace));
  let adapter: HttpBindingAdapter;
  try {
    adapter = new HttpBindingAdapter({
      endpoint: downstreamInterface.endpoint!,
      request: op.binding!.request,
      response: op.binding!.response,
      authorizedHosts: hosts,
      env: options.env,
    });
  } catch (error) {
    return record({
      verdict: 'inconclusive',
      architectureId: selection.architectureId,
      windowMs: Date.now() - startedAt,
      sampleSize: 0,
      withinTarget: null,
      latencyP95Ms: null,
      usefulOutputProbability: null,
      judgeModel: null,
      note: error instanceof Error ? error.message : 'Source binding failed.',
    });
  }

  const events: DemoEvent[] = [];
  const controller = new AbortController();
  const forwardAbort = () =>
    controller.abort(
      options.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
    );
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const lifetimeMs = Math.min(
    120_000,
    Math.max(1, options.lifetimeMs ?? 120_000),
  );
  const deadline = setTimeout(
    () =>
      controller.abort(
        new DOMException('Verification lifetime expired', 'TimeoutError'),
      ),
    lifetimeMs,
  );
  const runner = runDemo(selection.candidate!, {
    sourceAdapter: adapter,
    outputSchema: op.outputSchema!,
    inputSchema: op.inputSchema ?? undefined,
    signal: controller.signal,
    lifetimeMs,
    callCost: connection.profile.callCost.value,
    onEvent(event) {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  let cleanupError: string | null = null;
  try {
    const count = Math.min(20, Math.max(1, options.sampleCount ?? 3));
    for (const [index, key] of samples(
      input,
      connectionId,
      count,
      ephemeralSamples,
    ).entries()) {
      if (controller.signal.aborted) break;
      await runner.request(key, `verify-${index + 1}`);
      if (
        events.some(
          (event) =>
            event.type === 'target-miss' &&
            event.message.includes('Source HTTP 429'),
        )
      )
        break;
    }
  } finally {
    runner.stop('verification-complete');
    try {
      await adapter.close?.(controller.signal);
    } catch (error) {
      cleanupError =
        error instanceof Error ? error.message : 'Protocol cleanup failed.';
    }
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', forwardAbort);
  }

  const deliveries = events.filter((event) => event.type === 'result-delivery');
  const requestIds = new Set(
    events
      .filter((event) => event.type === 'request-start')
      .map((event) => event.actionId)
      .filter((value): value is string => Boolean(value)),
  );
  const metIds = new Set(
    deliveries
      .filter(
        (event) =>
          event.durationMs !== undefined &&
          event.durationMs <= connection.experience.latencyTargetMs,
      )
      .map((event) => event.actionId)
      .filter((value): value is string => Boolean(value)),
  );
  const latencies = deliveries
    .map((event) => event.durationMs)
    .filter((value): value is number => value !== undefined);
  const sampleSize = requestIds.size;
  const withinTarget = sampleSize ? metIds.size / sampleSize : null;

  let usefulOutputProbability: number | null = null;
  let judgeModel: string | null = null;
  const delivered = deliveries.find((event) => event.data)?.data;
  let provider = options.provider;
  if (provider === undefined && configuredJudge(env))
    provider = providerFromEnv(env);
  if (delivered && provider) {
    try {
      const judgment = await judge(
        {
          question: 'output-equivalence',
          outputMeaning: JSON.stringify(delivered).slice(0, 2_000),
          usefulOutput: connection.experience.usefulOutput,
          context: op.description,
        },
        provider,
        options.signal,
      );
      usefulOutputProbability = judgment.equivalent
        ? judgment.confidence
        : 1 - judgment.confidence;
      judgeModel = judgment.model;
    } catch (error) {
      if (!(error instanceof JudgmentError)) throw error;
      throw new VerificationError(error.message);
    }
  }

  const enoughSamples = sampleSize >= 3;
  const semanticsSettled =
    usefulOutputProbability !== null &&
    (usefulOutputProbability >= 0.7 || usefulOutputProbability <= 0.3);
  const meets =
    enoughSamples &&
    usefulOutputProbability !== null &&
    usefulOutputProbability >= 0.7 &&
    withinTarget !== null &&
    withinTarget >= connection.experience.targetPercentile;
  const disproved =
    enoughSamples &&
    semanticsSettled &&
    (usefulOutputProbability! <= 0.3 ||
      (withinTarget !== null &&
        withinTarget < connection.experience.targetPercentile));
  return record({
    verdict: meets
      ? 'demonstrated'
      : disproved
        ? 'not_demonstrated'
        : 'inconclusive',
    architectureId: selection.architectureId,
    windowMs: Date.now() - startedAt,
    sampleSize,
    withinTarget,
    latencyP95Ms: percentile(latencies, 0.95),
    usefulOutputProbability,
    judgeModel,
    note:
      (cleanupError ? `Protocol cleanup warning: ${cleanupError} ` : '') +
      (controller.signal.aborted
        ? 'The bounded verification run ended before it settled.'
        : !enoughSamples
          ? 'Fewer than three request samples completed.'
          : !semanticsSettled
            ? 'Delivered-output semantics were not settled by Jev.'
            : meets
              ? 'The bounded samples met the declared requirement.'
              : 'The bounded samples did not meet the declared requirement.'),
  });
}
