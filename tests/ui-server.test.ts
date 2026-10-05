import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { request } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiServer } from '../packages/plug/src/ui/server';
import { flightInput } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import { fixtureTools, startMcpFixture } from './fixtures/discovery-servers';
let workspace: string, ui: string;
let server: Awaited<ReturnType<typeof startUiServer>>;
beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'plug-ui-workspace-'));
  ui = mkdtempSync(join(tmpdir(), 'plug-ui-assets-'));
  writeFileSync(join(ui, 'index.html'), '<div id="root"></div>');
  mkdirSync(join(ui, 'assets'));
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(ui, '..', 'plug-ui-secret.txt'), 'SECRET');
  writeFileSync(
    join(workspace, 'openapi.json'),
    JSON.stringify({
      openapi: '3.1.0',
      paths: { '/items': { get: { operationId: 'listItems' } } },
    }),
  );
  server = await startUiServer({
    port: 0,
    workspaceDir: workspace,
    uiDir: ui,
    fixtureLatencyMs: 50,
  });
});
afterEach(async () => {
  await server.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(ui, { recursive: true, force: true });
  rmSync(join(ui, '..', 'plug-ui-secret.txt'), { force: true });
});
const raw = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => done({ status: res.statusCode!, body }));
      },
    );
    req.on('error', fail);
    req.end();
  });
