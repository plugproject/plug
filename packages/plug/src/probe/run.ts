import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AuthorizedHost,
  DesignInput,
  JsonObject,
  JsonValue,
  Operation,
  ProbeEvent,
  RequestBinding,
} from '../contracts/index';
import {
  assertAuthorizedOrigin,
  canonicalOrigin,
  HostAuthorizationError,
  readAuthorizedHosts,
} from './hosts';
import {
  defaultProbeLimits,
  type PlannedProbeOperation,
  type ProbeAttempt,
  type ProbeLimits,
  type ProbePlan,
} from './plan';

const formatVersion = '0.2-alpha.1' as const;
export const maxProbeSampleBytes = 64 * 1024;

export interface ProbeClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const systemClock: ProbeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const done = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    }),
};

export interface ProbeResponseObservation {
  attempt: number;
  kind: ProbeAttempt['kind'];
  startedAt: string;
  observedAt: string;
  durationMs: number;
  status: number;
  bytes: number;
  headers: Record<string, string>;
  sample?: JsonValue;
  protocolError?: boolean;
  contentHash: string;
}

export interface ProbeRunResult {
  systemId: string;
  operationId: string;
  endpoint: string;
  startedAt: string;
  completedAt: string;
  attemptedCalls: number;
  events: ProbeEvent[];
  observations: ProbeResponseObservation[];
  stoppedByRateLimit: boolean;
  cancelled: boolean;
}

