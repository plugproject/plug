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
import {
  importA2a,
  importDescription,
  importMcp,
  importOpenApi,
  openApiOperations,
} from '../packages/plug/src/importers/index';
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
  it('rejects executable, remote, alias, custom-tag and deep documents while keeping hosted size configurable', () => {
    for (const text of [
      'a: &a [1]\nb: *a',
      'a: !evil value',
      '{"$ref":"https://evil.test/schema"}',
      '{"__proto__":{}}',
      '[ '.repeat(18) + 'null' + ']'.repeat(18),
    ])
      expect(() => parseInput(text)).toThrow();
    const large = 'a: ' + '.'.repeat(300 * 1024);
    expect(parseInput(large)).toEqual({ a: '.'.repeat(300 * 1024) });
    expect(() => parseInput(large, 256 * 1024)).toThrow(/256 KB/);
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
  it('accepts any number of systems above the minimum', () => {
    const s = flightInput().systems;
    expect(normalizeSystems(s)).toHaveLength(2);
    expect(() => normalizeSystems([s[0]])).toThrow();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...s[i % 2], id: `s${i}` }));
    expect(normalizeSystems(many(50))).toHaveLength(50);
  });
  it('accepts n:n graphs without a system or connection count ceiling', () => {
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
    expect(validateInput(graph(13)).connections).toHaveLength(13);
    expect(
      validateInput({
        ...graph(1),
        systems: [...systems, { ...down, id: 'down7' }],
      }).systems,
    ).toHaveLength(9);
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
      expect(r.system.operations[0].binding).toMatchObject({
        request: {
          protocol: 'mcp',
          method: 'tools/call',
          pathTemplate: '',
          bodyTemplate: { name: 'search' },
          samples: [],
          samplesEvidence: {
            kind: 'static',
            source: { type: 'mcp', location: 'tools/list' },
          },
        },
        response: {
          dataPointer: null,
          snapshotPointer: null,
          snapshotHeader: null,
          timestampFormat: 'unknown',
        },
      });
      expect(
        r.system.operations[0].binding?.request.samplesEvidence.note,
      ).toContain('effect=read and idempotent=true');
      expect(r.system.operations[0].semantics.effect).toBe('unknown');
      expect(r.system.operations[0].semantics.idempotent).toBeNull();
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
    expect(
      importMcp(
        wrapper({
          tools: Array.from({ length: 6 }, (_, i) => ({
            ...tool,
            name: `tool-${i}`,
          })),
        }),
      ).system.operations,
    ).toHaveLength(6);
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
    expect(r.system.operations[0].binding).toBeUndefined();
    expect(r.system.metadata?.capabilities).toEqual(card.capabilities);
    expect(r.executableHere).toBe(false);
  });
  it('binds A2A text examples to message/send and imports every skill', () => {
    const card = {
      name: 'Agent',
      supportedInterfaces: [
        {
          url: 'https://example.test/a2a',
          protocolVersion: '1.0',
          protocolBinding: 'JSONRPC',
        },
      ],
      defaultInputModes: ['text/plain'],
      skills: Array.from({ length: 6 }, (_, i) => ({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Does ${i}`,
        examples: [`Run skill ${i}`],
      })),
    };
    const review = importA2a(card);
    expect(review.system.operations).toHaveLength(6);
    expect(review.system.operations[0].binding).toMatchObject({
      request: {
        protocol: 'a2a',
        method: 'message/send',
        pathTemplate: '',
        bodyTemplate: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: '{message}' }],
          },
        },
        samples: [{ message: 'Run skill 0' }],
        samplesEvidence: {
          kind: 'static',
          source: { type: 'a2a', location: 'agent-card#skills/skill-0' },
        },
      },
      response: {
        dataPointer: '',
        snapshotPointer: null,
        snapshotHeader: null,
        timestampFormat: 'unknown',
      },
    });
    expect(
      importA2a({
        ...card,
        supportedInterfaces: [
          { ...card.supportedInterfaces[0], protocolBinding: 'HTTP+JSON' },
        ],
      }).system.operations[0].binding,
    ).toBeUndefined();
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
const openApiDoc = () => ({
  openapi: '3.1.0',
  info: { title: 'Inventory', version: '2.0.0' },
  servers: [{ url: 'https://inventory.example/api' }],
  paths: {
    '/availability/{sku}': {
      get: {
        operationId: 'check-availability',
        summary: 'Availability snapshot by SKU',
        parameters: [
          {
            name: 'sku',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          { name: 'depth', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { available: { type: 'integer' } },
                  required: ['available'],
                },
              },
            },
          },
        },
      },
    },
    '/reservations': {
      post: {
        operationId: 'reserve-stock',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { sku: { type: 'string' } },
                required: ['sku'],
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { reservationId: { type: 'string' } },
                  required: ['reservationId'],
                },
              },
            },
          },
        },
      },
    },
  },
});
describe('OpenAPI metadata-only import', () => {
  it('drafts operations with method, path, schemas and idempotency support', () => {
    const review = importOpenApi(openApiDoc(), 'inventory');
    expect(review.executableHere).toBe(false);
    expect(review.metadataUnderstood).toBe(true);
    expect(review.system.name).toBe('Inventory');
    expect(review.system.interfaces[0]).toMatchObject({
      protocol: 'http',
      direction: 'exposes',
      endpoint: 'https://inventory.example/api',
    });
    const [get, post] = review.system.operations;
    expect(get.id).toBe('check-availability');
    expect(get.metadata).toEqual({
      http: { method: 'get', path: '/availability/{sku}' },
    });
    expect(get.semantics.effect).toBe('read');
    expect(get.binding).toMatchObject({
      request: {
        protocol: 'http',
        method: 'GET',
        pathTemplate: '/availability/{sku}',
        query: { depth: '{depth}' },
        headers: {},
        bodyTemplate: null,
        samples: [],
        samplesEvidence: {
          kind: 'static',
          source: { type: 'openapi', location: 'pasted-document' },
        },
      },
      response: {
        dataPointer: '',
        snapshotPointer: null,
        snapshotHeader: null,
        timestampFormat: 'unknown',
      },
    });
    // Query and path parameters become the input contract when there is no body.
    expect(get.inputSchema).toEqual({
      type: 'object',
      properties: { sku: { type: 'string' }, depth: { type: 'integer' } },
      required: ['sku'],
    });
    expect(post.id).toBe('reserve-stock');
    expect(post.semantics.idempotencyKeySupported).toBe(true);
    expect(post.inputSchema).toMatchObject({ required: ['sku'] });
    expect(review.gaps.join(' ')).toContain('Supply QoS');
  });
  it('derives schema-valid parameter samples without persisting credentials', () => {
    const secret = 'Bearer actual-secret';
    const review = importOpenApi({
      openapi: '3.1.0',
      info: { title: 'Bound service' },
      components: {
        securitySchemes: {
          ApiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Api-Key',
            'x-example-secret': secret,
          },
        },
      },
      security: [{ ApiKey: [] }],
      paths: {
        '/items/{itemId}': {
          get: {
            parameters: [
              {
                name: 'itemId',
                in: 'path',
                required: true,
                schema: { type: 'string', enum: ['item-1'] },
              },
              {
                name: 'page',
                in: 'query',
                schema: { type: 'integer', default: 2 },
              },
              {
                name: 'X-Region',
                in: 'header',
                example: 'eu-west-1',
                schema: { type: 'string' },
              },
              {
                name: 'Authorization',
                in: 'header',
                example: secret,
                schema: { type: 'string', default: secret },
              },
              {
                name: 'api_key',
                in: 'query',
                schema: { type: 'string', default: secret },
              },
            ],
            responses: {
              '200': {
                content: {
                  'application/json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    });
    const operation = review.system.operations[0];
    expect(operation.binding?.request).toMatchObject({
      protocol: 'http',
      method: 'GET',
      pathTemplate: '/items/{itemId}',
      query: { page: '{page}' },
      headers: {
        'X-Api-Key': '${env:X_API_KEY}',
        'X-Region': '{X-Region}',
        Authorization: '${env:AUTHORIZATION}',
      },
      bodyTemplate: null,
      samples: [{ itemId: 'item-1', page: 2, 'X-Region': 'eu-west-1' }],
      samplesEvidence: {
        kind: 'static',
        source: { type: 'openapi', location: 'pasted-document' },
      },
    });
    expect(JSON.stringify(review.system)).not.toContain(secret);
    expect(
      (operation.inputSchema?.properties as Record<string, any>).api_key
        .default,
    ).toBeUndefined();
    expect(operation.binding?.response).toEqual({
      dataPointer: '',
      snapshotPointer: null,
      snapshotHeader: null,
      timestampFormat: 'unknown',
    });
  });
  it('uses valid body examples, defaults and enums without inventing values', () => {
    const review = importOpenApi({
      openapi: '3.1.0',
      info: { title: 'Orders' },
      paths: {
        '/orders': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sku: { type: 'string', enum: ['SKU-1'] },
                      quantity: { type: 'integer', default: 1 },
                    },
                    required: ['sku', 'quantity'],
                    additionalProperties: false,
                  },
                  examples: {
                    invalid: { value: { sku: 42, quantity: 'many' } },
                  },
                },
              },
            },
            responses: { '204': { description: 'Accepted' } },
          },
        },
      },
    });
    expect(review.system.operations[0].binding?.request).toMatchObject({
      method: 'POST',
      bodyTemplate: { sku: '{sku}', quantity: '{quantity}' },
      samples: [{ sku: 'SKU-1', quantity: 1 }],
      samplesEvidence: { kind: 'static' },
    });
    expect(
      review.system.operations[0].binding?.response.dataPointer,
    ).toBeNull();
  });
  it('keeps unsupported versions without a compatibility claim and imports every operation', () => {
    const { openapi: _elided, ...rest } = openApiDoc();
    const review = importOpenApi({ ...rest, swagger: '2.0' }, 'legacy');
    expect(review.metadataUnderstood).toBe(false);
    expect(review.gaps.join(' ')).toContain('Unsupported OpenAPI version');
    const crowded = openApiDoc() as Record<string, any>;
    for (const n of [1, 2, 3])
      crowded.paths[`/extra-${n}`] = { get: { responses: {} } };
    expect(importOpenApi(crowded).system.operations).toHaveLength(5);
    expect(() => importOpenApi({ info: {} })).toThrow(/OpenAPI document/);
  });
  it('imports a pasted YAML document and resolves no relative server', () => {
    const review = importDescription(
      [
        'openapi: 3.0.3',
        'info: { title: Notes }',
        'servers: [{ url: /api }]',
        'paths:',
        '  /notes:',
        '    get:',
        '      responses: {}',
      ].join('\n'),
      'openapi',
    );
    expect(review.system.name).toBe('Notes');
    expect(review.system.interfaces[0].endpoint).toBeUndefined();
    expect(review.gaps.join(' ')).toContain('no absolute server URL');
    expect(review.system.operations[0].metadata).toEqual({
      http: { method: 'get', path: '/notes' },
    });
  });
  it('drafts operations deterministically in path order', () => {
    const ops = openApiOperations(openApiDoc(), 'fixture', 'http');
    expect(ops.map((o) => o.id)).toEqual([
      'check-availability',
      'reserve-stock',
    ]);
    expect(ops.every((o) => o.interfaceId === 'http')).toBe(true);
  });
});
