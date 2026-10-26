import { createHash } from 'node:crypto';
import type {
  AuthorizedHost,
  ExactKey,
  JsonObject,
  RequestBinding,
  ResponseBinding,
  SourceResponse,
} from '../contracts/index';
import { canonicalOrigin, originIsAuthorized } from '../probe/hosts';
import {
  decodeProtocolBody,
  closeMcpHttpSession,
  initializeMcpHttpSession,
  renderBoundRequest,
  resolveRequestHeaders,
  unwrapJsonRpc,
} from '../probe/run';

export interface SourceAdapterRequest {
  key: ExactKey;
  refresh: boolean;
  signal: AbortSignal;
  maxBytes: number;
}

export interface SourceAdapterResult {
  response: SourceResponse;
  bytes: number;
}

/**
 * A bounded source transport used by the local runner. Implementations must
 * reject redirects, honor the supplied signal, and enforce maxBytes.
 */
export interface SourceAdapter {
  readonly endpoint: string;
  request(options: SourceAdapterRequest): Promise<SourceAdapterResult>;
  close?(signal?: AbortSignal): Promise<void>;
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('Source response exceeds memory limit');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const decodeJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Source response is not valid JSON');
  }
};

const loopback = (url: URL) =>
  url.protocol === 'http:' &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
  !url.username &&
  !url.password;

/** Adapter for Plug's existing POST + SourceResponse fixture envelope. */
export class PlugEnvelopeAdapter implements SourceAdapter {
  readonly endpoint: string;

  constructor(endpoint: string) {
    const parsed = new URL(endpoint);
    if (!loopback(parsed))
      throw new Error(
        'Plug envelope execution requires an explicitly trusted loopback HTTP binding',
      );
    this.endpoint = parsed.href;
  }

  async request(options: SourceAdapterRequest): Promise<SourceAdapterResult> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Plug-Refresh': String(options.refresh),
      },
      body: JSON.stringify(options.key),
      signal: options.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
    const bytes = await readBounded(response, options.maxBytes);
    return {
      response: decodeJson(bytes) as SourceResponse,
      bytes: bytes.byteLength,
    };
  }
}

export interface HttpBindingAdapterOptions {
  endpoint: string;
  request: RequestBinding;
  response: ResponseBinding;
  authorizedHosts: readonly AuthorizedHost[];
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/'))
    throw new Error('Response pointer must be RFC 6901');
  let current = value;
  for (const encoded of path.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    )
      throw new Error(`Response pointer ${path} did not resolve`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function timestamp(value: unknown, format: ResponseBinding['timestampFormat']) {
  if (format === 'epoch-milliseconds' && typeof value === 'number')
    return value;
  if (format === 'epoch-seconds' && typeof value === 'number')
    return value * 1000;
  if (format === 'iso-8601' && typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dataVersion(value: JsonObject): number {
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
  return Number.parseInt(digest, 16);
}

/**
 * Adapter for an HTTP-carried binding, including MCP and A2A JSON-RPC.
 * Construction requires an origin the author added to .plug/hosts.json;
 * credentials remain in env.
 */
export class HttpBindingAdapter implements SourceAdapter {
  readonly endpoint: string;
  readonly #requestBinding: RequestBinding;
  readonly #responseBinding: ResponseBinding;
  readonly #origin: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;
  #requestId = 0;
  #mcpSession: Promise<Record<string, string>> | null = null;

  constructor(options: HttpBindingAdapterOptions) {
    const endpoint = new URL(options.endpoint);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    if (!originIsAuthorized(endpoint, options.authorizedHosts))
      throw new Error(
        `Origin ${canonicalOrigin(endpoint)} is not authorized in .plug/hosts.json`,
      );
    this.endpoint = endpoint.href;
    this.#origin = canonicalOrigin(endpoint);
    this.#requestBinding = options.request;
    this.#responseBinding = options.response;
    this.#headers = resolveRequestHeaders(
      options.request.headers,
      options.env ?? process.env,
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request(options: SourceAdapterRequest): Promise<SourceAdapterResult> {
    const binding = this.#requestBinding;
    if (binding.protocol === 'mcp' && !this.#mcpSession)
      this.#mcpSession = initializeMcpHttpSession({
        endpoint: this.endpoint,
        headers: this.#headers,
        authorizedOrigin: this.#origin,
        signal: options.signal,
        timeoutMs: 10_000,
        maxBytes: options.maxBytes,
        fetch: this.#fetch,
      });
    const headers = this.#mcpSession ? await this.#mcpSession : this.#headers;
    const rendered = renderBoundRequest(
      binding,
      this.endpoint,
      options.key,
      headers,
      this.#origin,
      `plug-verify-${++this.#requestId}`,
    );
    const response = await this.#fetch(rendered.url, {
      ...rendered.init,
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
    const bytes = await readBounded(response, options.maxBytes);
    const decoded = decodeProtocolBody(
      bytes,
      response.headers.get('content-type') ?? '',
    );
    const document =
      binding.protocol === 'http' ||
      ['GET', 'HEAD'].includes(binding.method.trim().toUpperCase())
        ? decoded
        : unwrapJsonRpc(decoded);
    if (
      binding.protocol !== 'http' &&
      document &&
      typeof document === 'object' &&
      !Array.isArray(document) &&
      Object.hasOwn(document, 'error')
    )
      throw new Error('Source protocol returned an error response');
    const dataValue =
      this.#responseBinding.dataPointer === null
        ? document
        : pointer(document, this.#responseBinding.dataPointer);
    if (!dataValue || typeof dataValue !== 'object' || Array.isArray(dataValue))
      throw new Error('Response binding did not select an object');
    const data = dataValue as JsonObject;
    let sourceTime: unknown;
    if (this.#responseBinding.snapshotPointer !== null)
      sourceTime = pointer(document, this.#responseBinding.snapshotPointer);
    else if (this.#responseBinding.snapshotHeader !== null)
      sourceTime = response.headers.get(this.#responseBinding.snapshotHeader);
    const snapshotAt =
      timestamp(sourceTime, this.#responseBinding.timestampFormat) ??
      Date.now();
    return {
      response: {
        snapshotAt,
        version: dataVersion(data),
        data,
      },
      bytes: bytes.byteLength,
    };
  }

  async close(signal?: AbortSignal): Promise<void> {
    if (!this.#mcpSession) return;
    const headers = await this.#mcpSession;
    const fallback = new AbortController();
    const timer = signal
      ? null
      : setTimeout(
          () =>
            fallback.abort(
              new DOMException('MCP cleanup timed out', 'TimeoutError'),
            ),
          10_000,
        );
    try {
      await closeMcpHttpSession({
        endpoint: this.endpoint,
        headers,
        authorizedOrigin: this.#origin,
        signal: signal ?? fallback.signal,
        timeoutMs: 10_000,
        maxBytes: 1024 * 1024,
        fetch: this.#fetch,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.#mcpSession = null;
    }
  }
}