export interface RunProbeOptions {
  workspace: string;
  systemId: string;
  operation: Operation;
  endpoint: string;
  plan: PlannedProbeOperation;
  authorizedHosts?: readonly AuthorizedHost[];
  env?: Record<string, string | undefined>;
  /** Ephemeral values such as Authorization. These are never returned/logged. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  clock?: ProbeClock;
  onEvent?: (event: ProbeEvent) => void;
  rateLimiter?: ProbeRateLimiter;
}

export class ProbeRunError extends Error {}
export class ProbeResponseLimitError extends ProbeRunError {}
export class McpSessionError extends ProbeRunError {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    message: string,
  ) {
    super(message);
  }
}

export function safeProbeId(value: string, kind = 'ID'): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new ProbeRunError(`${kind} must use 1-128 safe filename characters.`);
  return value;
}

export function isRateLimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'retry-after' ||
    lower.startsWith('ratelimit-') ||
    lower.startsWith('x-ratelimit-')
  );
}

export function isCacheHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    [
      'age',
      'cache-control',
      'cache-status',
      'cdn-cache-control',
      'etag',
      'expires',
      'last-modified',
      'pragma',
      'surrogate-control',
      'vary',
      'warning',
      'x-cache',
      'cf-cache-status',
    ].includes(lower) || lower.startsWith('x-cache-')
  );
}

export function safeResponseHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);
  return Object.fromEntries(
    entries
      .filter(([name]) => isRateLimitHeader(name) || isCacheHeader(name))
      .map(([name, value]) => [
        name.toLowerCase(),
        value.replace(/[\r\n]/g, '').slice(0, 2_048),
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const envReference = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function checkedHeader(name: string, value: string): [string, string] {
  if (!headerName.test(name) || /[\r\n]/.test(name) || /[\r\n]/.test(value))
    throw new ProbeRunError(
      'Request header names and values cannot contain CR/LF.',
    );
  return [name, value];
}

export function resolveRequestHeaders(
  persisted: Record<string, string>,
  env: Record<string, string | undefined>,
  supplied: Record<string, string> = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(persisted)) {
    const match = envReference.exec(reference);
    if (!match)
      throw new ProbeRunError(
        `Persisted header ${name} must be exactly \${env:NAME}.`,
      );
    const value = env[match[1]];
    if (value === undefined)
      throw new ProbeRunError(
        `Environment variable ${match[1]} is required for header ${name}.`,
      );
    const checked = checkedHeader(name, value);
    resolved[checked[0]] = checked[1];
  }
  for (const [name, value] of Object.entries(supplied)) {
    const checked = checkedHeader(name, value);
    resolved[checked[0]] = checked[1];
  }
  return resolved;
}

function sampleValue(sample: JsonObject, name: string): JsonValue {
  let value: JsonValue = sample;
  for (const part of name.split('.')) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, part)
    )
      throw new ProbeRunError(`Sample value ${name} is missing.`);
    value = value[part];
  }
  return value;
}

const scalar = (value: JsonValue, name: string) => {
  if (
    value === null ||
    (typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean')
  )
    throw new ProbeRunError(`${name} must resolve to a scalar sample value.`);
  return String(value);
};

const placeholder = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

export function renderTemplate(text: string, sample: JsonObject): string {
  return text.replace(placeholder, (_whole, name: string) =>
    scalar(sampleValue(sample, name), name),
  );
}

function renderPath(text: string, sample: JsonObject): string {
  return text.replace(placeholder, (_whole, name: string) =>
    encodeURIComponent(scalar(sampleValue(sample, name), name)),
  );
}

function renderBody(value: JsonValue, sample: JsonObject): JsonValue {
  if (typeof value === 'string') {
    const exact = /^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/.exec(value);
    if (exact) return structuredClone(sampleValue(sample, exact[1]));
    return renderTemplate(value, sample);
  }
  if (Array.isArray(value))
    return value.map((item) => renderBody(item, sample));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderBody(item, sample),
      ]),
    );
  return value;
}

const jsonObject = (value: JsonValue, message: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProbeRunError(message);
  return value;
};

function renderedUrl(
  endpoint: string,
  pathTemplate: string,
  query: Record<string, string>,
  sample: JsonObject,
  authorizedOrigin: string,
): URL {
  const base = new URL(endpoint);
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  const url = pathTemplate
    ? new URL(
        renderPath(pathTemplate, sample),
        base.href.endsWith('/') ? base.href : `${base.href}/`,
      )
    : base;
  for (const [name, template] of Object.entries(query))
    url.searchParams.set(name, renderTemplate(template, sample));
  if (canonicalOrigin(url) !== authorizedOrigin)
    throw new HostAuthorizationError(
      `Rendered request origin ${canonicalOrigin(url)} is not authorized.`,
    );
  return url;
}

/**
 * Renders HTTP, MCP Streamable HTTP and A2A JSON-RPC bindings without ever
 * persisting resolved headers or generated sample values.
 */
export function renderBoundRequest(
  binding: RequestBinding,
  endpoint: string,
  sample: JsonObject,
  headers: Record<string, string>,
  authorizedOrigin: string,
  requestId: string,
): { url: string; init: RequestInit } {
  const url = renderedUrl(
    endpoint,
    binding.pathTemplate,
    binding.query,
    sample,
    authorizedOrigin,
  );
  const requestHeaders = { ...headers };
  const logicalMethod = binding.method.trim();
  let method = logicalMethod.toUpperCase();
  let body: string | undefined;
  if (binding.protocol === 'http' || method === 'GET' || method === 'HEAD') {
    if (method !== 'GET' && method !== 'HEAD' && binding.bodyTemplate !== null)
      body = JSON.stringify(renderBody(binding.bodyTemplate, sample));
  } else {
    method = 'POST';
    const rendered =
      binding.bodyTemplate === null
        ? {}
        : jsonObject(
            renderBody(binding.bodyTemplate, sample),
            'A protocol request body must render to an object.',
          );
    const params =
      binding.protocol === 'mcp' &&
      logicalMethod.toLowerCase() === 'tools/call' &&
      !Object.hasOwn(rendered, 'arguments')
        ? { ...rendered, arguments: structuredClone(sample) }
        : rendered;
    body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: logicalMethod,
      params,
    });
    if (
      binding.protocol === 'mcp' &&
      !Object.keys(requestHeaders).some(
        (name) => name.toLowerCase() === 'accept',
      )
    )
      requestHeaders.accept = 'application/json, text/event-stream';
  }
  if (
    body !== undefined &&
    !Object.keys(requestHeaders).some(
      (name) => name.toLowerCase() === 'content-type',
    )
  )
    requestHeaders['content-type'] = 'application/json';
  return {
    url: url.href,
    init: {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
    },
  };
}

interface RequestSpec {
  attempt: ProbeAttempt;
  url: string;
  init: RequestInit;
}

