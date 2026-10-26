import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  DiscoveryError,
  agentCardUrls,
  discover,
  discoveryLimits,
  parseDiscoveryRequest,
  publicUrl,
} from '../packages/plug/src/discovery/index';
import { importA2a } from '../packages/plug/src/importers/index';
import {
  fixtureTools,
  startMcpFixture,
  startRoutes,
  type Fixture,
} from './fixtures/discovery-servers';
const open: Fixture[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});
const track = async (f: Promise<Fixture>) => {
  const fixture = await f;
  open.push(fixture);
  return fixture;
};
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DiscoveryError);
    return e as DiscoveryError;
  }
  throw new Error('Expected discovery to fail');
};
const card = (url: string) => ({
  name: 'Travel agent',
  description: 'Books trips',
  supportedInterfaces: [
    { url, protocolVersion: '1.0', protocolBinding: 'JSONRPC' },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    { id: 'search', name: 'Search', description: 'Find flights' },
    { id: 'book', name: 'Book', description: 'Book a flight' },
  ],
});
describe('discovery requests', () => {
  it('accepts http(s) URLs and plain headers only', () => {
    const ok = parseDiscoveryRequest({
      protocol: 'mcp',
      url: ' https://example.test/mcp?tenant=1#top ',
      headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'k' },
    });
    expect(ok.url).toBe('https://example.test/mcp?tenant=1');
    expect(ok.headers).toEqual({
      Authorization: 'Bearer secret',
      'X-Api-Key': 'k',
    });
    expect(
      parseDiscoveryRequest({
        protocol: 'http',
        url: 'https://example.test/openapi.json',
        headers: {},
      }).protocol,
    ).toBe('http');
    const reject = (body: unknown, message: RegExp) => {
      try {
        parseDiscoveryRequest(body);
      } catch (e) {
        expect(e).toBeInstanceOf(DiscoveryError);
        expect((e as DiscoveryError).status).toBe(400);
        expect((e as Error).message).toMatch(message);
        return;
      }
      throw new Error('Expected a rejection');
    };
    const mcp = (url: string, headers: unknown = {}) => ({
      protocol: 'mcp',
      url,
      headers,
    });
    reject({ protocol: 'grpc', url: 'https://x.test' }, /MCP and A2A/);
    reject(mcp(''), /server URL/);
    reject(mcp('example.test/mcp'), /absolute/);
    reject(mcp('file:///etc/passwd'), /http/);
    reject(
      mcp('https://user:pw@x.test/mcp'),
      /credentials in a request header/,
    );
    reject(mcp(`https://x.test/${'a'.repeat(2048)}`), /2048/);
    reject(mcp('https://x.test', []), /name and value/);
    reject(mcp('https://x.test', { Host: 'evil' }), /sets the Host header/);
    reject(mcp('https://x.test', { 'Mcp-Session-Id': '1' }), /sets the/);
    reject(mcp('https://x.test', { 'Bad Name': 'v' }), /not a valid header/);
    reject(mcp('https://x.test', { A: 'one\r\nB: two' }), /single-line/);
    reject(mcp('https://x.test', { A: 1 }), /single-line/);
    reject(mcp('https://x.test', { a: '1', A: '2' }), /twice/);
    reject(
      mcp(
        'https://x.test',
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`h${i}`, 'v'])),
      ),
      /eight/,
    );
    reject(mcp('https://x.test', { A: 'x'.repeat(9000) }), /8 KB/);
  });
  it('keeps URLs without credentials, query or fragment', () => {
    expect(publicUrl('https://u:p@x.test/mcp?token=1#f')).toBe(
      'https://x.test/mcp',
    );
  });
  it('looks for Agent Cards at the URL, then the well-known locations', () => {
    expect(agentCardUrls('https://x.test/cards/a.json').map(String)).toEqual([
      'https://x.test/cards/a.json',
    ]);
    expect(agentCardUrls('https://x.test/agents/travel/').map(String)).toEqual([
      'https://x.test/agents/travel/.well-known/agent-card.json',
      'https://x.test/.well-known/agent-card.json',
      'https://x.test/.well-known/agent.json',
    ]);
    expect(agentCardUrls('https://x.test').map(String)).toEqual([
      'https://x.test/.well-known/agent-card.json',
      'https://x.test/.well-known/agent.json',
    ]);
  });
});
describe('MCP discovery', () => {
  it('lists every page with the supplied header, then ends the session without calling a tool', async () => {
    const server = await track(
      startMcpFixture({
        tools: fixtureTools(5),
        pageSize: 2,
        require: ['Authorization', 'Bearer s3cret'],
        serverInfo: { name: 'flights', version: '2.1.0', title: 'Flights' },
      }),
    );
    const found = await discover({
      protocol: 'mcp',
      url: `${server.url}?tenant=a`,
      headers: { Authorization: 'Bearer s3cret' },
    });
    expect(found).toMatchObject({
      protocol: 'mcp',
      url: server.url,
      server: { name: 'flights', version: '2.1.0', title: 'Flights' },
      protocolVersion: LATEST_PROTOCOL_VERSION,
      complete: true,
      notes: [],
    });
    // The workbench's own fetch time rides along as a synthetic observation.
    expect(found.fetchMs).toBeGreaterThanOrEqual(0);
    expect(found.protocol === 'mcp' && found.tools.map((t) => t.name)).toEqual([
      'tool_1',
      'tool_2',
      'tool_3',
      'tool_4',
      'tool_5',
    ]);
    const rpc = server.requests.map((r) => r.rpc).filter(Boolean);
    expect(rpc).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
      'tools/list',
    ]);
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(true);
    expect(
      server.requests.every(
        (r) =>
          r.headers.authorization === 'Bearer s3cret' &&
          r.path === '/mcp?tenant=a',
      ),
    ).toBe(true);
    expect(JSON.stringify(found)).not.toContain('s3cret');
  });
  it('explains refusals, wrong endpoints and servers that are not MCP', async () => {
    const guarded = await track(
      startMcpFixture({
        tools: fixtureTools(1),
        require: ['Authorization', 'Bearer right'],
      }),
    );
    const refused = await failure(
      discover({ protocol: 'mcp', url: guarded.url, headers: {} }),
    );
    expect(refused.message).toMatch(/refused the request \(HTTP 401\)/);
    expect(refused.message).toContain('Authorization');
    const html = await track(
      startRoutes({ '/mcp': { text: '<html>hello</html>' } }),
    );
    expect(
      (
        await failure(
          discover({ protocol: 'mcp', url: html.url + '/mcp', headers: {} }),
        )
      ).message,
    ).toMatch(/did not answer as an MCP server/);
    expect(
      (
        await failure(
          discover({ protocol: 'mcp', url: html.url + '/nope', headers: {} }),
        )
      ).message,
    ).toMatch(/No MCP Streamable HTTP endpoint answered/);
    const free = createServer();
    await new Promise<void>((done) => free.listen(0, '127.0.0.1', done));
    const port = (free.address() as AddressInfo).port;
    await new Promise((done) => free.close(done));
    expect(
      (
        await failure(
          discover({
            protocol: 'mcp',
            url: `http://127.0.0.1:${port}/mcp`,
            headers: {},
          }),
        )
      ).message,
    ).toMatch(/connection refused/);
  });
  it('does not follow a redirect to another origin', async () => {
    const elsewhere = await track(startMcpFixture({ tools: fixtureTools(1) }));
    const moved = await track(
      startRoutes({
        '/mcp': {
          status: 307,
          location: elsewhere.url.replace('127.0.0.1', 'localhost'),
        },
      }),
    );
    const e = await failure(
      discover({
        protocol: 'mcp',
        url: moved.origin + '/mcp',
        headers: { Authorization: 'Bearer s3cret' },
      }),
    );
    expect(e.message).toMatch(
      /Plug does not forward headers to another origin/,
    );
    expect(elsewhere.requests).toHaveLength(0);
  });
  it('stops at its bounds and says the list may be incomplete', async () => {
    const none = await track(
      startMcpFixture({ tools: fixtureTools(2), capabilities: {} }),
    );
    expect(
      await discover({ protocol: 'mcp', url: none.url, headers: {} }),
    ).toMatchObject({
      complete: false,
      tools: [],
      notes: ['The server does not declare the tools capability.'],
    });
    const stuck = await track(
      startMcpFixture({ tools: fixtureTools(2), stuckCursor: 'again' }),
    );
    const repeated = await discover({
      protocol: 'mcp',
      url: stuck.url,
      headers: {},
    });
    expect(repeated).toMatchObject({ protocol: 'mcp', complete: false });
    expect(repeated.notes.join()).toMatch(/repeated a page cursor/);
    expect(stuck.requests.filter((r) => r.rpc === 'tools/list')).toHaveLength(
      2,
    );
    const messy = await track(
      startMcpFixture({
        tools: [...fixtureTools(2), { title: 'no name' }, fixtureTools(1)[0]],
      }),
    );
    const cleaned = await discover({
      protocol: 'mcp',
      url: messy.url,
      headers: {},
    });
    expect(cleaned.protocol === 'mcp' && cleaned.tools).toHaveLength(2);
    expect(cleaned.notes.join()).toMatch(/1 listed entry was not a named tool/);
  });
  it('caps response size, honours cancellation and gives up at the deadline', async () => {
    const big = await track(
      startMcpFixture({
        tools: fixtureTools(1),
        padBytes: discoveryLimits.responseBytes + 10,
      }),
    );
    expect(
      (await failure(discover({ protocol: 'mcp', url: big.url, headers: {} })))
        .message,
    ).toMatch(/exceeded 1024 KB/);
    const slow = await track(
      startMcpFixture({ tools: fixtureTools(1), delayMs: 2000 }),
    );
    const controller = new AbortController();
    const cancelled = discover(
      { protocol: 'mcp', url: slow.url, headers: {} },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    expect((await failure(cancelled)).status).toBe(499);
    const saved = discoveryLimits.timeoutMs;
    discoveryLimits.timeoutMs = 300;
    try {
      const late = await failure(
        discover({ protocol: 'mcp', url: slow.url, headers: {} }),
      );
      expect(late.status).toBe(504);
    } finally {
      discoveryLimits.timeoutMs = saved;
    }
  });
});
describe('A2A discovery', () => {
  it('reads the card from a well-known location with the supplied header', async () => {
    const agent = await track(
      startRoutes({
        '/.well-known/agent-card.json': {
          json: card('https://agent.test/a2a'),
          require: ['X-Api-Key', 'k1'],
        },
      }),
    );
    const found = await discover({
      protocol: 'a2a',
      url: `${agent.origin}/agents/travel?x=1`,
      headers: { 'X-Api-Key': 'k1' },
    });
    expect(found).toMatchObject({
      protocol: 'a2a',
      url: `${agent.origin}/.well-known/agent-card.json`,
      notes: [],
    });
    expect(found.protocol === 'a2a' && found.card.name).toBe('Travel agent');
    expect(agent.requests.map((r) => r.path)).toEqual([
      '/agents/travel/.well-known/agent-card.json?x=1',
      '/.well-known/agent-card.json?x=1',
    ]);
    expect(agent.requests.every((r) => r.method === 'GET')).toBe(true);
  });
  it('reads pre-1.0 cards without claiming compatibility', async () => {
    const legacy = {
      name: 'Old agent',
      protocolVersion: '0.3.0',
      url: 'https://old.test/a2a',
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [
        { url: 'https://old.test/a2a', transport: 'JSONRPC' },
        { url: 'https://old.test/rest', transport: 'HTTP+JSON' },
      ],
      skills: [{ id: 'quote', name: 'Quote' }],
    };
    const agent = await track(
      startRoutes({ '/.well-known/agent.json': { json: legacy } }),
    );
    const found = await discover({
      protocol: 'a2a',
      url: agent.origin,
      headers: {},
    });
    expect(found.notes.join()).toMatch(/predates A2A 1.0/);
    const review = importA2a(found.protocol === 'a2a' ? found.card : {});
    expect(
      review.system.interfaces.map((i) => [i.binding, i.endpoint]),
    ).toEqual([
      ['JSONRPC', 'https://old.test/a2a'],
      ['HTTP+JSON', 'https://old.test/rest'],
    ]);
    expect(review.metadataUnderstood).toBe(false);
    expect(review.gaps.join(' ')).toMatch(/Pre-1.0 Agent Card/);
  });
  it('refuses cross-origin redirects, non-cards and refusals', async () => {
    const elsewhere = await track(
      startRoutes({ '/card.json': { json: card('https://agent.test/a2a') } }),
    );
    const agent = await track(
      startRoutes({
        '/moved.json': {
          status: 302,
          location:
            elsewhere.origin.replace('127.0.0.1', 'localhost') + '/card.json',
        },
        '/near.json': { status: 301, location: '/real.json' },
        '/real.json': { json: card('https://agent.test/a2a') },
        '/html.json': { text: '<html></html>' },
        '/list.json': { json: [1, 2] },
        '/private.json': { status: 403 },
      }),
    );
    const at = (path: string) =>
      discover({
        protocol: 'a2a',
        url: agent.origin + path,
        headers: { Authorization: 'Bearer s3cret' },
      });
    expect((await failure(at('/moved.json'))).message).toMatch(
      /Plug does not forward headers to another origin/,
    );
    expect(elsewhere.requests).toHaveLength(0);
    expect(await at('/near.json')).toMatchObject({
      url: `${agent.origin}/real.json`,
    });
    expect((await failure(at('/html.json'))).message).toMatch(
      /did not return JSON/,
    );
    expect((await failure(at('/list.json'))).message).toMatch(
      /not an A2A Agent Card/,
    );
    expect((await failure(at('/private.json'))).message).toMatch(
      /refused the request \(HTTP 403\)/,
    );
    const missing = await failure(at('/'));
    expect(missing.status).toBe(404);
    expect(missing.message).toMatch(/No Agent Card at/);
  });
});
const openApiFixtureDoc = () => ({
  openapi: '3.1.0',
  info: { title: 'Inventory', version: '2.0.0' },
  servers: [{ url: 'https://inventory.example/api?x=1' }],
  paths: {
    '/availability/{sku}': {
      get: {
        operationId: 'check-availability',
        summary: 'Availability snapshot',
        parameters: [
          {
            name: 'sku',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { available: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
      post: { operationId: 'reserve', responses: {} },
    },
  },
});
describe('OpenAPI discovery', () => {
  it('reads one JSON document with the supplied header and drafts its operations', async () => {
    const api = await track(
      startRoutes({
        '/openapi.json': {
          json: openApiFixtureDoc(),
          require: ['authorization', 'Bearer k3y'],
        },
      }),
    );
    const found = await discover({
      protocol: 'http',
      url: api.url + '/openapi.json?token=secret',
      headers: { authorization: 'Bearer k3y' },
    });
    if (found.protocol !== 'http') throw new Error('Expected OpenAPI');
    expect(found.url).toBe(`${api.origin}/openapi.json`);
    expect(found.info).toEqual({ title: 'Inventory', version: '2.0.0' });
    expect(found.openapiVersion).toBe('3.1.0');
    // The server URL is resolved and kept without its query string.
    expect(found.serverUrl).toBe('https://inventory.example/api');
    expect(found.complete).toBe(true);
    const ops = found.operations as {
      id: string;
      metadata: { http: { method: string; path: string } };
    }[];
    expect(ops.map((o) => o.id)).toEqual(['check-availability', 'reserve']);
    expect(ops[0].metadata.http).toEqual({
      method: 'get',
      path: '/availability/{sku}',
    });
    expect(api.requests).toHaveLength(1);
  });
  it('reads YAML and defaults a missing server to the document origin', async () => {
    const api = await track(
      startRoutes({
        '/spec': {
          text: [
            'openapi: 3.0.3',
            'info: { title: Notes }',
            'paths:',
            '  /notes:',
            '    get:',
            '      responses: {}',
          ].join('\n'),
        },
      }),
    );
    const found = await discover({
      protocol: 'http',
      url: api.url + '/spec',
      headers: {},
    });
    if (found.protocol !== 'http') throw new Error('Expected OpenAPI');
    expect(found.serverUrl).toBe(`${api.origin}/`);
    expect(found.notes.join(' ')).toContain('names no server');
    expect(found.operations).toHaveLength(1);
  });
  it('explains documents that are not OpenAPI and failed requests', async () => {
    const api = await track(
      startRoutes({
        '/plain.json': { json: { hello: 'world' } },
        '/broken': { text: '{not: [yaml' },
        '/empty.json': { json: { openapi: '3.1.0', paths: {} } },
        '/private.json': { status: 401 },
      }),
    );
    const at = (path: string) =>
      discover({ protocol: 'http', url: api.origin + path, headers: {} });
    expect((await failure(at('/plain.json'))).message).toMatch(
      /not an OpenAPI document/,
    );
    expect((await failure(at('/broken'))).message).toMatch(/not JSON or YAML/);
    expect((await failure(at('/empty.json'))).message).toMatch(
      /lists no operations/,
    );
    expect((await failure(at('/private.json'))).message).toMatch(
      /refused the request \(HTTP 401\)/,
    );
  });
});
