import { describe, it, expect } from 'vitest';
import {
  assertContract,
  parseInput,
  validateInput,
  compileOperationSchema,
  migrateInput,
  normalizeSystems,
} from '../packages/plug/src/contracts/index';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import { importMcp, importA2a } from '../packages/plug/src/importers/index';
import { flightInput } from '../packages/plug/src/demo/flight';
const tool = {
  name: 'search',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
  },
  annotations: { readOnlyHint: true },
  execution: { taskSupport: 'optional' },
  futureMetadata: { example: 'kept' },
};
const wrapper = (response: unknown) => ({
  serverId: 'mcp-test',
  protocolVersion: '2025-11-25',
  response,
});
describe('contracts and metadata-only import', () => {
  it('validates canonical examples and rejects extra/invalid fields', () => {
    assertContract('DesignInput', flightInput());
    expect(() =>
      assertContract('DesignInput', { ...flightInput(), extra: true }),
    ).toThrow();
    const i = flightInput();
    i.connections[0].experience.targetPercentile = 2;
    expect(() => validateInput(i)).toThrow();
  });
  it('rejects executable, remote, alias, custom-tag, deep and oversized documents', () => {
    for (const text of [
      'a: &a [1]\nb: *a',
      'a: !evil value',
      '{"$ref":"https://evil.test/schema"}',
      '{"__proto__":{}}',
      'a: ' + '.'.repeat(262145),
      '[ '.repeat(18) + 'null' + ']'.repeat(18),
    ])
      expect(() => parseInput(text)).toThrow();
  });
  it('rejects inconsistent unknowns, identities and profile bindings', () => {
    const i = flightInput();
    i.connections[0].profile.latencyMs.evidence.kind = 'unknown';
    expect(() => validateInput(i)).toThrow();
    const j = flightInput();
    j.connections[0].profile.operationId = 'wrong';
    expect(() => validateInput(j)).toThrow();
    const k = flightInput();
    k.connections.push({ ...structuredClone(k.connections[0]), id: 'again' });
    expect(() => validateInput(k)).toThrow('distinct operation pair');
    const l = flightInput();
    l.connections[0].experience.priorities = ['cost', 'cost'];
    expect(() => validateInput(l)).toThrow('Priorities');
  });
  it('migrates 0.1-alpha.2 documents mechanically with equal candidate verdicts', () => {
    const native = flightInput();
    const { experience, ...connection } = structuredClone(
      native.connections[0],
    );
    const { profile, workload, remainingPath, id: _id, ...pair } = connection;
    delete experience.priorities;
    const legacy = {
      formatVersion: '0.1-alpha.2',
      systems: native.systems,
      connection: pair,
      profile,
      workload,
      experience,
      infrastructure: native.infrastructure,
      remainingPath,
      preference: 'cost',
    };
    const migrated = migrateInput(legacy) as typeof native;
    expect(migrated.connections[0].id).toBe('primary');
    expect(migrated.connections[0].experience.priorities).toEqual(
      native.connections[0].experience.priorities,
    );
    expect(validateInput(legacy)).toEqual(native);
    expect(suggestDesign(legacy).connections[0].candidates).toEqual(
      suggestDesign(native).connections[0].candidates,
    );
    expect(() => migrateInput({ ...legacy, unexpected: 1 })).toThrow();
  });
  it('accepts two to eight systems', () => {
    const s = flightInput().systems;
    expect(normalizeSystems(s)).toHaveLength(2);
    expect(() => normalizeSystems([s[0]])).toThrow();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...s[i % 2], id: `s${i}` }));
    expect(normalizeSystems(many(8))).toHaveLength(8);
    expect(() => normalizeSystems(many(9))).toThrow();
  });
  it('accepts n:n graphs up to eight systems and twelve connections', () => {
    const base = flightInput();
    const [caller, down] = base.systems;
    const systems = [
      caller,
      ...Array.from({ length: 7 }, (_, i) => ({ ...down, id: `down${i}` })),
    ];
    const connect = (from: string, to: string, i: number) => {
      const c = structuredClone(base.connections[0]);
      const callerOp = systems.find((s) => s.id === from)!.operations[0].id;
      return {
        ...c,
        id: `c${i}`,
        callerSystemId: from,
        callerOperationId: callerOp,
        downstreamSystemId: to,
        profile: { ...c.profile, systemId: to },
      };
    };
    const pairs: [string, string][] = [
      ...systems.slice(1).map((s) => [caller.id, s.id] as [string, string]),
      ['down0', 'down1'],
      ['down0', 'down2'],
      ['down1', 'down2'],
      ['down3', 'down0'],
      ['down4', 'down0'],
      ['down5', 'down6'],
    ];
    const graph = (n: number) => ({
      ...base,
      systems,
      connections: pairs.slice(0, n).map(([a, b], i) => connect(a, b, i)),
    });
    expect(validateInput(graph(12)).connections).toHaveLength(12);
    expect(suggestDesign(graph(12)).connections).toHaveLength(12);
    expect(() => validateInput(graph(13))).toThrow();
    expect(() =>
      validateInput({
        ...graph(1),
        systems: [...systems, { ...down, id: 'down7' }],
      }),
    ).toThrow();
  });
  it('accepts full JSON-RPC result or result object, preserving schema dialect and hints', () => {
    for (const response of [
      { tools: [tool] },
      { jsonrpc: '2.0', id: 1, result: { tools: [tool] } },
    ]) {
      const r = importMcp(wrapper(response));
      expect(r.metadataUnderstood).toBe(true);
      expect(r.system.operations[0].inputSchema?.$schema).toContain('2020-12');
      expect(r.system.operations[0].semantics.cachePermission).toBeNull();
      expect(r.system.operations[0].metadata?.futureMetadata).toEqual({
        example: 'kept',
      });
    }
  });
  it('requires identity/version and missing input schema is an error', () => {
    expect(() => importMcp({ response: { tools: [tool] } })).toThrow();
    expect(() => importMcp(wrapper({ tools: [{ name: 'broken' }] }))).toThrow();
  });
  it('marks incomplete pages and combines explicitly supplied pages', () => {
    expect(
      importMcp(wrapper({ tools: [tool], nextCursor: 'more' })).gaps.join(' '),
    ).toContain('INCOMPLETE');
    const r = importMcp({
      serverId: 'test',
      protocolVersion: '2025-11-25',
      pages: [
        { tools: [tool], nextCursor: 'more' },
        { tools: [{ ...tool, name: 'other' }] },
      ],
    });
    expect(r.system.operations).toHaveLength(2);
    expect(r.gaps.join(' ')).not.toContain('INCOMPLETE');
    expect(
      importMcp({ ...wrapper({ tools: [tool] }), protocolVersion: 'future' })
        .metadataUnderstood,
    ).toBe(false);
  });
  it('A2A 1.0 keeps interfaces, capabilities and skills without inventing schemas or calling ability', () => {
    const card = {
      name: 'Agent',
      supportedInterfaces: [
        {
          url: 'https://example.test/a2a',
          protocolVersion: '1.0',
          protocolBinding: 'JSONRPC',
        },
      ],
      capabilities: { streaming: true, pushNotifications: true },
      defaultInputModes: ['text/plain'],
      skills: [{ id: 'search', name: 'Search', description: 'Find flights' }],
    };
    const r = importA2a(card);
    expect(r.system.interfaces[0].direction).toBe('exposes');
    expect(r.system.operations[0].inputSchema).toBeNull();
    expect(r.system.metadata?.capabilities).toEqual(card.capabilities);
    expect(r.executableHere).toBe(false);
  });
  it('uses the declared JSON Schema dialect without fetching remote refs', () => {
    expect(
      compileOperationSchema({
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      })({ x: 1 }),
    ).toBe(true);
    expect(() =>
      compileOperationSchema({ $ref: 'https://example.test/schema' }),
    ).toThrow();
  });
});