function requestSpecs(
  operation: Operation,
  endpoint: string,
  attempts: readonly ProbeAttempt[],
  headers: Record<string, string>,
  authorizedOrigin: string,
): RequestSpec[] {
  const binding = operation.binding?.request;
  if (!binding)
    throw new ProbeRunError('The operation needs a request binding.');
  const logicalMethod = binding.method.trim();
  if (!logicalMethod)
    throw new ProbeRunError('The request binding needs a method.');
  const method = logicalMethod.toUpperCase();
  if (operation.semantics.effect === 'write')
    throw new ProbeRunError('Explicit write operations are never probed.');
  const automaticallySafe =
    (binding.protocol === 'http' && (method === 'GET' || method === 'HEAD')) ||
    (binding.protocol === 'mcp' &&
      logicalMethod.toLowerCase() === 'tools/list') ||
    (binding.protocol === 'a2a' &&
      method === 'GET' &&
      (binding.pathTemplate === '/.well-known/agent-card.json' ||
        binding.pathTemplate === '/.well-known/agent.json'));
  if (
    !automaticallySafe &&
    !(
      operation.semantics.effect === 'read' &&
      operation.semantics.idempotent === true
    )
  )
    throw new ProbeRunError(
      'This protocol operation is not explicitly read and idempotent.',
    );
  const samples = binding.samples.length ? binding.samples : [{}];
  return attempts.map((attempt, index) => {
    const sample = samples[index % samples.length];
    const rendered = renderBoundRequest(
      binding,
      endpoint,
      sample,
      headers,
      authorizedOrigin,
      `plug-probe-${attempt.attempt}`,
    );
    return {
      attempt,
      ...rendered,
    };
  });
}

const sensitiveKey =
  /(?:authorization|cookie|password|secret|token|api[-_]?key|credential)/i;

function redactedAndBound(
  value: unknown,
  budget: { remaining: number },
  depth = 0,
  key = '',
): JsonValue {
  if (sensitiveKey.test(key.trim())) return '[redacted]';
  if (budget.remaining <= 0 || depth > 10) return '[truncated]';
  if (value === null || typeof value === 'boolean') {
    budget.remaining -= 5;
    return value;
  }
  if (typeof value === 'number') {
    budget.remaining -= 24;
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const length = Math.max(0, Math.min(4_096, budget.remaining));
    const result = value.slice(0, length);
    budget.remaining -= result.length + 2;
    return result;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 100)) {
      if (budget.remaining <= 0) break;
      result.push(redactedAndBound(item, budget, depth + 1));
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [childKey, child] of Object.entries(value).slice(0, 100)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= childKey.length + 3;
      result[childKey] = redactedAndBound(child, budget, depth + 1, childKey);
    }
    return result;
  }
  budget.remaining -= 4;
  return null;
}

export function decodeProtocolBody(
  bytes: Uint8Array,
  contentType = '',
): unknown {
  const text = new TextDecoder().decode(bytes);
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const values = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    if (values.length) return values.at(-1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function unwrapJsonRpc(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).jsonrpc === '2.0'
  ) {
    const message = value as Record<string, unknown>;
    if (Object.hasOwn(message, 'result')) return message.result;
    if (Object.hasOwn(message, 'error')) return { error: message.error };
  }
  return value;
}

function responseSample(
  bytes: Uint8Array,
  contentType = '',
  jsonRpc = false,
): JsonValue | undefined {
  if (!bytes.byteLength) return undefined;
  const decoded = decodeProtocolBody(bytes, contentType);
  const value = jsonRpc ? unwrapJsonRpc(decoded) : decoded;
  const bounded = redactedAndBound(value, {
    remaining: maxProbeSampleBytes,
  });
  const serialized = JSON.stringify(bounded);
  return new TextEncoder().encode(serialized).byteLength <= maxProbeSampleBytes
    ? bounded
    : boundedJsonString(serialized, maxProbeSampleBytes);
}

function boundedJsonString(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(value)).byteLength <= maximum) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      encoder.encode(JSON.stringify(value.slice(0, middle))).byteLength <=
      maximum
    )
      low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

async function readBoundedBody(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new ProbeResponseLimitError(
          `Response exceeded the ${maximum}-byte probe limit.`,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function combinedSignal(signals: AbortSignal[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted)
      controller.abort(
        signal.reason ?? new DOMException('Aborted', 'AbortError'),
      );
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners)
        signal.removeEventListener('abort', listener);
    },
  };
}

export interface McpHttpSessionOptions {
  endpoint: string;
  headers: Record<string, string>;
  authorizedOrigin: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  fetch?: typeof globalThis.fetch;
  beforeCall?: () => Promise<void>;
}

