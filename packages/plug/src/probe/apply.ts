import type {
  DesignInput,
  Evidence,
  Fact,
  OperationManifest,
  RateFact,
} from '../contracts/index';
import { stable } from '../recommender/policy';

function evidenceFor(
  manifest: OperationManifest,
  field: string,
  previous: unknown,
): Evidence {
  return {
    kind: 'probed',
    note:
      `${field} from the local-workbench vantage; ` +
      `N=${manifest.sampleSize}, window=${manifest.windowMs} ms. ` +
      'Not a production measurement. ' +
      `Previous value: ${stable(previous)}.`,
    measuredAt: manifest.measuredAt,
    sampleSize: manifest.sampleSize,
    windowMs: manifest.windowMs,
    source: {
      type: 'probe-manifest',
      location: `manifest@${manifest.manifestHash}`,
    },
  };
}

function probedFact(
  manifest: OperationManifest,
  field: string,
  previous: Fact,
  value: number,
  previousForNote: unknown = previous,
): Fact {
  return {
    value,
    evidence: evidenceFor(manifest, field, previousForNote),
  };
}

function probedRateFact(
  manifest: OperationManifest,
  field: string,
  previous: RateFact | undefined,
  value: number,
): RateFact {
  return {
    value,
    evidence: evidenceFor(manifest, field, previous ?? { absent: true }),
  };
}

const numeric = (value: string | undefined) => {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function windowedLimits(value: string): number[] {
  const limits: number[] = [];
  for (const policy of value.split(',')) {
    const count = Number(/^\s*(\d+(?:\.\d+)?)/.exec(policy)?.[1]);
    const seconds = Number(/;\s*w\s*=\s*(\d+(?:\.\d+)?)/i.exec(policy)?.[1]);
    if (
      Number.isFinite(count) &&
      count >= 0 &&
      Number.isFinite(seconds) &&
      seconds > 0
    )
      limits.push((count * 60) / seconds);
  }
  return limits;
}

/**
 * Derives a per-minute ceiling only when a rate-limit header supplies both a
 * count and a time basis. Remaining/reset values are never treated as quota.
 */
export function callsPerMinuteFromHeaders(
  headers: Record<string, string>,
): number | null {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const candidates = [
    ...windowedLimits(lower['ratelimit-limit'] ?? ''),
    ...windowedLimits(lower['ratelimit-policy'] ?? ''),
  ];
  const minute = numeric(lower['x-ratelimit-limit-minute']);
  if (minute !== null) candidates.push(minute);
  const xLimit = numeric(lower['x-ratelimit-limit']);
  const xWindowMatch = /^\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\s*$/i.exec(
    lower['x-ratelimit-window'] ?? '',
  );
  const xWindow = xWindowMatch ? Number(xWindowMatch[1]) : null;
  if (
    xLimit !== null &&
    xWindow !== null &&
    Number.isFinite(xWindow) &&
    xWindow > 0
  )
    candidates.push((xLimit * 60) / xWindow);
  const shorthand = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(?:min|minute)\s*$/i.exec(
    lower['x-ratelimit-limit'] ?? '',
  );
  if (shorthand) candidates.push(Number(shorthand[1]));
  return candidates.length ? Math.min(...candidates) : null;
}

export interface ApplyManifestResult {
  input: DesignInput;
  updatedConnectionIds: string[];
}

export function applyOperationManifestWithReport(
  input: DesignInput,
  manifest: OperationManifest,
): ApplyManifestResult {
  const updated = structuredClone(input);
  const updatedConnectionIds: string[] = [];
  const callsPerMinute = callsPerMinuteFromHeaders(manifest.rateLimitHeaders);
  for (const connection of updated.connections) {
    if (
      connection.downstreamSystemId !== manifest.systemId ||
      connection.downstreamOperationId !== manifest.operationId
    )
      continue;
    updatedConnectionIds.push(connection.id);
    const profile = connection.profile;
    if (manifest.latencyMs.p95 !== null) {
      profile.latencyMs = probedFact(
        manifest,
        'p95 latency',
        profile.latencyMs,
        manifest.latencyMs.p95,
        {
          latencyMs: profile.latencyMs,
          latencyPercentile: profile.latencyPercentile,
        },
      );
      profile.latencyPercentile = 0.95;
    }
    if (manifest.responseBytes !== null)
      profile.responseBytes = probedFact(
        manifest,
        'median response bytes',
        profile.responseBytes,
        manifest.responseBytes,
      );
    if (manifest.availability !== null)
      profile.availability = probedRateFact(
        manifest,
        'probe availability',
        profile.availability,
        manifest.availability,
      );
    if (callsPerMinute !== null)
      profile.callsPerMinute = probedFact(
        manifest,
        'explicit rate-limit ceiling in calls per minute',
        profile.callsPerMinute,
        callsPerMinute,
      );
    if (manifest.changeIntervalMs !== null)
      profile.changeIntervalMs = probedFact(
        manifest,
        'observed content-change interval',
        profile.changeIntervalMs,
        manifest.changeIntervalMs,
      );
    profile.sourceTimestamp =
      manifest.sourceTimestamp !== null &&
      manifest.sourceTimestamp.probability >= 0.7
        ? 'responseSnapshot'
        : 'observationOnly';
  }
  const system = updated.systems.find(
    (candidate) => candidate.id === manifest.systemId,
  );
  const operation = system?.operations.find(
    (candidate) => candidate.id === manifest.operationId,
  );
  const method = operation?.binding?.request.method.trim().toUpperCase();
  if (operation && (method === 'GET' || method === 'HEAD'))
    operation.semantics.effect = 'read';
  return { input: updated, updatedConnectionIds };
}

export function applyOperationManifest(
  input: DesignInput,
  manifest: OperationManifest,
): DesignInput {
  return applyOperationManifestWithReport(input, manifest).input;
}

export const applyManifest = applyOperationManifest;
