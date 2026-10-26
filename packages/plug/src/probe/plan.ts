import type { DesignInput, Interface, Operation } from '../contracts/index';
import { canonicalOrigin } from './hosts';

export interface ProbeLimits {
  hostMaxCalls: number;
  callsPerMinute: number;
  maxConcurrency: number;
  timeoutMs: number;
  operationMaxMs: number;
  responseMaxBytes: number;
}

export const defaultProbeLimits: Readonly<ProbeLimits> = Object.freeze({
  hostMaxCalls: 300,
  callsPerMinute: 30,
  maxConcurrency: 2,
  timeoutMs: 10_000,
  operationMaxMs: 120_000,
  responseMaxBytes: 1024 * 1024,
});

export type ProbeAttemptKind = 'latency' | 'change' | 'concurrency';

export interface ProbeAttempt {
  attempt: number;
  kind: ProbeAttemptKind;
  /** Earliest offset from the operation start. */
  notBeforeMs: number;
  /** Equal non-null values are started together, up to maxConcurrency. */
  concurrencyGroup: string | null;
}

export interface PlannedProbeOperation {
  systemId: string;
  operationId: string;
  interfaceId: string;
  protocol: Interface['protocol'];
  method: string | null;
  endpoint: string | null;
  origin: string | null;
  connected: boolean;
  safe: boolean;
  executable: boolean;
  attempts: ProbeAttempt[];
  /** Protocol lifecycle requests included in the host budget, but not samples. */
  setupCalls: number;
  plannedCalls: number;
  skippedReason: string | null;
  limits: ProbeLimits;
}

export interface ProbePlan {
  limits: ProbeLimits;
  operations: PlannedProbeOperation[];
  totalPlannedCalls: number;
  callsByOrigin: Record<string, number>;
}

export interface ProbePlanOptions {
  limits?: Partial<ProbeLimits>;
  latencySamples?: number;
  changeSamples?: number;
  unconnectedSamples?: number;
  changeSpacingMs?: number;
}

const boundedInteger = (
  supplied: number | undefined,
  fallback: number,
  maximum: number,
) => {
  if (supplied === undefined) return fallback;
  if (!Number.isInteger(supplied) || supplied < 0)
    throw new Error(
      'Probe limits and sample counts must be nonnegative integers.',
    );
  return Math.min(supplied, maximum);
};

function resolveLimits(overrides: Partial<ProbeLimits> = {}): ProbeLimits {
  return {
    hostMaxCalls: boundedInteger(
      overrides.hostMaxCalls,
      defaultProbeLimits.hostMaxCalls,
      defaultProbeLimits.hostMaxCalls,
    ),
    callsPerMinute: Math.max(
      1,
      boundedInteger(
        overrides.callsPerMinute,
        defaultProbeLimits.callsPerMinute,
        defaultProbeLimits.callsPerMinute,
      ),
    ),
    maxConcurrency: Math.max(
      1,
      boundedInteger(
        overrides.maxConcurrency,
        defaultProbeLimits.maxConcurrency,
        defaultProbeLimits.maxConcurrency,
      ),
    ),
    timeoutMs: Math.max(
      1,
      boundedInteger(
        overrides.timeoutMs,
        defaultProbeLimits.timeoutMs,
        defaultProbeLimits.timeoutMs,
      ),
    ),
    operationMaxMs: Math.max(
      1,
      boundedInteger(
        overrides.operationMaxMs,
        defaultProbeLimits.operationMaxMs,
        defaultProbeLimits.operationMaxMs,
      ),
    ),
    responseMaxBytes: Math.max(
      1,
      boundedInteger(
        overrides.responseMaxBytes,
        defaultProbeLimits.responseMaxBytes,
        defaultProbeLimits.responseMaxBytes,
      ),
    ),
  };
}