/** Performs the mandatory MCP initialize/initialized exchange. */
export async function initializeMcpHttpSession(
  options: McpHttpSessionOptions,
): Promise<Record<string, string>> {
  const endpoint = new URL(options.endpoint);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  if (canonicalOrigin(endpoint) !== options.authorizedOrigin)
    throw new ProbeRunError('The MCP endpoint escaped its authorized origin.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const requestedVersion =
    Object.entries(options.headers).find(
      ([name]) => name.toLowerCase() === 'mcp-protocol-version',
    )?.[1] ?? '2025-11-25';
  const baseHeaders = {
    ...Object.fromEntries(
      Object.entries(options.headers).filter(
        ([name]) =>
          ![
            'accept',
            'content-type',
            'mcp-protocol-version',
            'mcp-session-id',
          ].includes(name.toLowerCase()),
      ),
    ),
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const post = async (
    body: JsonObject,
    headers: Record<string, string>,
  ): Promise<{ response: Response; bytes: Uint8Array }> => {
    await options.beforeCall?.();
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          new DOMException('MCP request timed out', 'TimeoutError'),
        ),
      options.timeoutMs,
    );
    const composed = combinedSignal([options.signal, timeout.signal]);
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: composed.signal,
      });
      const bytes = await readBoundedBody(response, options.maxBytes);
      if (!response.ok)
        throw new McpSessionError(
          response.status,
          safeResponseHeaders(response.headers),
          `MCP session setup returned HTTP ${response.status}.`,
        );
      return { response, bytes };
    } finally {
      clearTimeout(timer);
      composed.cleanup();
    }
  };
  const initialized = await post(
    {
      jsonrpc: '2.0',
      id: 'plug-initialize',
      method: 'initialize',
      params: {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo: { name: 'plug', version: '0.2.0' },
      },
    },
    baseHeaders,
  );
  const decoded = unwrapJsonRpc(
    decodeProtocolBody(
      initialized.bytes,
      initialized.response.headers.get('content-type') ?? '',
    ),
  );
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    typeof (decoded as Record<string, unknown>).protocolVersion !== 'string'
  )
    throw new ProbeRunError(
      'MCP initialize did not return a negotiated protocol version.',
    );
  const protocolVersion = (decoded as Record<string, unknown>)
    .protocolVersion as string;
  const sessionId = initialized.response.headers.get('mcp-session-id');
  const sessionHeaders = {
    ...baseHeaders,
    'mcp-protocol-version': protocolVersion,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
  await post(
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    sessionHeaders,
  );
  return sessionHeaders;
}

/** Best-effort bounded MCP session cleanup when the server issued a session. */
export async function closeMcpHttpSession(
  options: McpHttpSessionOptions,
): Promise<void> {
  if (
    !Object.keys(options.headers).some(
      (name) => name.toLowerCase() === 'mcp-session-id',
    )
  )
    return;
  await options.beforeCall?.();
  const endpoint = new URL(options.endpoint);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  if (canonicalOrigin(endpoint) !== options.authorizedOrigin)
    throw new ProbeRunError('The MCP endpoint escaped its authorized origin.');
  const timeout = new AbortController();
  const timer = setTimeout(
    () =>
      timeout.abort(new DOMException('MCP cleanup timed out', 'TimeoutError')),
    options.timeoutMs,
  );
  const composed = combinedSignal([options.signal, timeout.signal]);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: 'DELETE',
      headers: options.headers,
      redirect: 'error',
      signal: composed.signal,
    });
    await readBoundedBody(response, options.maxBytes);
    if (!response.ok)
      throw new McpSessionError(
        response.status,
        safeResponseHeaders(response.headers),
        `MCP session cleanup returned HTTP ${response.status}.`,
      );
  } finally {
    clearTimeout(timer);
    composed.cleanup();
  }
}

function effectiveLimits(plan: PlannedProbeOperation): ProbeLimits {
  const supplied = plan.limits;
  const clamp = (value: number, minimum: number, maximum: number) =>
    Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
      : minimum;
  return {
    hostMaxCalls: clamp(
      supplied.hostMaxCalls,
      0,
      defaultProbeLimits.hostMaxCalls,
    ),
    callsPerMinute: clamp(
      supplied.callsPerMinute,
      1,
      defaultProbeLimits.callsPerMinute,
    ),
    maxConcurrency: clamp(
      supplied.maxConcurrency,
      1,
      defaultProbeLimits.maxConcurrency,
    ),
    timeoutMs: clamp(supplied.timeoutMs, 1, defaultProbeLimits.timeoutMs),
    operationMaxMs: clamp(
      supplied.operationMaxMs,
      1,
      defaultProbeLimits.operationMaxMs,
    ),
    responseMaxBytes: clamp(
      supplied.responseMaxBytes,
      1,
      defaultProbeLimits.responseMaxBytes,
    ),
  };
}

