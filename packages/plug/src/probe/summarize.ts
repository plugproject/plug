import type {
  JsonValue,
  OperationManifest,
  ResponseBinding,
} from '../contracts/index';
import { hash } from '../recommender/policy';
import {
  buildProbeQuestionBundle,
  crossCheckProbeQuestions,
  type ProbeQuestionChecker,
  type ProbeQuestionResult,
  type TimestampQuestionCandidate,
} from './questions';
import {
  isCacheHeader,
  isRateLimitHeader,
  type ProbeResponseObservation,
  type ProbeRunResult,
} from './run';

const formatVersion = '0.2-alpha.1' as const;
const timestampNearMs = 24 * 60 * 60 * 1_000;

export interface SummarizeProbeOptions {
  operationDescription?: string;
  outputMeaning?: string | null;
  usefulOutputs?: string[];
  checker?: ProbeQuestionChecker;
  signal?: AbortSignal;
  nodeVersion?: string;
}

const sortedNumbers = (values: readonly number[]) =>
  [...values].filter(Number.isFinite).sort((a, b) => a - b);

/** Nearest-rank percentile, including the observed maximum at p=1. */
export function percentile(
  values: readonly number[],
  probability: number,
): number | null {
  const sorted = sortedNumbers(values);
  if (!sorted.length) return null;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error('Percentile probability must be between zero and one.');
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function median(values: readonly number[]): number | null {
  const sorted = sortedNumbers(values);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const escapePointer = (part: string) =>
  part.replace(/~/g, '~0').replace(/\//g, '~1');

function timestampValue(
  value: JsonValue,
  observedMs: number,
): ResponseBinding['timestampFormat'] | null {
  let milliseconds: number | null = null;
  let format: ResponseBinding['timestampFormat'] = 'unknown';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Math.abs(value) >= 1e12) {
      milliseconds = value;
      format = 'epoch-milliseconds';
    } else if (Math.abs(value) >= 1e9) {
      milliseconds = value * 1_000;
      format = 'epoch-seconds';
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d{13}(?:\.\d+)?$/.test(trimmed)) {
      milliseconds = Number(trimmed);
      format = 'epoch-milliseconds';
    } else if (/^-?\d{10}(?:\.\d+)?$/.test(trimmed)) {
      milliseconds = Number(trimmed) * 1_000;
      format = 'epoch-seconds';
    } else if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        trimmed,
      )
    ) {
      milliseconds = Date.parse(trimmed);
      format = 'iso-8601';
    }
  }
  return milliseconds !== null &&
    Number.isFinite(milliseconds) &&
    Math.abs(milliseconds - observedMs) <= timestampNearMs
    ? format
    : null;
}

function walkTimestampCandidates(
  value: JsonValue,
  observedMs: number,
  pointer: string,
  found: Map<string, TimestampQuestionCandidate>,
  depth = 0,
): void {
  if (depth > 12) return;
  const format = timestampValue(value, observedMs);
  if (format) {
    const current = found.get(pointer);
    if (!current || format.localeCompare(current.format) < 0)
      found.set(pointer, { pointer, format });
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      walkTimestampCandidates(
        child,
        observedMs,
        `${pointer}/${index}`,
        found,
        depth + 1,
      ),
    );
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      walkTimestampCandidates(
        child,
        observedMs,
        `${pointer}/${escapePointer(key)}`,
        found,
        depth + 1,
      );
  }
}

export function findTimestampCandidates(
  observations: readonly ProbeResponseObservation[],
): TimestampQuestionCandidate[] {
  const found = new Map<string, TimestampQuestionCandidate>();
  for (const observation of observations) {
    if (observation.sample === undefined) continue;
    const observedMs = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    walkTimestampCandidates(observation.sample, observedMs, '', found);
  }
  return [...found.values()].sort((a, b) => a.pointer.localeCompare(b.pointer));
}