function cleanEndpoint(endpoint: string): {
  endpoint: string;
  origin: string;
} | null {
  try {
    const url = new URL(endpoint);
    const origin = canonicalOrigin(url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { endpoint: url.href, origin };
  } catch {
    return null;
  }
}

/**
 * Closed automatic allowlist. Anything outside it needs an explicit author
 * declaration of both read effect and idempotency.
 */
export function operationIsReadSafe(operation: Operation): boolean {
  const request = operation.binding?.request;
  if (!request) return false;
  if (operation.semantics.effect === 'write') return false;
  const method = request.method.trim();
  const declared =
    operation.semantics.effect === 'read' &&
    operation.semantics.idempotent === true;
  if (request.protocol === 'http')
    return ['GET', 'HEAD'].includes(method.toUpperCase()) || declared;
  if (request.protocol === 'mcp')
    return method.toLowerCase() === 'tools/list' || declared;
  const card =
    method.toUpperCase() === 'GET' &&
    (request.pathTemplate === '/.well-known/agent-card.json' ||
      request.pathTemplate === '/.well-known/agent.json');
  return card || declared;
}

function classifySafety(
  operation: Operation,
  iface: Interface | undefined,
): {
  safe: boolean;
  executable: boolean;
  method: string | null;
  reason: string | null;
} {
  if (!iface)
    return {
      safe: false,
      executable: false,
      method: null,
      reason: `Interface ${operation.interfaceId} does not exist.`,
    };
  const request = operation.binding?.request;
  const method = request?.method.trim() || null;
  if (!request)
    return {
      safe: false,
      executable: false,
      method,
      reason: 'The operation has no explicit request binding.',
    };
  if (request.protocol !== iface.protocol)
    return {
      safe: false,
      executable: false,
      method,
      reason: 'The request binding protocol does not match its interface.',
    };
  const safe = operationIsReadSafe(operation);
  if (iface.protocol === 'http') {
    const verb = method?.toUpperCase() ?? '';
    return {
      safe,
      executable: safe,
      method: verb || null,
      reason: safe
        ? null
        : 'HTTP methods other than GET/HEAD require explicit read and idempotent semantics.',
    };
  }
  if (iface.protocol === 'mcp') {
    return {
      safe,
      executable: safe,
      method,
      reason: safe
        ? null
        : 'MCP tool execution requires explicit read and idempotent semantics.',
    };
  }
  return {
    safe,
    executable: safe,
    method: method?.toUpperCase() ?? null,
    reason: safe
      ? null
      : 'A2A message or skill execution requires explicit read and idempotent semantics.',
  };
}

function desiredAttempts(
  connected: boolean,
  limits: ProbeLimits,
  options: ProbePlanOptions,
): ProbeAttempt[] {
  const latency = boundedInteger(options.latencySamples, 20, 20);
  const changes = boundedInteger(options.changeSamples, 3, 3);
  const unconnected = boundedInteger(options.unconnectedSamples, 3, 3);
  const spacing = boundedInteger(
    options.changeSpacingMs,
    Math.floor(limits.operationMaxMs / 4),
    limits.operationMaxMs,
  );
  const attempts: ProbeAttempt[] = [];
  const add = (
    kind: ProbeAttemptKind,
    notBeforeMs: number,
    concurrencyGroup: string | null = null,
  ) =>
    attempts.push({
      attempt: attempts.length + 1,
      kind,
      notBeforeMs,
      concurrencyGroup,
    });
  if (!connected) {
    for (let index = 0; index < unconnected; index++) add('latency', 0);
    return attempts;
  }
  for (let index = 0; index < latency; index++) add('latency', 0);
  if (limits.maxConcurrency >= 2 && limits.callsPerMinute >= 2) {
    add('concurrency', 0, 'pair-1');
    add('concurrency', 0, 'pair-1');
  }
  for (let index = 1; index <= changes; index++)
    add('change', Math.min(limits.operationMaxMs, index * spacing));
  return attempts;
}

function allocateAttempts(
  desired: ProbeAttempt[],
  remaining: number,
): ProbeAttempt[] {
  const allocated: ProbeAttempt[] = [];
  for (let index = 0; index < desired.length;) {
    const group = desired[index].concurrencyGroup;
    const end =
      group === null
        ? index + 1
        : desired.findIndex(
            (attempt, other) =>
              other > index && attempt.concurrencyGroup !== group,
          );
    const stop = end === -1 ? desired.length : end;
    const count = stop - index;
    if (count <= remaining - allocated.length)
      allocated.push(...desired.slice(index, stop));
    index = stop;
    if (allocated.length >= remaining) break;
  }
  return allocated.map((attempt, index) => ({
    ...attempt,
    attempt: index + 1,
  }));
}

/**
 * Builds a deterministic plan. Connected downstream operations are allocated
 * first, then operations are ordered by system and operation ID. This makes a
 * host-budget truncation stable and useful to the selected design.
 */
export function buildProbePlan(
  input: DesignInput,
  options: ProbePlanOptions = {},
): ProbePlan {
  const limits = resolveLimits(options.limits);
  const connected = new Set(
    input.connections.map(
      (connection) =>
        `${connection.downstreamSystemId}\u0000${connection.downstreamOperationId}`,
    ),
  );
  const candidates = input.systems.flatMap((system) =>
    system.operations.map((operation) => {
      const iface = system.interfaces.find(
        (candidate) => candidate.id === operation.interfaceId,
      );
      const safety = classifySafety(operation, iface);
      const cleaned =
        typeof iface?.endpoint === 'string'
          ? cleanEndpoint(iface.endpoint)
          : null;
      const key = `${system.id}\u0000${operation.id}`;
      let skippedReason = safety.reason;
      if (safety.safe && !iface?.endpoint)
        skippedReason = 'The interface has no endpoint.';
      else if (safety.safe && !cleaned)
        skippedReason = 'The interface endpoint is not a valid HTTP(S) URL.';
      return {
        systemId: system.id,
        operationId: operation.id,
        interfaceId: operation.interfaceId,
        protocol:
          iface?.protocol ?? operation.binding?.request.protocol ?? 'http',
        method: safety.method,
        endpoint: cleaned?.endpoint ?? null,
        origin: cleaned?.origin ?? null,
        connected: connected.has(key),
        safe: safety.safe,
        executable: safety.executable && !!cleaned,
        attempts: [] as ProbeAttempt[],
        setupCalls: 0,
        plannedCalls: 0,
        skippedReason,
        limits: { ...limits },
      } satisfies PlannedProbeOperation;
    }),
  );
  candidates.sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) ||
      a.systemId.localeCompare(b.systemId) ||
      a.operationId.localeCompare(b.operationId),
  );
  const callsByOrigin: Record<string, number> = {};
  for (const candidate of candidates) {
    if (!candidate.safe || !candidate.executable || !candidate.origin) continue;
    const used = callsByOrigin[candidate.origin] ?? 0;
    const desired = desiredAttempts(candidate.connected, limits, options);
    const setup = candidate.protocol === 'mcp' ? 3 : 0;
    const available = Math.max(0, limits.hostMaxCalls - used);
    candidate.attempts = allocateAttempts(
      desired,
      Math.max(0, available - setup),
    );
    candidate.setupCalls = candidate.attempts.length ? setup : 0;
    candidate.plannedCalls = candidate.setupCalls + candidate.attempts.length;
    callsByOrigin[candidate.origin] = used + candidate.plannedCalls;
    if (candidate.attempts.length < desired.length)
      candidate.skippedReason =
        candidate.attempts.length === 0
          ? 'The host call budget was exhausted before this operation.'
          : `The host call budget limited this operation to ${candidate.attempts.length} of ${desired.length} samples.`;
  }
  candidates.sort(
    (a, b) =>
      a.systemId.localeCompare(b.systemId) ||
      a.operationId.localeCompare(b.operationId),
  );
  return {
    limits,
    operations: candidates,
    totalPlannedCalls: Object.values(callsByOrigin).reduce(
      (sum, calls) => sum + calls,
      0,
    ),
    callsByOrigin: Object.fromEntries(
      Object.entries(callsByOrigin).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export const planProbe = buildProbePlan;
