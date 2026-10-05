import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { guardDocument } from '../contracts/index';
import type { JsonObject } from '../contracts/index';
/**
 * Live discovery for the local workbench only. MCP discovery initializes a
 * Streamable HTTP session, lists tools and ends the session; it never calls a
 * tool. A2A discovery reads the public Agent Card; it never sends a message.
 * Headers are used for these requests only and are never stored or logged.
 */
export const discoveryLimits = {
  timeoutMs: 15_000,
  /** Per HTTP response, including an MCP event stream. */
  responseBytes: 1024 * 1024,
  /** Across every tools/list page. */
  listedBytes: 2 * 1024 * 1024,
  pages: 20,
  tools: 500,
  cardBytes: 256 * 1024,
  redirects: 3,
  headers: 8,
  headerBytes: 8 * 1024,
  urlLength: 2048,
};
export class DiscoveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface DiscoveryRequest {
  protocol: 'mcp' | 'a2a';
  url: string;
  /** Sent with every discovery request; never stored. */
  headers: Record<string, string>;
}
export interface McpDiscovery {
  protocol: 'mcp';
  /** The endpoint without query, fragment or credentials. */
  url: string;
  server: { name: string; version: string; title?: string };
  protocolVersion: string;
  /** Tool definitions as listed, in order; entries without a name are skipped. */
  tools: JsonObject[];
  /** False when a bound stopped listing or the server offers no tools. */
  complete: boolean;
  notes: string[];
  discoveredAt: string;
}
export interface A2aDiscovery {
  protocol: 'a2a';
  /** The Agent Card URL that answered, without query, fragment or credentials. */
  url: string;
  card: JsonObject;
  notes: string[];
  discoveredAt: string;
}
export type Discovery = McpDiscovery | A2aDiscovery;
/** The URL as Plug may keep or show it: no credentials, query or fragment. */
export function publicUrl(url: string | URL): string {
  const u = new URL(url);
  u.username = u.password = u.search = u.hash = '';
  return u.href;
}
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Set by the transport, or meaningful only to a single hop. */
const managedHeaders = new Set([
  'accept',
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
export function parseDiscoveryRequest(body: unknown): DiscoveryRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new DiscoveryError(400, 'Send protocol, url and headers.');
  const { protocol, url, headers = {} } = body as Record<string, unknown>;
  if (protocol !== 'mcp' && protocol !== 'a2a')
    throw new DiscoveryError(400, 'Discovery supports MCP and A2A.');
  if (typeof url !== 'string' || !url.trim())
    throw new DiscoveryError(400, 'Enter the server URL.');
  if (url.length > discoveryLimits.urlLength)
    throw new DiscoveryError(400, 'URLs are limited to 2048 characters.');
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new DiscoveryError(400, 'Enter an absolute http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new DiscoveryError(
      400,
      'Discovery supports http:// and https:// URLs.',
    );
  if (parsed.username || parsed.password)
    throw new DiscoveryError(
      400,
      'Put credentials in a request header, not in the URL.',
    );
  parsed.hash = '';
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw new DiscoveryError(400, 'Headers are name and value pairs.');
  const entries = Object.entries(headers);
  if (entries.length > discoveryLimits.headers)
    throw new DiscoveryError(400, 'Send at most eight headers.');
  let bytes = 0;
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!tokenPattern.test(name))
      throw new DiscoveryError(
        400,
        `“${name.slice(0, 64)}” is not a valid header name.`,
      );
    if (managedHeaders.has(name.toLowerCase()))
      throw new DiscoveryError(400, `Plug sets the ${name} header itself.`);
    if (seen.has(name.toLowerCase()))
      throw new DiscoveryError(400, `The ${name} header is listed twice.`);
    seen.add(name.toLowerCase());
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new DiscoveryError(
        400,
        `The ${name} header needs a single-line value.`,
      );
    bytes += name.length + value.length;
  }
  if (bytes > discoveryLimits.headerBytes)
    throw new DiscoveryError(400, 'Headers are limited to 8 KB.');
  return {
    protocol,
    url: parsed.href,
    headers: Object.fromEntries(entries) as Record<string, string>,
  };
}
/** One deadline for the whole discovery, also ended by the caller's signal. */
function deadline(outer?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DiscoveryError(
          504,
          `No complete answer within ${discoveryLimits.timeoutMs / 1000} seconds.`,
        ),
      ),
    discoveryLimits.timeoutMs,
  );
  const cancel = () =>
    controller.abort(new DiscoveryError(499, 'Discovery was cancelled.'));
  if (outer?.aborted) cancel();
  outer?.addEventListener('abort', cancel, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', cancel);
    },
  };
}
const tooLarge = (bytes: number) =>
  new DiscoveryError(
    502,
    `The server's response exceeded ${Math.round(bytes / 1024)} KB.`,
  );
/** fetch bound to the deadline whose bodies stop at the response limit. */
function boundedFetch(signal: AbortSignal, max: number) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel();
      throw tooLarge(max);
    }
    if (!response.body || [101, 204, 205, 304].includes(response.status))
      return response;
    let seen = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > max) controller.error(tooLarge(max));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
