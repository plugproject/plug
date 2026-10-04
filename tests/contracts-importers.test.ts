import { describe, it, expect } from 'vitest';
import {
  assertContract,
  parseInput,
  validateInput,
  compileOperationSchema,
} from '../packages/plug/src/contracts/index';
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
    i.experience.targetPercentile = 2;
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
    i.profile.latencyMs.evidence.kind = 'unknown';
    expect(() => validateInput(i)).toThrow();
    const j = flightInput();
    j.profile.operationId = 'wrong';
    expect(() => validateInput(j)).toThrow();
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