function selectedHeaders(
  observations: readonly ProbeResponseObservation[],
  predicate: (name: string) => boolean,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const observation of [...observations].sort(
    (a, b) => a.attempt - b.attempt,
  ))
    for (const [name, value] of Object.entries(observation.headers))
      if (predicate(name)) selected[name.toLowerCase()] = value;
  return Object.fromEntries(
    Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function observedChangeInterval(
  observations: readonly ProbeResponseObservation[],
): number | null {
  const successful = [...observations]
    .filter((row) => row.status >= 200 && row.status < 400)
    .sort(
      (a, b) =>
        Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
        a.attempt - b.attempt,
    );
  if (successful.length < 2) return null;
  let priorHash = successful[0].contentHash;
  let priorChangeAt = Date.parse(successful[0].observedAt);
  const intervals: number[] = [];
  for (const observation of successful.slice(1)) {
    if (observation.contentHash === priorHash) continue;
    const changedAt = Date.parse(observation.observedAt);
    if (Number.isFinite(changedAt) && Number.isFinite(priorChangeAt))
      intervals.push(Math.max(0, changedAt - priorChangeAt));
    priorHash = observation.contentHash;
    priorChangeAt = changedAt;
  }
  return median(intervals);
}

export function operationManifestHash(
  manifest: Omit<OperationManifest, 'manifestHash'> | OperationManifest,
): string {
  const { manifestHash: _ignored, ...content } = manifest as OperationManifest;
  return hash(content);
}

function mechanicalManifest(
  run: ProbeRunResult,
  nodeVersion: string,
): Omit<
  OperationManifest,
  'manifestHash' | 'sourceTimestamp' | 'usefulOutput'
> {
  const latencies = run.observations.map((row) => row.durationMs);
  const statuses: Record<string, number> = {};
  for (const observation of run.observations) {
    const key = String(observation.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  const successes = run.observations.filter(
    (row) =>
      row.status >= 200 && row.status < 400 && row.protocolError !== true,
  ).length;
  const candidates = findTimestampCandidates(run.observations);
  const started = Date.parse(run.startedAt);
  const completed = Date.parse(run.completedAt);
  return {
    formatVersion,
    systemId: run.systemId,
    operationId: run.operationId,
    endpoint: run.endpoint,
    measuredAt: run.completedAt,
    windowMs:
      Number.isFinite(started) && Number.isFinite(completed)
        ? Math.max(0, completed - started)
        : 0,
    sampleSize: run.attemptedCalls,
    vantage: {
      kind: 'local-workbench',
      nodeVersion,
    },
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    availability:
      run.attemptedCalls > 0 ? successes / run.attemptedCalls : null,
    responseBytes: median(run.observations.map((row) => row.bytes)),
    statusHistogram: Object.fromEntries(
      Object.entries(statuses).sort(
        ([a], [b]) => Number(a) - Number(b) || a.localeCompare(b),
      ),
    ),
    rateLimitHeaders: selectedHeaders(run.observations, isRateLimitHeader),
    cacheHeaders: selectedHeaders(run.observations, isCacheHeader),
    timestampCandidates: candidates.map((candidate) => candidate.pointer),
    changeIntervalMs: observedChangeInterval(run.observations),
    stoppedByRateLimit: run.stoppedByRateLimit,
  };
}

function questionBundle(run: ProbeRunResult, options: SummarizeProbeOptions) {
  const responseObservations = run.observations
    .filter(
      (row) =>
        row.status >= 200 && row.status < 400 && row.sample !== undefined,
    )
    .slice(0, 5);
  const candidates = findTimestampCandidates(responseObservations);
  return buildProbeQuestionBundle({
    operationDescription: options.operationDescription ?? '',
    outputMeaning: options.outputMeaning ?? null,
    usefulOutputs: options.usefulOutputs ?? [],
    responseSamples: responseObservations.map((row) => ({
      observedAt: row.observedAt,
      sample: row.sample!,
    })),
    timestampCandidates: candidates,
    errorSamples: run.observations
      .filter((row) => row.status >= 400 && row.sample !== undefined)
      .map((row) => ({
        status: row.status,
        observedAt: row.observedAt,
        sample: row.sample!,
      })),
  });
}

function withSemanticFacts(
  mechanical: ReturnType<typeof mechanicalManifest>,
  semantic: ProbeQuestionResult | null,
): OperationManifest {
  const withoutHash: Omit<OperationManifest, 'manifestHash'> = {
    ...mechanical,
    sourceTimestamp: semantic?.sourceTimestamp ?? null,
    usefulOutput: semantic?.usefulOutput
      ? {
          probability: semantic.usefulOutput.probability,
          model: semantic.usefulOutput.model,
        }
      : null,
  };
  return {
    ...withoutHash,
    manifestHash: operationManifestHash(withoutHash),
  };
}

/** Mechanical-only summary; semantic fields deliberately remain unknown. */
export function summarizeProbeMechanically(
  run: ProbeRunResult,
  options: Pick<SummarizeProbeOptions, 'nodeVersion'> = {},
): OperationManifest {
  return withSemanticFacts(
    mechanicalManifest(run, options.nodeVersion ?? process.version),
    null,
  );
}

/**
 * Produces one content-addressed manifest. Checker failure leaves semantic
 * fields unknown; abort still propagates so cancellation is not lost.
 */
export async function summarizeProbe(
  run: ProbeRunResult,
  options: SummarizeProbeOptions = {},
): Promise<OperationManifest> {
  const mechanical = mechanicalManifest(
    run,
    options.nodeVersion ?? process.version,
  );
  let semantic: ProbeQuestionResult | null = null;
  if (options.checker) {
    try {
      semantic = await crossCheckProbeQuestions(
        questionBundle(run, options),
        options.checker,
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  return withSemanticFacts(mechanical, semantic);
}

export const summarizeProbeRun = summarizeProbe;
