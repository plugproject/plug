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
    bodyLimitBytes: 512 * 1024,
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
      body: 'x'.repeat(600 * 1024),
    });
    expect(big.status).toBe(413);
  });
  it('judges equivalence with the configured stub and logs the verdict locally', async () => {
    const before = process.env.PLUG_JUDGE_PROVIDER;
    process.env.PLUG_JUDGE_PROVIDER = 'stub';
    try {
      const r = await fetch(`${server.url}/api/judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outputMeaning: 'indicative flight options',
          usefulOutput: 'the flight options, indicative',
        }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        question: 'output-equivalence',
        questionVersion: 1,
        model: 'stub',
        equivalent: true,
      });
      const log = readFileSync(
        join(workspace, '.plug', 'judgments.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n');
      expect(log).toHaveLength(1);
      expect(JSON.parse(log[0])).toMatchObject({
        model: 'stub',
        equivalent: true,
        usefulOutput: 'the flight options, indicative',
      });
      // Simple requests cannot carry JSON; a judge call needs the preflight.
      const wrongType = await fetch(`${server.url}/api/judge`, {
        method: 'POST',
        body: 'text',
      });
      expect(wrongType.status).toBe(415);
      const extra = await fetch(`${server.url}/api/judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputMeaning: 'a', usefulOutput: 'b', x: 1 }),
      });
      expect(extra.status).toBe(400);
    } finally {
      if (before === undefined) delete process.env.PLUG_JUDGE_PROVIDER;
      else process.env.PLUG_JUDGE_PROVIDER = before;
    }
  });
  it('fails closed with guidance when no judge is configured', async () => {
    const saved = {
      PLUG_JUDGE_PROVIDER: process.env.PLUG_JUDGE_PROVIDER,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      const r = await fetch(`${server.url}/api/judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputMeaning: 'a', usefulOutput: 'b' }),
      });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toContain('No judge is configured');
      expect(existsSync(join(workspace, '.plug', 'judgments.jsonl'))).toBe(
        false,
      );
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value !== undefined) process.env[key] = value;
    }
  });
  it('drafts quote-backed facts with the explicit stub and logs proposals', async () => {
    const saved = {
      PLUG_DRAFT_PROVIDER: process.env.PLUG_DRAFT_PROVIDER,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      PLUG_JUDGE_MODEL: process.env.PLUG_JUDGE_MODEL,
    };
    process.env.PLUG_DRAFT_PROVIDER = 'stub';
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.PLUG_JUDGE_MODEL;
    const body = {
      version: 1,
      target: {
        connectionId: 'search',
        callerSystemId: 'agent',
        callerOperationId: 'find',
        downstreamSystemId: 'aggregator',
        downstreamOperationId: 'search',
      },
      requested: ['output-meaning'],
      basis: {
        sources: [
          {
            id: 'downstream-operation-description',
            label: 'Downstream operation description',
            text: 'Returns indicative flight options.',
          },
        ],
        contracts: {
          callerInput: null,
          callerOutput: null,
          downstreamInput: null,
          downstreamOutput: null,
        },
      },
    };
    try {
      const response = await fetch(`${server.url}/api/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        version: 1,
        model: 'stub-drafter',
        proposals: [
          {
            kind: 'output-meaning',
            value: 'Returns indicative flight options.',
          },
        ],
      });
      const log = readFileSync(join(workspace, '.plug', 'drafts.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(log).toHaveLength(1);
      expect(JSON.parse(log[0])).toMatchObject({
        model: 'stub-drafter',
        requested: ['output-meaning'],
      });
      expect(
        (
          await fetch(`${server.url}/api/draft`, {
            method: 'POST',
            body: 'text',
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await fetch(`${server.url}/api/draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, extra: true }),
          })
        ).status,
      ).toBe(400);
    } finally {
      for (const key of Object.keys(saved)) delete process.env[key];
      for (const [key, value] of Object.entries(saved))
        if (value !== undefined) process.env[key] = value;
    }
  });
  it('fails closed with guidance when no fact drafter is configured', async () => {
    const saved = {
      PLUG_DRAFT_PROVIDER: process.env.PLUG_DRAFT_PROVIDER,
      PLUG_DRAFT_MODEL: process.env.PLUG_DRAFT_MODEL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      const response = await fetch(`${server.url}/api/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          target: {
            connectionId: 'search',
            callerSystemId: 'agent',
            callerOperationId: 'find',
            downstreamSystemId: 'aggregator',
            downstreamOperationId: 'search',
          },
          requested: ['output-meaning'],
          basis: {
            sources: [
              {
                id: 'downstream-operation-description',
                label: 'Downstream operation description',
                text: 'Returns flight options.',
              },
            ],
            contracts: {
              callerInput: null,
              callerOutput: null,
              downstreamInput: null,
              downstreamOutput: null,
            },
          },
        }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain(
        'No drafter is configured',
      );
      expect(existsSync(join(workspace, '.plug', 'drafts.jsonl'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value !== undefined) process.env[key] = value;
    }
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
      'revisions',
      'revisions.jsonl',
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
  it('pins reviews, adopts with evidence, and exposes revision restore reads', async () => {
    const before = process.env.PLUG_REVIEW_PROVIDER;
    process.env.PLUG_REVIEW_PROVIDER = 'stub';
    try {
      const input = flightInput();
      const written = await (
        await fetch(`${server.url}/api/workspace/spec`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
        })
      ).json();
      expect(written.revisionId).toMatch(/^[a-f0-9]{64}$/);
      const revisions = await fetch(
        `${server.url}/api/workspace/spec/revisions`,
      ).then((response) => response.json());
      expect(revisions.revisions[0].id).toBe(written.revisionId);
      const historical = await fetch(
        `${server.url}/api/workspace/spec?revision=${written.revisionId}`,
      ).then((response) => response.json());
      expect(historical.workflow).toContain('dsl: 1.0.3');

      const reviewedResponse = await fetch(`${server.url}/api/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          connectionId: 'primary',
          operationalContext: 'Use only the deterministic frontier.',
          specRevision: written.revisionId,
        }),
      });
      expect(reviewedResponse.status).toBe(200);
      const reviewed = await reviewedResponse.json();
      expect(reviewed.pinnedToRevision).toBe(true);
      expect(reviewed.decision.adoptable).toContain('scheduled-cache');

      const adoptedResponse = await fetch(`${server.url}/api/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          connectionId: 'primary',
          architectureId: 'scheduled-cache',
          patterns: ['scheduled-cache'],
          reviewHash: reviewed.reviewHash,
        }),
      });
      expect(adoptedResponse.status).toBe(200);
      const adopted = await adoptedResponse.json();
      expect(adopted.design.connections[0].adoption.status).toBe('honored');
      expect(
        adopted.input.connections[0].adoptedArchitecture.evidence.note,
      ).toContain('Adopted by the author');

      const authorizedOnly = await fetch(`${server.url}/api/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          systemId: 'aggregator',
          authorize: true,
          inspect: false,
        }),
      });
      expect(authorizedOnly.status).toBe(200);
      expect(await authorizedOnly.json()).toMatchObject({
        authorized: true,
        inspected: false,
      });
    } finally {
      if (before === undefined) delete process.env.PLUG_REVIEW_PROVIDER;
      else process.env.PLUG_REVIEW_PROVIDER = before;
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