describe('local workbench server', () => {
  it('binds loopback and rejects foreign hosts and origins', async () => {
    expect(server.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(
      (await raw('/api/examples', { Host: `evil.example:${server.port}` }))
        .status,
    ).toBe(403);
    const cross = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify(flightInput()),
    });
    expect(cross.status).toBe(403);
  });
  it('serves packaged assets without escaping the asset directory', async () => {
    const page = await fetch(server.url);
    expect(await page.text()).toContain('id="root"');
    expect(page.headers.get('content-security-policy')).toContain(
      "connect-src 'self'",
    );
    expect(
      (await fetch(`${server.url}/assets/app.js`)).headers.get('content-type'),
    ).toContain('javascript');
    const traversal = await raw('/%2e%2e/plug-ui-secret.txt');
    expect(traversal.body).not.toContain('SECRET');
    expect((await fetch(`${server.url}/nested/route`, {})).status).toBe(200);
  });
  it('analyzes native and migrated documents and bounds bodies', async () => {
    const native = flightInput();
    const analyze = (body: unknown) =>
      fetch(`${server.url}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const res = await analyze(native);
    const { report, markdown } = await res.json();
    expect(report.connections[0].selectedId).toBe('scheduled-cache');
    expect(markdown).toContain('```mermaid');
    const { experience, ...connection } = structuredClone(
      native.connections[0],
    );
    const { profile, workload, remainingPath, id: _id, ...pair } = connection;
    delete experience.priorities;
    const legacy = await analyze({
      formatVersion: '0.1-alpha.2',
      systems: native.systems,
      connection: pair,
      profile,
      workload,
      experience,
      infrastructure: native.infrastructure,
      remainingPath,
      preference: 'cost',
    });
    expect((await legacy.json()).report.designHash).toBe(
      suggestDesign(native).designHash,
    );
    const big = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(300 * 1024),
    });
    expect(big.status).toBe(413);
  });
  it('indexes the selected workspace and reports freshness', async () => {
    const before = await (await fetch(`${server.url}/api/workspace`)).json();
    expect(before).toMatchObject({ indexed: false, fresh: null, index: null });
    const indexed = await (
      await fetch(`${server.url}/api/workspace/index`, { method: 'POST' })
    ).json();
    expect(indexed.fresh).toBe(true);
    expect(indexed.index.system.operations[0].id).toBe('listitems');
    expect(existsSync(join(workspace, '.plug', 'workspace-index.json'))).toBe(
      true,
    );
    expect(
      (await (await fetch(`${server.url}/api/workspace`)).json()).fresh,
    ).toBe(true);
    writeFileSync(join(workspace, 'server.ts'), "import express from 'x';");
    expect(
      (await (await fetch(`${server.url}/api/workspace`)).json()).fresh,
    ).toBe(false);
  });
  it('writes the .plug spec bundle and reports edits to the workflow', async () => {
    const before = await (await fetch(`${server.url}/api/workspace`)).json();
    expect(before.spec).toMatchObject({ present: false, summary: null });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.url}/api/workspace/spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ input: flightInput() }, { Origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect((await post({ input: flightInput(), extra: 1 })).status).toBe(400);
    expect((await post({ input: { formatVersion: 'x' } })).status).toBe(400);
    const res = await post({ input: flightInput() });
    expect(res.status).toBe(200);
    const written = await res.json();
    expect(written.designHash).toBe(suggestDesign(flightInput()).designHash);
    expect(written.connections[0].selectedArchitectureId).toBe(
      'scheduled-cache',
    );
    const dir = join(workspace, '.plug');
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'AGENTS.md',
      'design-input.json',
      'design.json',
      'design.md',
      'workflow.yaml',
    ]);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(
      'plug_update_spec',
    );
    expect(readFileSync(join(dir, 'workflow.yaml'), 'utf8')).not.toContain(
      workspace,
    );
    const after = await (await fetch(`${server.url}/api/workspace`)).json();
    expect(after.spec).toMatchObject({
      present: true,
      consistent: true,
      workflowEdited: false,
    });
    const workflow = join(dir, 'workflow.yaml');
    const text = readFileSync(workflow, 'utf8'),
      at = text.lastIndexOf('latencyTargetMs: 2000');
    writeFileSync(
      workflow,
      text.slice(0, at) + 'latencyTargetMs: 1500' + text.slice(at + 21),
    );
    const edited = await (await fetch(`${server.url}/api/workspace`)).json();
    expect(edited.spec.workflowEdited).toBe(true);
    const current = await (
      await fetch(`${server.url}/api/workspace/spec`)
    ).json();
    expect(current).toMatchObject({ present: true, workflowEdited: true });
    expect(current.workflow).toContain('latencyTargetMs: 1500');
    const applied = await (
      await post({ workflow: readFileSync(workflow, 'utf8') })
    ).json();
    expect(applied.lossless).toBe(false);
    expect(applied.gaps.join()).toMatch(/1500 ms/);
    const settled = await (await fetch(`${server.url}/api/workspace`)).json();
    expect(settled.spec).toMatchObject({
      consistent: true,
      workflowEdited: false,
    });
  });
  it('lists a server for this origin only and keeps no headers', async () => {
    const mcp = await startMcpFixture({
      tools: fixtureTools(2),
      require: ['Authorization', 'Bearer s3cret'],
    });
    try {
      const post = (
        body: unknown,
        headers: Record<string, string> = {
          'Content-Type': 'application/json',
        },
      ) =>
        fetch(`${server.url}/api/discover`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      const target = { protocol: 'mcp', url: mcp.url };
      expect(
        (await post(target, { 'Content-Type': 'text/plain' })).status,
      ).toBe(415);
      expect(
        (
          await post(target, {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          })
        ).status,
      ).toBe(403);
      expect((await post({ ...target, protocol: 'grpc' })).status).toBe(400);
      expect(mcp.requests).toHaveLength(0);
      const refused = await post({ ...target, headers: {} });
      expect(refused.status).toBe(502);
      expect((await refused.json()).error).toMatch(/HTTP 401/);
      const ok = await post({
        ...target,
        headers: { Authorization: 'Bearer s3cret' },
      });
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(
        JSON.parse(text).tools.map((t: { name: string }) => t.name),
      ).toEqual(['tool_1', 'tool_2']);
      expect(text).not.toContain('s3cret');
      expect(existsSync(join(workspace, '.plug'))).toBe(false);
      expect(mcp.requests.some((r) => r.rpc === 'tools/call')).toBe(false);
    } finally {
      await mcp.close();
    }
  });
  it('allows one bundled sandbox with token-bound actions', async () => {
    const design = suggestDesign(flightInput());
    const controller = new AbortController();
    const start = () =>
      fetch(`${server.url}/api/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designHash: design.designHash,
          pattern: 'scheduled-cache',
        }),
        signal: controller.signal,
      });
    const stale = await fetch(`${server.url}/api/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ designHash: 'stale', pattern: 'scheduled-cache' }),
    });
    expect(stale.status).toBe(409);
    const first = await start();
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    const { value } = await reader.read();
    const session = JSON.parse(new TextDecoder().decode(value).split('\n')[0]);
    expect(session.type).toBe('session');
    expect((await start()).status).toBe(429);
    const action = (token: string) =>
      fetch(`${server.url}/api/demo/${session.sessionId}/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Plug-Action-Token': token,
        },
        body: JSON.stringify({ action: 'request', key: 'hot0' }),
      });
    expect((await action('0'.repeat(64))).status).toBe(404);
    expect((await action(session.actionToken)).status).toBe(202);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
