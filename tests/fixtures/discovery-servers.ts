import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
/** Local stand-ins for an MCP server and an A2A agent, recording every request. */
export interface Fixture {
  url: string;
  origin: string;
  requests: {
    method: string;
    path: string;
    rpc?: string;
    headers: IncomingHttpHeaders;
  }[];
  close(): Promise<void>;
}
const pathOf = (req: IncomingMessage) =>
  new URL(req.url!, 'http://fixture').pathname;
const read = (req: IncomingMessage) =>
  new Promise<string>((done, fail) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (text += c));
    req.on('end', () => done(text));
    req.on('error', fail);
  });
async function serve(
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    text: string,
    entry: Fixture['requests'][number],
  ) => void | Promise<void>,
  path: string,
): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const text = await read(req);
    const entry = { method: req.method!, path: req.url!, headers: req.headers };
    requests.push(entry);
    await handle(req, res, text, entry);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin + path,
    origin,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
export interface McpFixtureOptions {
  tools: unknown[];
  /** Tools per tools/list page; every tool on one page when omitted. */
  pageSize?: number;
  /** A header every request must carry, as [name, value]. */
  require?: [string, string];
  serverInfo?: { name: string; version: string; title?: string };
  capabilities?: Record<string, unknown>;
  /** Waits this long before answering tools/list. */
  delayMs?: number;
  /** Always answers tools/list with this cursor. */
  stuckCursor?: string;
  /** Pads each tools/list answer with this many bytes. */
  padBytes?: number;
}
/** A Streamable HTTP MCP server at /mcp that answers with JSON, never with a stream. */
export function startMcpFixture(options: McpFixtureOptions): Promise<Fixture> {
  let sessions = 0;
  return serve(async (req, res, text, entry) => {
    if (
      options.require &&
      req.headers[options.require[0].toLowerCase()] !== options.require[1]
    ) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end('{"error":"unauthorized"}');
    }
    if (pathOf(req) !== '/mcp') return void res.writeHead(404).end();
    if (req.method === 'GET') return void res.writeHead(405).end();
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    const message = JSON.parse(text);
    entry.rpc = message.method;
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (body: Record<string, unknown>, headers = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }));
    };
    if (message.method === 'initialize')
      return reply(
        {
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: options.capabilities ?? { tools: {} },
            serverInfo: options.serverInfo ?? {
              name: 'fixture',
              version: '1.0.0',
            },
          },
        },
        { 'mcp-session-id': `session-${++sessions}` },
      );
    if (message.method !== 'tools/list')
      return reply({ error: { code: -32601, message: 'Method not found' } });
    if (options.delayMs)
      await new Promise((done) => setTimeout(done, options.delayMs));
    const size = options.pageSize ?? Math.max(1, options.tools.length);
    const start = Number(message.params?.cursor ?? 0);
    const next = start + size;
    reply({
      result: {
        tools: options.tools.slice(start, next),
        ...(options.stuckCursor
          ? { nextCursor: options.stuckCursor }
          : next < options.tools.length
            ? { nextCursor: String(next) }
            : {}),
        ...(options.padBytes ? { _pad: 'x'.repeat(options.padBytes) } : {}),
      },
    });
  }, '/mcp');
}
export type Route = {
  status?: number;
  json?: unknown;
  text?: string;
  location?: string;
  /** A header every request must carry, as [name, value]. */
  require?: [string, string];
};
/** An HTTP server answering fixed routes by path; anything else is a 404. */
export function startRoutes(routes: Record<string, Route>): Promise<Fixture> {
  return serve((req, res) => {
    const route = routes[pathOf(req)];
    if (!route) return void res.writeHead(404).end();
    if (
      route.require &&
      req.headers[route.require[0].toLowerCase()] !== route.require[1]
    )
      return void res.writeHead(401).end();
    res.writeHead(route.status ?? 200, {
      ...(route.json !== undefined
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'text/html' }),
      ...(route.location ? { location: route.location } : {}),
    });
    res.end(
      route.json !== undefined
        ? JSON.stringify(route.json)
        : (route.text ?? ''),
    );
  }, '');
}
export const fixtureTools = (n: number, prefix = 'tool') =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${i + 1}`,
    title: `Tool ${i + 1}`,
    description: `Fixture tool ${i + 1}`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }));
