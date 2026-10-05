import { describe, expect, it } from 'vitest';
import { flightInput, validateInput } from '../packages/plug/src/index';
import {
  addConnection,
  addOperation,
  blankOperation,
  blankSystem,
  declared,
  draftGaps,
  freePartnersFor,
  moveBlocked,
  moveOperation,
  removeElement,
  setOperations,
} from '../apps/playground/src/workflow/model';
const agent = (operationId: string) => ({ systemId: 'agent', operationId });
const aggregator = { systemId: 'aggregator', operationId: 'search' };
const blank = { systemId: 'system', operationId: 'operation' };
/** The flight example plus a second agent operation that calls the aggregator, and a blank third system. */
function workflow() {
  const d = flightInput();
  addOperation(d, 'agent');
  d.systems.push(blankSystem('system'));
  addConnection(d, agent('operation'), aggregator, d.connections[0]);
  return d;
}
describe('workflow graph model', () => {
  it('lists every operation of another system that an operation can still call or serve', () => {
    const d = workflow();
    expect(freePartnersFor(d, 'agent', 'find-options')).toEqual({
      calls: [blank],
      serves: [aggregator, blank],
    });
    expect(freePartnersFor(d, 'aggregator', 'search')).toEqual({
      calls: [agent('find-options'), agent('operation'), blank],
      serves: [blank],
    });
  });
  it('explains why an operation cannot move', () => {
    const d = workflow();
    expect(moveBlocked(d, agent('operation'), 'agent')).toBe(
      'It already belongs to Flight-search agent.',
    );
    expect(moveBlocked(d, aggregator, 'system')).toBeNull();
    expect(moveBlocked(d, agent('operation'), 'aggregator')).toBe(
      'It is connected to Slow flight aggregator, and a connection joins two different systems.',
    );
    expect(moveBlocked(d, agent('operation'), 'system')).toBeNull();
    expect(moveBlocked(d, agent('operation'), null)).toBeNull();
    for (let i = 0; i < 3; i++) addOperation(d, 'system');
    expect(moveBlocked(d, agent('operation'), 'system')).toBe(
      'Four operations per system is the alpha limit.',
    );
    for (let i = d.systems.length; i < 8; i++)
      d.systems.push(blankSystem(`extra-${i}`));
    expect(moveBlocked(d, agent('operation'), null)).toBe(
      'Eight systems is the alpha limit.',
    );
    const unchanged = structuredClone(d);
    expect(() => moveOperation(d, agent('operation'), null)).toThrow(
      'Eight systems is the alpha limit.',
    );
    expect(d).toEqual(unchanged);
  });
  it('moves a caller operation into another system and clears its mappings', () => {
    const d = workflow();
    const calls = d.connections.find((c) => c.id === 'connection')!;
    calls.outputMapping = structuredClone(d.connections[0].outputMapping);
    const profile = structuredClone(calls.profile);
    expect(moveOperation(d, agent('operation'), 'system')).toEqual({
      systemId: 'system',
      operationId: 'operation-2',
    });
    expect(
      d.systems.find((s) => s.id === 'agent')!.operations.map((o) => o.id),
    ).toEqual(['find-options']);
    expect(
      d.systems
        .find((s) => s.id === 'system')!
        .operations.map((o) => [o.id, o.interfaceId]),
    ).toEqual([
      ['operation', 'http'],
      ['operation-2', 'http'],
    ]);
    expect([calls.callerSystemId, calls.callerOperationId]).toEqual([
      'system',
      'operation-2',
    ]);
    expect(calls.inputMapping).toEqual([]);
    expect(calls.outputMapping).toEqual([]);
    expect(calls.profile).toEqual(profile);
    expect(() => validateInput(d)).not.toThrow();
  });
  it('gives an operation a new system with its interface, and what it serves becomes unknown', () => {
    const d = workflow();
    d.systems[0].interfaces[0].endpoint = 'https://agent.example.com/search';
    addConnection(d, aggregator, agent('operation'), d.connections[0]);
    const served = d.connections.at(-1)!;
    served.profile.latencyMs = declared(120);
    expect(moveOperation(d, agent('operation'), null)).toEqual({
      systemId: 'system-2',
      operationId: 'operation',
    });
    const made = d.systems.at(-1)!;
    expect(made).toMatchObject({ id: 'system-2', role: 'caller' });
    expect(made.interfaces).toEqual([
      {
        id: 'http-client',
        protocol: 'http',
        version: '1.1',
        direction: 'calls',
        binding: 'HTTP+JSON',
      },
    ]);
    expect(made.operations.map((o) => o.interfaceId)).toEqual(['http-client']);
    expect(d.systems[0].interfaces[0].endpoint).toBe(
      'https://agent.example.com/search',
    );
    expect([
      served.downstreamSystemId,
      served.downstreamOperationId,
      served.profile.systemId,
      served.profile.operationId,
    ]).toEqual(['system-2', 'operation', 'system-2', 'operation']);
    expect(served.profile.latencyMs.value).toBeNull();
    expect(served.profile.latencyMs.evidence.kind).toBe('unknown');
    const calls = d.connections.find((c) => c.id === 'connection')!;
    expect([calls.callerSystemId, calls.callerOperationId]).toEqual([
      'system-2',
      'operation',
    ]);
    expect(() => validateInput(d)).not.toThrow();
  });
  it('moves a system’s last operation away and leaves the system as a draft gap', () => {
    const d = workflow();
    moveOperation(d, aggregator, 'system');
    const left = d.systems.find((s) => s.id === 'aggregator')!;
    expect(left.operations).toEqual([]);
    expect(draftGaps(d)).toEqual([
      'Give Slow flight aggregator an operation, or remove it.',
    ]);
  });
});
describe('removing anything from the workflow', () => {
  it('removes an operation with every connection it takes part in', () => {
    const d = workflow();
    expect(removeElement(d, { kind: 'operation', ...aggregator })).toEqual([
      'primary',
      'connection',
    ]);
    expect(d.connections).toEqual([]);
    expect(d.systems.find((s) => s.id === 'aggregator')!.operations).toEqual(
      [],
    );
    expect(draftGaps(d)).toEqual([
      'Give Slow flight aggregator an operation, or remove it.',
      'Connect an operation to an operation of another system.',
    ]);
  });
  it('removes a system with its operations and their connections, and a connection alone', () => {
    const d = workflow();
    expect(removeElement(d, { kind: 'connection', id: 'connection' })).toEqual([
      'connection',
    ]);
    expect(d.connections.map((c) => c.id)).toEqual(['primary']);
    expect(() => validateInput(d)).not.toThrow();
    expect(removeElement(d, { kind: 'system', systemId: 'agent' })).toEqual([
      'primary',
    ]);
    expect(d.systems.map((s) => s.id)).toEqual(['aggregator', 'system']);
    expect(draftGaps(d)).toEqual([
      'Connect an operation to an operation of another system.',
    ]);
    removeElement(d, { kind: 'system', systemId: 'system' });
    removeElement(d, { kind: 'system', systemId: 'aggregator' });
    expect(d.systems).toEqual([]);
    expect(draftGaps(d)).toEqual([
      'Add at least two systems.',
      'Connect an operation to an operation of another system.',
    ]);
  });
  it('connects again from nothing with a placeholder experience whose facts are unknown', () => {
    const d = workflow();
    removeElement(d, { kind: 'operation', ...aggregator });
    addOperation(d, 'aggregator');
    const id = addConnection(
      d,
      agent('find-options'),
      { systemId: 'aggregator', operationId: 'operation' },
      null,
    );
    const made = d.connections.find((c) => c.id === id)!;
    expect(made).toMatchObject({
      callerSystemId: 'agent',
      downstreamSystemId: 'aggregator',
      downstreamOperationId: 'operation',
      inputMapping: [],
      outputMapping: [],
    });
    expect(made.profile.latencyMs).toEqual(declared(null));
    expect(made.workload.requestsPerMinute).toEqual(declared(null));
    expect(made.experience.correctness).toBe('live');
    expect(made.experience.allowDeferred).toBe(false);
    expect(draftGaps(d)).toEqual([]);
    expect(() => validateInput(d)).not.toThrow();
  });
  it('replaces a system’s operations, removing the connections of those it drops', () => {
    const d = workflow();
    expect(() =>
      setOperations(
        d,
        'agent',
        Array.from({ length: 5 }, (_, i) =>
          blankOperation(`op-${i}`, 'http-client'),
        ),
      ),
    ).toThrow('Four operations per system is the alpha limit.');
    expect(() =>
      setOperations(d, 'agent', [
        blankOperation('same', 'http-client'),
        blankOperation('same', 'http-client'),
      ]),
    ).toThrow('Operation IDs within a system must differ.');
    const kept = d.systems[0].operations[0];
    expect(
      setOperations(d, 'agent', [kept, blankOperation('fresh', 'http-client')]),
    ).toEqual(['connection']);
    expect(d.systems[0].operations.map((o) => o.id)).toEqual([
      'find-options',
      'fresh',
    ]);
    expect(d.connections.map((c) => c.id)).toEqual(['primary']);
    expect(() => validateInput(d)).not.toThrow();
  });
});