export class ProbeRateLimiter {
  readonly #starts = new Map<string, number[]>();

  async acquire(
    origin: string,
    count: number,
    callsPerMinute: number,
    clock: ProbeClock,
    signal: AbortSignal,
  ): Promise<void> {
    if (count > callsPerMinute)
      throw new ProbeRunError(
        'A concurrent probe group exceeds the calls-per-minute ceiling.',
      );
    while (true) {
      const now = clock.now();
      const starts = (this.#starts.get(origin) ?? []).filter(
        (started) => started > now - 60_000,
      );
      this.#starts.set(origin, starts);
      if (starts.length + count <= callsPerMinute) {
        starts.push(...Array.from({ length: count }, () => now));
        return;
      }
      const wait = Math.max(1, starts[0] + 60_000 - now);
      await clock.sleep(wait, signal);
    }
  }
}

function eventAt(clock: ProbeClock) {
  return new Date(clock.now()).toISOString();
}

function templateEndpoint(endpoint: string, pathTemplate: string): string {
  const base = new URL(endpoint);
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  if (!pathTemplate) return base.href;
  const baseHref = base.href.endsWith('/') ? base.href : `${base.href}/`;
  const result = new URL(pathTemplate, baseHref);
  result.username = '';
  result.password = '';
  result.search = '';
  result.hash = '';
  return result.href;
}

interface AttemptOutcome {
  observation?: ProbeResponseObservation;
  rateLimited: boolean;
  cancelled: boolean;
}