async function readCapped(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw tooLarge(max);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
/** Turns transport, protocol and network failures into something the user can act on. */
function explain(e: unknown, signal: AbortSignal, url: URL): DiscoveryError {
  if (signal.aborted && signal.reason instanceof DiscoveryError)
    return signal.reason;
  if (e instanceof DiscoveryError) return e;
  const where = publicUrl(url);
  if (e instanceof StreamableHTTPError) {
    if (e.code === 401 || e.code === 403)
      return new DiscoveryError(
        502,
        `${where} refused the request (HTTP ${e.code}). Add the header it expects, for example Authorization: Bearer <token>.`,
      );
    if (e.code === 404 || e.code === 405)
      return new DiscoveryError(
        502,
        `No MCP Streamable HTTP endpoint answered at ${where} (HTTP ${e.code}). Use the server's MCP endpoint, which often ends in /mcp.`,
      );
    if (e.code === -1)
      return new DiscoveryError(
        502,
        `${where} did not answer as an MCP server: ${e.message.replace(/^Streamable HTTP error: /, '')}.`,
      );
    if (e.code !== undefined && e.code >= 300 && e.code < 400) {
      const target = /Redirect to (\S+) not followed/.exec(e.message)?.[1];
      return new DiscoveryError(
        502,
        `${where} redirected${target ? ` to ${target}` : ''}. Enter that URL instead; Plug does not forward headers to another origin.`,
      );
    }
    return new DiscoveryError(502, `${where} answered HTTP ${e.code}.`);
  }
  if (e instanceof McpError)
    return new DiscoveryError(
      502,
      `${where} returned an MCP error: ${e.message.slice(0, 300)}`,
    );
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  if (e instanceof TypeError && cause)
    return new DiscoveryError(
      502,
      `Could not reach ${url.host}: ${
        cause.code === 'ECONNREFUSED'
          ? 'connection refused'
          : cause.code === 'ENOTFOUND'
            ? 'host not found'
            : (cause.code ?? cause.message ?? 'network error')
      }.`,
    );
  if (e instanceof SyntaxError || (e as Error)?.name === 'ZodError')
    return new DiscoveryError(
      502,
      `${where} did not answer with MCP JSON-RPC messages.`,
    );
  return new DiscoveryError(
    502,
    `Discovery failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`,
  );
}
const toolsPage = z.looseObject({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});
/** Initializes an MCP Streamable HTTP session, lists every tool within bounds, then ends the session. */
export async function discoverMcp(
  request: DiscoveryRequest,
  options: { signal?: AbortSignal; clientVersion?: string } = {},
): Promise<McpDiscovery> {
  const url = new URL(request.url);
  const limit = deadline(options.signal);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: request.headers },
    fetch: boundedFetch(limit.signal, discoveryLimits.responseBytes),
  });
  const client = new Client(
    { name: 'plug', version: options.clientVersion ?? '0.2.0' },
    { capabilities: {} },
  );
  const call = { signal: limit.signal, timeout: discoveryLimits.timeoutMs };
  try {
    await client.connect(transport, call);
    const server = client.getServerVersion();
    const notes: string[] = [];
    const tools: JsonObject[] = [];
    let complete = true;
    if (!client.getServerCapabilities()?.tools) {
      complete = false;
      notes.push('The server does not declare the tools capability.');
    } else {
      const names = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | undefined,
        pages = 0,
        bytes = 0,
        skipped = 0;
      do {
        const page = await client.request(
          { method: 'tools/list', params: cursor ? { cursor } : {} },
          toolsPage,
          call,
        );
        pages++;
        bytes += JSON.stringify(page.tools).length;
        for (const t of page.tools) {
          const tool = t as JsonObject;
          if (
            !tool ||
            typeof tool !== 'object' ||
            Array.isArray(tool) ||
            typeof tool.name !== 'string' ||
            !tool.name
          )
            skipped++;
          else if (!names.has(tool.name)) {
            names.add(tool.name);
            tools.push(tool);
          }
        }
        cursor = page.nextCursor || undefined;
        if (!cursor) break;
        const stop = cursors.has(cursor)
          ? 'The server repeated a page cursor'
          : pages >= discoveryLimits.pages
            ? `Listing stopped after ${discoveryLimits.pages} pages`
            : tools.length >= discoveryLimits.tools
              ? `Listing stopped after ${discoveryLimits.tools} tools`
              : bytes > discoveryLimits.listedBytes
                ? 'Listing stopped after 2 MB of tool definitions'
                : null;
        if (stop) {
          complete = false;
          notes.push(`${stop}; more tools may exist.`);
          break;
        }
        cursors.add(cursor);
      } while (cursor);
      if (skipped)
        notes.push(
          `${skipped} listed ${skipped === 1 ? 'entry was' : 'entries were'} not a named tool and ${skipped === 1 ? 'was' : 'were'} skipped.`,
        );
    }
    return {
      protocol: 'mcp',
      url: publicUrl(url),
      server: {
        name: server?.name ?? url.host,
        version: server?.version ?? 'unknown',
        ...(typeof server?.title === 'string' ? { title: server.title } : {}),
      },
      protocolVersion: transport.protocolVersion ?? 'unknown',
      tools: tools.slice(0, discoveryLimits.tools),
      complete,
      notes,
      discoveredAt: new Date().toISOString(),
    };
  } catch (e) {
    throw explain(e, limit.signal, url);
  } finally {
    if (!limit.signal.aborted)
      await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    limit.done();
  }
}
const redirectStatuses = [301, 302, 303, 307, 308];
/** The same origin, or its https form on default ports, as the MCP transport allows. */
const withinOrigin = (from: URL, to: URL) =>
  from.origin === to.origin ||
  (from.hostname === to.hostname &&
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    !from.port &&
    !to.port);
