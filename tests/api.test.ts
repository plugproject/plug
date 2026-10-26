import { afterEach, beforeEach, it, expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, errorHandler } from '../apps/playground/service';
import { flightInput, suggestDesign } from '../packages/plug/src/index';
let service: ReturnType<typeof createApp>, server: Server, base: string;
beforeEach(async () => {
  service = createApp({ fixtureLatencyMs: 20, lifetimeMs: 2000 });
  service.app.use(errorHandler);
  server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  service.cleanup();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const post = (
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Plug-Action-Token': token } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
async function session() {
  const abort = new AbortController();
  const r = await post(
    '/api/demo',
    {
      designHash: suggestDesign(flightInput()).designHash,
      pattern: 'scheduled-cache',
    },
    undefined,
    abort.signal,
  );
  expect(r.status).toBe(200);
  const reader = r.body!.getReader();
  const first = await reader.read();
  const event = JSON.parse(
    new TextDecoder().decode(first.value).split('\n')[0],
  );
  return { abort, reader, id: event.sessionId, token: event.actionToken };
}
it('health is cheap and hosted analysis never invokes descriptor endpoints', async () => {
  expect((await fetch(base + '/healthz')).status).toBe(200);
  const input = flightInput();
  input.systems[1].interfaces[0].endpoint = 'http://169.254.169.254/secret';
  const response = await post('/api/analyze', input);
  expect(response.status).toBe(200);
  expect(service.sessions.size).toBe(0);
  expect((await response.json()).report.connections[0].selectedId).toBe(
    'scheduled-cache',
  );
});
it('rejects stale/tampered execution and non-allowlisted request fields', async () => {
  expect(
    (await post('/api/demo', { designHash: 'bad', pattern: 'scheduled-cache' }))
      .status,
  ).toBe(409);
  expect(
    (
      await post('/api/demo', {
        designHash: 'bad',
        endpoint: 'https://evil.test',
      })
    ).status,
  ).toBe(400);
});
it('isolates tokens, bounds actions, and disconnect deletes sessions', async () => {
  const s = await session();
  const t = await session();
  expect(
    (await post(`/api/demo/${s.id}/actions`, { action: 'expire' }, t.token))
      .status,
  ).toBe(404);
  expect(
    (
      await post(
        `/api/demo/${s.id}/actions`,
        { action: 'fetch', url: 'http://evil.test' },
        s.token,
      )
    ).status,
  ).toBe(400);
  for (let i = 0; i < 20; i++)
    expect(
      (
        await post(
          `/api/demo/${s.id}/actions`,
          { action: 'change-data' },
          s.token,
        )
      ).status,
    ).toBe(202);
  expect(
    (await post(`/api/demo/${s.id}/actions`, { action: 'expire' }, s.token))
      .status,
  ).toBe(429);
  s.abort.abort();
  await new Promise((r) => setTimeout(r, 30));
  expect(service.sessions.has(s.id)).toBe(false);
  expect(service.sessions.has(t.id)).toBe(true);
  expect(
    (await post(`/api/demo/${s.id}/actions`, { action: 'expire' }, s.token))
      .status,
  ).toBe(404);
  t.abort.abort();
});
it('caps global sandboxes and rejects cross-origin requests', async () => {
  const all = [];
  for (let i = 0; i < 4; i++) all.push(await session());
  const r = await post('/api/demo', {
    designHash: suggestDesign(flightInput()).designHash,
    pattern: 'scheduled-cache',
  });
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBeTruthy();
  all.forEach((s) => s.abort.abort());
  expect(
    (
      await fetch(base + '/api/analyze', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.test',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});
it('rejects oversized, deep and remote-reference inputs', async () => {
  expect(
    (await post('/api/analyze', { payload: 'x'.repeat(270000) })).status,
  ).toBe(413);
  const input = flightInput();
  input.systems[1].operations[0].inputSchema = {
    $ref: 'http://evil.test/schema',
  };
  expect((await post('/api/analyze', input)).status).toBe(400);
});
it('never exposes workspace or local model endpoints on the hosted service', async () => {
  for (const path of ['/api/workspace', '/api/workspace/spec', '/api/probe'])
    expect((await fetch(base + path)).status).toBe(404);
  for (const path of [
    '/api/workspace/index',
    '/api/workspace/spec',
    '/api/discover',
    '/api/judge',
    '/api/draft',
    '/api/probe',
    '/api/verify',
    '/api/review',
    '/api/adopt',
  ])
    expect((await post(path, { input: flightInput() })).status).toBe(404);
});