export async function runProbeOperation(
  options: RunProbeOptions,
): Promise<ProbeRunResult> {
  const systemId = safeProbeId(options.systemId, 'System ID');
  const operationId = safeProbeId(options.operation.id, 'Operation ID');
  if (
    options.plan.systemId !== options.systemId ||
    options.plan.operationId !== options.operation.id
  )
    throw new ProbeRunError('The probe plan does not select this operation.');
  if (!options.plan.safe || !options.plan.executable)
    throw new ProbeRunError(
      options.plan.skippedReason ??
        'The operation is not executable by this runner.',
    );
  const authorizedOrigin = await assertAuthorizedOrigin(
    options.workspace,
    options.endpoint,
    options.authorizedHosts,
  );
  if (options.plan.origin !== authorizedOrigin)
    throw new ProbeRunError(
      'The authorized endpoint origin does not match the probe plan.',
    );
  const binding = options.operation.binding?.request;
  if (!binding)
    throw new ProbeRunError('The operation has no request binding.');
  const plannedMethod =
    binding.protocol === 'http' || binding.protocol === 'a2a'
      ? binding.method.trim().toUpperCase()
      : binding.method.trim();
  if (options.plan.method !== plannedMethod)
    throw new ProbeRunError(
      'The operation method no longer matches the probe plan.',
    );
  const headers = resolveRequestHeaders(
    binding.headers,
    options.env ?? process.env,
    options.headers,
  );
  const limits = effectiveLimits(options.plan);
  const attempts = options.plan.attempts.slice(0, limits.hostMaxCalls);
  /*
   * Render and origin-check every URL before making the first request. A later
   * sample therefore cannot smuggle an absolute URL into a partially run probe.
   */
  let specs = requestSpecs(
    options.operation,
    options.endpoint,
    attempts,
    headers,
    authorizedOrigin,
  );
  const clock = options.clock ?? systemClock;
  const fetcher = options.fetch ?? globalThis.fetch;
  const rateLimiter = options.rateLimiter ?? new ProbeRateLimiter();
  const events: ProbeEvent[] = [];
  const observations: ProbeResponseObservation[] = [];
  const logDirectory = join(options.workspace, '.plug', 'probes', systemId);
  const logPath = join(logDirectory, `${operationId}.jsonl`);
  await mkdir(logDirectory, { recursive: true });
  let writes = Promise.resolve();
  const emit = (event: ProbeEvent) => {
    events.push(event);
    options.onEvent?.(event);
    const line = `${JSON.stringify(event)}\n`;
    writes = writes.then(() =>
      appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 }),
    );
    return writes;
  };
  const startedMs = clock.now();
  const startedAt = new Date(startedMs).toISOString();
  const operationAbort = new AbortController();
  const rateLimitAbort = new AbortController();
  const externalAbort = () =>
    operationAbort.abort(
      options.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
    );
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });
  const deadline = setTimeout(
    () =>
      operationAbort.abort(
        new DOMException('Operation deadline exceeded', 'TimeoutError'),
      ),
    limits.operationMaxMs,
  );
  await emit({
    formatVersion,
    systemId,
    operationId,
    at: startedAt,
    type: 'plan',
    message:
      `Bounded ${binding.protocol.toUpperCase()} probe planned ` +
      `${specs.length} sample call(s)` +
      (options.plan.setupCalls
        ? ` plus ${options.plan.setupCalls} protocol lifecycle call(s).`
        : '.'),
  });
  let attemptedCalls = 0;
  let stoppedByRateLimit = false;
  let cancelled = operationAbort.signal.aborted;
  let mcpSessionHeaders: Record<string, string> | null = null;

  const execute = async (
    spec: RequestSpec,
    requestStartedMs: number,
  ): Promise<AttemptOutcome> => {
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(new DOMException('Request timed out', 'TimeoutError')),
      limits.timeoutMs,
    );
    const composed = combinedSignal([
      operationAbort.signal,
      rateLimitAbort.signal,
      timeout.signal,
    ]);
    try {
      const response = await fetcher(spec.url, {
        ...spec.init,
        signal: composed.signal,
      });
      const body = await readBoundedBody(response, limits.responseMaxBytes);
      const observedMs = clock.now();
      const safeHeaders = safeResponseHeaders(response.headers);
      const sample = responseSample(
        body,
        response.headers.get('content-type') ?? '',
        binding.protocol !== 'http' &&
          !['GET', 'HEAD'].includes(binding.method.trim().toUpperCase()),
      );
      const protocolError =
        binding.protocol !== 'http' &&
        sample !== undefined &&
        !!sample &&
        typeof sample === 'object' &&
        !Array.isArray(sample) &&
        Object.hasOwn(sample, 'error');
      const observation: ProbeResponseObservation = {
        attempt: spec.attempt.attempt,
        kind: spec.attempt.kind,
        startedAt: new Date(requestStartedMs).toISOString(),
        observedAt: new Date(observedMs).toISOString(),
        durationMs: Math.max(0, observedMs - requestStartedMs),
        status: response.status,
        bytes: body.byteLength,
        headers: safeHeaders,
        ...(sample === undefined ? {} : { sample }),
        ...(protocolError ? { protocolError: true } : {}),
        contentHash: createHash('sha256')
          .update(
            binding.protocol === 'http' || sample === undefined
              ? body
              : JSON.stringify(sample),
          )
          .digest('hex'),
      };
      if (response.status === 429 && !rateLimitAbort.signal.aborted)
        rateLimitAbort.abort(
          new DOMException('Rate limit observed', 'AbortError'),
        );
      await emit({
        formatVersion,
        systemId,
        operationId,
        at: observation.observedAt,
        type: response.status === 429 ? 'rate-limit' : 'response',
        attempt: spec.attempt.attempt,
        durationMs: observation.durationMs,
        status: response.status,
        bytes: observation.bytes,
        headers: safeHeaders,
        ...(sample === undefined ? {} : { sample }),
        message:
          response.status === 429
            ? 'The host returned 429; this operation will stop.'
            : `${binding.protocol.toUpperCase()} response observed from the local workbench.`,
      });
      return {
        observation,
        rateLimited: response.status === 429,
        cancelled: false,
      };
    } catch (error) {
      const at = eventAt(clock);
      const timedOut = timeout.signal.aborted && !operationAbort.signal.aborted;
      const operationCancelled = operationAbort.signal.aborted;
      const stoppedAfterRateLimit =
        rateLimitAbort.signal.aborted &&
        !operationCancelled &&
        !timeout.signal.aborted;
      const tooLarge = error instanceof ProbeResponseLimitError;
      await emit({
        formatVersion,
        systemId,
        operationId,
        at,
        type: 'error',
        attempt: spec.attempt.attempt,
        durationMs: Math.max(0, clock.now() - requestStartedMs),
        message: timedOut
          ? `Request timed out after ${limits.timeoutMs} ms.`
          : tooLarge
            ? `Response exceeded the ${limits.responseMaxBytes}-byte limit.`
            : operationCancelled
              ? 'Probe request was cancelled.'
              : stoppedAfterRateLimit
                ? 'Probe request stopped after a concurrent 429 response.'
                : `${binding.protocol.toUpperCase()} request failed under the bounded redirect policy.`,
      });
      return {
        rateLimited: false,
        cancelled: operationCancelled,
      };
    } finally {
      clearTimeout(timer);
      composed.cleanup();
    }
  };

  try {
    if (binding.protocol === 'mcp') {
      if (
        options.plan.setupCalls !== 3 ||
        options.plan.plannedCalls !== options.plan.attempts.length + 3
      )
        throw new ProbeRunError(
          'The MCP probe plan must budget its three session lifecycle calls.',
        );
      await emit({
        formatVersion,
        systemId,
        operationId,
        at: eventAt(clock),
        type: 'request-start',
        message: 'Bounded MCP session initialization started.',
      });
      try {
        mcpSessionHeaders = await initializeMcpHttpSession({
          endpoint: options.endpoint,
          headers,
          authorizedOrigin,
          signal: operationAbort.signal,
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.responseMaxBytes,
          fetch: fetcher,
          beforeCall: () =>
            rateLimiter.acquire(
              authorizedOrigin,
              1,
              limits.callsPerMinute,
              clock,
              operationAbort.signal,
            ),
        });
        specs = requestSpecs(
          options.operation,
          options.endpoint,
          attempts,
          mcpSessionHeaders,
          authorizedOrigin,
        );
        await emit({
          formatVersion,
          systemId,
          operationId,
          at: eventAt(clock),
          type: 'response',
          message: 'MCP session initialized within the operation bounds.',
        });
      } catch (error) {
        specs = [];
        const rateLimited =
          error instanceof McpSessionError && error.status === 429;
        if (rateLimited) {
          stoppedByRateLimit = true;
          rateLimitAbort.abort(
            new DOMException('Rate limit observed', 'AbortError'),
          );
        }
        await emit({
          formatVersion,
          systemId,
          operationId,
          at: eventAt(clock),
          type: rateLimited ? 'rate-limit' : 'error',
          ...(error instanceof McpSessionError
            ? { status: error.status, headers: error.headers }
            : {}),
          message: rateLimited
            ? 'The host returned 429 during MCP session setup; this operation will stop.'
            : error instanceof Error
              ? error.message
              : 'MCP session initialization failed.',
        });
      }
    }
    for (let index = 0; index < specs.length;) {
      if (stoppedByRateLimit || operationAbort.signal.aborted) break;
      const current = specs[index];
      const groupName = current.attempt.concurrencyGroup;
      let end = index + 1;
      if (groupName)
        while (
          end < specs.length &&
          specs[end].attempt.concurrencyGroup === groupName &&
          end - index < limits.maxConcurrency
        )
          end++;
      const group = specs.slice(index, end);
      const notBefore = Math.max(
        ...group.map((spec) => spec.attempt.notBeforeMs),
      );
      const wait = startedMs + notBefore - clock.now();
      if (wait > 0) {
        try {
          await clock.sleep(wait, operationAbort.signal);
        } catch {
          cancelled = true;
          break;
        }
      }
      if (
        operationAbort.signal.aborted ||
        clock.now() - startedMs >= limits.operationMaxMs
      ) {
        cancelled = true;
        break;
      }
      try {
        await rateLimiter.acquire(
          authorizedOrigin,
          group.length,
          limits.callsPerMinute,
          clock,
          operationAbort.signal,
        );
      } catch {
        cancelled = operationAbort.signal.aborted;
        if (!cancelled)
          throw new ProbeRunError('Probe rate scheduling failed.');
        break;
      }
      if (
        operationAbort.signal.aborted ||
        clock.now() - startedMs >= limits.operationMaxMs
      ) {
        cancelled = true;
        break;
      }
      const starts = group.map(() => clock.now());
      for (let offset = 0; offset < group.length; offset++) {
        attemptedCalls++;
        void emit({
          formatVersion,
          systemId,
          operationId,
          at: new Date(starts[offset]).toISOString(),
          type: 'request-start',
          attempt: group[offset].attempt.attempt,
          message: `Bounded ${binding.protocol.toUpperCase()} request started.`,
        }).catch(() => undefined);
      }
      const outcomes = await Promise.all(
        group.map((spec, offset) => execute(spec, starts[offset])),
      );
      for (const outcome of outcomes) {
        if (outcome.observation) observations.push(outcome.observation);
        stoppedByRateLimit ||= outcome.rateLimited;
        cancelled ||= outcome.cancelled;
      }
      index = end;
    }
    if (
      mcpSessionHeaders &&
      !stoppedByRateLimit &&
      !operationAbort.signal.aborted
    ) {
      try {
        await closeMcpHttpSession({
          endpoint: options.endpoint,
          headers: mcpSessionHeaders,
          authorizedOrigin,
          signal: operationAbort.signal,
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.responseMaxBytes,
          fetch: fetcher,
          beforeCall: () =>
            rateLimiter.acquire(
              authorizedOrigin,
              1,
              limits.callsPerMinute,
              clock,
              operationAbort.signal,
            ),
        });
        await emit({
          formatVersion,
          systemId,
          operationId,
          at: eventAt(clock),
          type: 'response',
          message: 'MCP session cleanup completed within the operation bounds.',
        });
      } catch (error) {
        await emit({
          formatVersion,
          systemId,
          operationId,
          at: eventAt(clock),
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'MCP session cleanup failed.',
        });
      }
    }
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', externalAbort);
  }
  cancelled ||= operationAbort.signal.aborted && !stoppedByRateLimit;
  const completedAt = eventAt(clock);
  await emit({
    formatVersion,
    systemId,
    operationId,
    at: completedAt,
    type: 'complete',
    message: stoppedByRateLimit
      ? 'Probe stopped at the first observed rate-limit response.'
      : cancelled
        ? 'Probe stopped by cancellation or its operation deadline.'
        : 'Bounded local-workbench probe completed.',
  });
  await writes;
  return {
    systemId,
    operationId,
    endpoint: templateEndpoint(options.endpoint, binding.pathTemplate),
    startedAt,
    completedAt,
    attemptedCalls,
    events,
    observations,
    stoppedByRateLimit,
    cancelled,
  };
}

