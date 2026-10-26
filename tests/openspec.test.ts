import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  exportWorkflowSpec,
  flightInput,
  importWorkflowDocument,
  importWorkflowSpec,
  suggestDesign,
  validateInput,
  workflowSpecYaml,
} from '../packages/plug/src/index';
const petstore = `
document:
  dsl: '1.0.3'
  namespace: default
  name: buy-pet
  version: '1.0.0'
do:
  - findPet:
      call: http
      with:
        method: get
        endpoint: https://petstore.swagger.io/v2/pet/{petId}
      timeout:
        after:
          seconds: 3
  - checkStock:
      if: \${ .available }
      call: mcp
      with:
        method: tools/call
        parameters:
          name: lookup_stock
        transport:
          http:
            endpoint: https://tools.example.com/mcp?token=secret
  - notify:
      set:
        done: true
  - askAgent:
      call: a2a
      with:
        method: message/send
        server: https://agent.example.net/a2a
`;
describe('Open Workflow Specification interchange', () => {
  it('exports deterministically with one call task per connection', () => {
    const input = flightInput();
    const a = workflowSpecYaml(input),
      b = workflowSpecYaml(structuredClone(input));
    expect(a).toBe(b);
    const doc = parse(a);
    expect(doc.document.dsl).toBe('1.0.3');
    expect(doc.document.name).toMatch(/^[a-z0-9](-*[a-z0-9]+)*$/);
    expect(doc.do).toHaveLength(input.connections.length);
    const task = doc.do[0][input.connections[0].id];
    expect(['http', 'mcp', 'a2a']).toContain(task.call);
    expect(task.metadata.plug.connectionId).toBe(input.connections[0].id);
    expect(task.metadata.plug.priorities).toEqual(
      input.connections[0].experience.priorities,
    );
    expect(a).not.toMatch(/^\s*[&*]\w/m);
  });
  it('exports the declared HTTP method and path and still round-trips', () => {
    const input = flightInput();
    const c = input.connections[0];
    const downstream = input.systems.find(
      (s) => s.id === c.downstreamSystemId,
    )!;
    const op = downstream.operations.find(
      (o) => o.id === c.downstreamOperationId,
    )!;
    const iface = downstream.interfaces.find((i) => i.id === op.interfaceId)!;
    iface.endpoint = 'https://flights.example/api/';
    op.metadata = { http: { method: 'get', path: '/search/{route}' } };
    const doc = exportWorkflowSpec(input) as Record<string, any>;
    const task = doc.do[0][c.id];
    expect(task.call).toBe('http');
    expect(task.with.method).toBe('get');
    expect(task.with.endpoint).toBe(
      'https://flights.example/api/search/{route}',
    );
    const back = importWorkflowSpec(workflowSpecYaml(input));
    expect(back.lossless).toBe(true);
    expect(
      back.input.systems
        .find((s) => s.id === c.downstreamSystemId)!
        .operations.find((o) => o.id === c.downstreamOperationId)!.metadata,
    ).toEqual({ http: { method: 'get', path: '/search/{route}' } });
  });
  it('round-trips losslessly through YAML and JSON', () => {
    const input = flightInput();
    const design = suggestDesign(input);
    const yaml = workflowSpecYaml(input, design);
    const fromYaml = importWorkflowSpec(yaml);
    expect(fromYaml.lossless).toBe(true);
    expect(fromYaml.gaps).toEqual([]);
    expect(fromYaml.input).toEqual(validateInput(input));
    expect(suggestDesign(fromYaml.input).designHash).toBe(design.designHash);
    const meta = parse(yaml).document.metadata.plug;
    expect(meta.design.designHash).toBe(design.designHash);
    expect(meta.design.selected[0].architectureId).toBe(
      design.connections[0].selectedArchitectureId,
    );
    const fromJson = importWorkflowSpec(
      JSON.stringify(exportWorkflowSpec(input)),
    );
    expect(fromJson.lossless).toBe(true);
    expect(fromJson.input).toEqual(fromYaml.input);
  });
  it('rejects a design computed for different connections', () => {
    const input = flightInput();
    const design = suggestDesign(input);
    expect(() =>
      exportWorkflowSpec(input, { ...design, connections: [] }),
    ).toThrow(/different connections/);
  });
  it('reconciles edited priorities, latency targets, removals and order', () => {
    const input = flightInput();
    const second = structuredClone(input.connections[0]);
    second.id = 'second';
    second.callerOperationId = input.systems[0].operations[0].id;
    input.systems[1].operations.push({
      ...structuredClone(input.systems[1].operations[0]),
      id: 'other',
    });
    second.downstreamOperationId = 'other';
    second.profile.operationId = 'other';
    input.connections.push(second);
    const doc = exportWorkflowSpec(input) as any;
    const first = doc.do[0][input.connections[0].id];
    first.metadata.plug.priorities = [
      'latency',
      'correctness',
      'availability',
      'simplicity',
      'cost',
    ];
    first.metadata.plug.latencyTargetMs = 1500;
    doc.do.reverse();
    const reordered = importWorkflowDocument(doc);
    expect(reordered.lossless).toBe(false);
    expect(reordered.input.connections.map((c) => c.id)).toEqual([
      'second',
      input.connections[0].id,
    ]);
    const edited = reordered.input.connections[1];
    expect(edited.experience.priorities?.[0]).toBe('latency');
    expect(edited.experience.latencyTargetMs).toBe(1500);
    expect(edited.profile).toEqual(input.connections[0].profile);
    expect(reordered.gaps.join('\n')).toMatch(/priority order/);
    doc.do = [doc.do[1]];
    const removed = importWorkflowDocument(doc);
    expect(removed.input.connections).toHaveLength(1);
    expect(removed.gaps.join('\n')).toMatch(/second: removed/);
  });
  it('drafts foreign workflows with unknown facts and no network', () => {
    const r = importWorkflowSpec(petstore);
    expect(r.lossless).toBe(false);
    const { systems, connections } = r.input;
    expect(systems.map((s) => s.id)).toEqual([
      'buy-pet',
      'petstore-swagger-io',
      'tools-example-com',
      'agent-example-net',
    ]);
    expect(connections.map((c) => c.id)).toEqual([
      'findpet',
      'checkstock',
      'askagent',
    ]);
    const [find, check] = connections;
    expect(find.profile.timeoutMs).toMatchObject({
      value: 3000,
      evidence: { kind: 'declared' },
    });
    expect(find.profile.latencyMs.value).toBeNull();
    expect(find.profile.latencyMs.evidence.kind).toBe('unknown');
    expect(systems[1].operations[0].semantics.effect).toBe('read');
    expect(systems[2].operations[0].id).toBe('lookup_stock');
    expect(check.profile.timeoutMs.value).toBeNull();
    expect(systems[2].interfaces[0].protocol).toBe('mcp');
    expect(systems[3].interfaces[0].protocol).toBe('a2a');
    const text = JSON.stringify(r.input);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/v2/pet');
    const gaps = r.gaps.join('\n');
    expect(gaps).toMatch(/notify: set task is not modeled/);
    expect(gaps).toMatch(/checkStock: its condition is not modeled/);
    expect(gaps).toMatch(/placeholder/);
    expect(gaps).toMatch(/Infrastructure is a placeholder/);
    expect(suggestDesign(r.input).connections).toHaveLength(3);
  });
  it('maps new tasks that reference existing operations by placeholder', () => {
    const input = flightInput();
    const doc = exportWorkflowSpec(input) as any;
    const [system, op] = [input.systems[1].id, 'extra'];
    doc.document.metadata.plug.input.systems[1].operations.push({
      ...structuredClone(input.systems[1].operations[0]),
      id: op,
    });
    doc.do.push({
      extraCall: {
        call: 'http',
        with: {
          method: 'post',
          endpoint: `plug://systems/${system}/operations/${op}`,
        },
      },
    });
    const r = importWorkflowDocument(doc);
    expect(r.input.systems).toHaveLength(2);
    expect(r.input.connections[1]).toMatchObject({
      callerSystemId: input.connections[0].callerSystemId,
      downstreamSystemId: system,
      downstreamOperationId: op,
    });
  });
  it('rejects malformed documents and imports large graphs without count ceilings', () => {
    expect(() => importWorkflowSpec('do: []')).toThrow(/document/);
    expect(() =>
      importWorkflowSpec(
        stringify({
          document: { dsl: '0.8', namespace: 'a', name: 'b', version: '1' },
          do: [],
        }),
      ),
    ).toThrow(/1\.x/);
    expect(() =>
      importWorkflowSpec(
        stringify({
          document: { dsl: '1.0.0', namespace: 'a', name: 'b', version: '1' },
          do: [{ a: { set: { x: 1 } } }],
        }),
      ),
    ).toThrow(/no HTTP/);
    expect(() => importWorkflowSpec('x: &a 1\ny: *a\n')).toThrow();
    const many = (n: number) =>
      stringify({
        document: { dsl: '1.0.3', namespace: 'a', name: 'b', version: '1.0.0' },
        do: Array.from({ length: n }, (_, i) => ({
          [`t${i}`]: {
            call: 'http',
            with: { method: 'get', endpoint: `https://h${i}.example.com/` },
          },
        })),
      });
    expect(importWorkflowSpec(many(7)).input.systems).toHaveLength(8);
    expect(importWorkflowSpec(many(20)).input.systems).toHaveLength(21);
    const crowded = stringify({
      document: { dsl: '1.0.3', namespace: 'a', name: 'b', version: '1.0.0' },
      do: Array.from({ length: 5 }, (_, i) => ({
        [`t${i}`]: {
          call: 'http',
          with: { method: 'get', endpoint: 'https://one.example.com/' },
        },
      })),
    });
    expect(
      importWorkflowSpec(crowded).input.systems.find(
        (s) => s.name === 'one.example.com',
      )?.operations,
    ).toHaveLength(5);
  });
});
