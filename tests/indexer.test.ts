import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexWorkspace } from '../packages/plug/src/indexer/index';
import { assertContract } from '../packages/plug/src/contracts/index';
let root: string, outside: string;
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};
const now = () => new Date('2026-10-04T00:00:00.000Z');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plug-index-'));
  outside = mkdtempSync(join(tmpdir(), 'plug-outside-'));
  write(
    'package.json',
    JSON.stringify({
      name: 'inventory-service',
      dependencies: { express: '^5', kafkajs: '^2', opossum: '^8' },
    }),
  );
  write(
    'openapi.yaml',
    `openapi: 3.1.0
info: { title: Inventory, version: '1' }
paths:
  /stock/{sku}:
    get:
      operationId: getStock
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties: { stock: { type: number } }
  /orders:
    post:
      operationId: createOrder
      parameters:
        - { in: header, name: Idempotency-Key, schema: { type: string } }
      responses:
        '201':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
`,
  );
  write(
    'src/server.ts',
    `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const upstream = 'https://api.example.com/v1/items?token=SECRET-TOKEN';
server.registerTool('lookup-item', {}, async () => ({}));
fetch(upstream, { signal: AbortSignal.timeout(2000), headers: { traceparent } });
`,
  );
  write('.env', 'API_KEY=SECRET-ENV');
  write('certs/server.pem', 'SECRET-PEM');
  write('node_modules/dep/index.js', "fetch('https://dependency.example')");
  write('dist/bundle.js', "fetch('https://dist.example')");
  write('tests/fixture.ts', "server.registerTool('fixture-tool', {})");
  write('src/server.test.ts', "fetch('https://test.example')");
  writeFileSync(join(outside, 'leak.ts'), "fetch('https://outside.example')");
  symlinkSync(outside, join(root, 'linked'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
describe('workspace indexer', () => {
  it('drafts a system from static structure and keeps operational facts unknown', async () => {
    const index = await indexWorkspace(root, { now });
    assertContract('WorkspaceIndex', index);
    expect(index.root).not.toContain('/');
    expect(index.system?.id).toBe('inventory-service');
    const ops = index.system!.operations;
    expect(ops.map((o) => o.id)).toEqual([
      'createorder',
      'getstock',
      'lookup-item',
    ]);
    const get = ops.find((o) => o.id === 'getstock')!;
    expect(get.semantics.effect).toBe('read');
    expect(get.semantics.cachePermission).toBeNull();
    expect(get.semantics.scope).toBe('unknown');
    expect(get.metadata).toEqual({
      http: { method: 'get', path: '/stock/{sku}' },
    });
    expect(get.semantics.evidence).toMatchObject({
      kind: 'static',
      source: { type: 'openapi', location: 'openapi.yaml' },
    });
    expect(get.outputSchema).toMatchObject({ type: 'object' });
    const post = ops.find((o) => o.id === 'createorder')!;
    expect(post.semantics.effect).toBe('unknown');
    expect(post.semantics.idempotencyKeySupported).toBe(true);
    expect(post.outputSchema).toBeNull();
    expect(index.system!.trustDomain).toBeNull();
    expect(index.system!.messaging?.delivery).toBe('unknown');
    const kinds = new Set(index.findings.map((f) => f.kind));
    for (const k of [
      'interface',
      'operation',
      'mcp',
      'broker',
      'resilience',
      'idempotency',
      'tracing',
    ])
      expect(kinds).toContain(k);
    for (const f of index.findings) expect(f.evidence.kind).toBe('static');
    expect(index.gaps).toContain(
      'getstock: latency distribution and hard timeout',
    );
    expect(index.gaps.join(' ')).toContain('$ref');
    expect(index.gaps.join(' ')).toContain('Delivery guarantee');
  });
  it('never reads secrets, dependencies, build output, tests or symbolic links and records hostnames only', async () => {
    const index = await indexWorkspace(root, { now });
    const text = JSON.stringify(index);
    for (const leak of [
      'SECRET',
      'token=',
      '/v1/items',
      'dependency.example',
      'dist.example',
      'outside.example',
      'fixture-tool',
      'test.example',
      root,
    ])
      expect(text).not.toContain(leak);
    expect(
      index.findings.some(
        (f) => f.name === 'api.example.com' && f.kind === 'interface',
      ),
    ).toBe(true);
    expect(index.filesScanned).toBe(3);
  });
  it('fingerprints content deterministically for freshness', async () => {
    const a = await indexWorkspace(root, { now }),
      b = await indexWorkspace(root, { now });
    expect(a).toEqual(b);
    write('src/server.ts', '// changed');
    expect((await indexWorkspace(root, { now })).fingerprint).not.toBe(
      a.fingerprint,
    );
  });
  it('enforces bounds and cancellation', async () => {
    const bounded = await indexWorkspace(root, { now, limits: { files: 1 } });
    expect(bounded.truncated).toBe(true);
    expect(bounded.filesScanned).toBe(1);
    expect(bounded.gaps.join(' ')).toContain('bound');
    const small = await indexWorkspace(root, {
      now,
      limits: { fileBytes: 10 },
    });
    expect(small.filesScanned).toBe(0);
    expect(small.system).toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(
      indexWorkspace(root, { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
  it('drafts A2A skills from an Agent Card without endpoint URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plug-a2a-'));
    try {
      writeFileSync(
        join(dir, 'agent-card.json'),
        JSON.stringify({
          name: 'Planner',
          supportedInterfaces: [
            {
              url: 'https://agent.example/a2a?key=SECRET',
              protocolVersion: '1.0',
              protocolBinding: 'JSONRPC',
            },
          ],
          skills: [{ id: 'plan-trip', name: 'Plan trip' }],
        }),
      );
      const index = await indexWorkspace(dir, { now });
      expect(index.system?.interfaces[0]).toMatchObject({ protocol: 'a2a' });
      expect(index.system?.operations[0].id).toBe('plan-trip');
      expect(JSON.stringify(index)).not.toContain('SECRET');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