export const runProbe = runProbeOperation;

export interface RunProbePlanOptions {
  workspace: string;
  input: DesignInput;
  plan: ProbePlan;
  authorizedHosts?: readonly AuthorizedHost[];
  env?: Record<string, string | undefined>;
  headers?:
    | Record<string, string>
    | ((
        systemId: string,
        operationId: string,
      ) => Record<string, string> | undefined);
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  clock?: ProbeClock;
  onEvent?: (event: ProbeEvent) => void;
}

/**
 * Explicit whole-plan runner. It authorizes every selected origin before the
 * first fetch and shares one host rate limiter across operations.
 */
export async function runProbePlan(
  options: RunProbePlanOptions,
): Promise<ProbeRunResult[]> {
  const selected = options.plan.operations.filter(
    (operation) =>
      operation.safe && operation.executable && operation.plannedCalls > 0,
  );
  const totals = new Map<string, number>();
  for (const operation of selected) {
    if (!operation.origin || !operation.endpoint)
      throw new ProbeRunError('An executable probe plan needs an endpoint.');
    totals.set(
      operation.origin,
      (totals.get(operation.origin) ?? 0) + operation.plannedCalls,
    );
  }
  if (
    [...totals.values()].some(
      (calls) =>
        calls >
        Math.min(
          defaultProbeLimits.hostMaxCalls,
          options.plan.limits.hostMaxCalls,
        ),
    )
  )
    throw new ProbeRunError('The probe plan exceeds the per-host call budget.');
  const execution = selected.map((planned) => {
    const system = options.input.systems.find(
      (candidate) => candidate.id === planned.systemId,
    );
    const operation = system?.operations.find(
      (candidate) => candidate.id === planned.operationId,
    );
    if (!system || !operation)
      throw new ProbeRunError(
        `Planned operation ${planned.systemId}/${planned.operationId} is missing.`,
      );
    return { planned, system, operation };
  });
  const hosts =
    options.authorizedHosts ?? (await readAuthorizedHosts(options.workspace));
  for (const operation of selected)
    await assertAuthorizedOrigin(options.workspace, operation.endpoint!, hosts);
  const rateLimiter = new ProbeRateLimiter();
  const results: ProbeRunResult[] = [];
  for (const { planned, system, operation } of execution) {
    if (options.signal?.aborted) break;
    const ephemeralHeaders =
      typeof options.headers === 'function'
        ? options.headers(planned.systemId, planned.operationId)
        : options.headers;
    results.push(
      await runProbeOperation({
        workspace: options.workspace,
        systemId: system.id,
        operation,
        endpoint: planned.endpoint!,
        plan: planned,
        authorizedHosts: hosts,
        env: options.env,
        headers: ephemeralHeaders,
        signal: options.signal,
        fetch: options.fetch,
        clock: options.clock,
        rateLimiter,
        onEvent: options.onEvent,
      }),
    );
  }
  return results;
}