/** GET that follows at most three redirects, and only within the origin, so headers never leave it. */
async function getWithinOrigin(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ response: Response; at: URL }> {
  let at = url;
  for (let hops = 0; ; hops++) {
    const response = await fetch(at, {
      headers: { ...headers, accept: 'application/json' },
      redirect: 'manual',
      signal,
    });
    if (!redirectStatuses.includes(response.status)) return { response, at };
    await response.body?.cancel();
    const location = response.headers.get('location');
    let next: URL | null;
    try {
      next = location ? new URL(location, at) : null;
    } catch {
      next = null;
    }
    if (!next || hops >= discoveryLimits.redirects)
      throw new DiscoveryError(
        502,
        `${publicUrl(at)} redirected ${next ? 'too many times' : 'without a valid location'}.`,
      );
    if (!withinOrigin(at, next) || next.username || next.password)
      throw new DiscoveryError(
        502,
        `${publicUrl(at)} redirected to ${publicUrl(next)}. Enter that URL instead; Plug does not forward headers to another origin.`,
      );
    at = next;
  }
}
/** The card itself when the URL names a .json file; otherwise its well-known locations. */
export function agentCardUrls(url: string): URL[] {
  const base = new URL(url);
  if (base.pathname.endsWith('.json')) return [base];
  const at = (path: string) => {
    const u = new URL(base);
    u.pathname = path;
    return u;
  };
  const path = base.pathname.replace(/\/+$/, '');
  const urls = [
    ...(path ? [at(`${path}/.well-known/agent-card.json`)] : []),
    at('/.well-known/agent-card.json'),
    at('/.well-known/agent.json'),
  ];
  return urls.filter((u, i) => urls.findIndex((v) => v.href === u.href) === i);
}
/** Reads the public Agent Card from the URL or its well-known locations. */
export async function discoverA2a(
  request: DiscoveryRequest,
  options: { signal?: AbortSignal } = {},
): Promise<A2aDiscovery> {
  const url = new URL(request.url);
  const limit = deadline(options.signal);
  const tried: string[] = [];
  try {
    for (const candidate of agentCardUrls(request.url)) {
      const { response, at } = await getWithinOrigin(
        candidate,
        request.headers,
        limit.signal,
      );
      const where = publicUrl(at);
      tried.push(publicUrl(candidate));
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DiscoveryError(
          502,
          `${where} refused the request (HTTP ${response.status}). Add the header it expects, for example Authorization: Bearer <token>.`,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiscoveryError(
          502,
          `${where} answered HTTP ${response.status}.`,
        );
      }
      const text = await readCapped(response, discoveryLimits.cardBytes);
      let card: unknown;
      try {
        card = JSON.parse(text);
      } catch {
        throw new DiscoveryError(502, `${where} did not return JSON.`);
      }
      try {
        guardDocument(card);
      } catch (e) {
        throw new DiscoveryError(
          502,
          `The Agent Card at ${where} is unsupported: ${(e as Error).message}.`,
        );
      }
      const c = card as JsonObject;
      if (
        !c ||
        typeof c !== 'object' ||
        Array.isArray(c) ||
        typeof c.name !== 'string' ||
        !Array.isArray(c.skills)
      )
        throw new DiscoveryError(
          502,
          `${where} is not an A2A Agent Card: a card has a name and a list of skills.`,
        );
      return {
        protocol: 'a2a',
        url: where,
        card: c,
        notes: Array.isArray(c.supportedInterfaces)
          ? []
          : [
              'This card predates A2A 1.0; Plug reads its transports but makes no compatibility claim.',
            ],
        discoveredAt: new Date().toISOString(),
      };
    }
    throw new DiscoveryError(404, `No Agent Card at ${tried.join(' or ')}.`);
  } catch (e) {
    throw explain(e, limit.signal, url);
  } finally {
    limit.done();
  }
}
export function discover(
  request: DiscoveryRequest,
  options: { signal?: AbortSignal; clientVersion?: string } = {},
): Promise<Discovery> {
  return request.protocol === 'mcp'
    ? discoverMcp(request, options)
    : discoverA2a(request, options);
}
