import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flightInput, fact } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import { knowledge } from '../packages/plug/src/patterns/knowledge';
const save = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};
const flight = flightInput();
save('examples/flight-search/input.json', flight);
save('schema/draft/examples/DesignInput/flight.json', flight);
save(
  'schema/draft/examples/SystemProfile/flight.json',
  flight.connections[0].profile,
);
save(
  'schema/draft/examples/DesignRecommendation/flight.json',
  suggestDesign(flight),
);
save('schema/draft/examples/DemoEvent/warmup.json', {
  formatVersion: '0.2-alpha.1',
  type: 'warmup',
  atMs: 1000,
  message: 'Empty cache; real HTTP prewarming begins.',
});
save(
  'schema/draft/examples/PatternDefinition/async-request-reply.json',
  knowledge.find((p) => p.id === 'async-request-reply'),
);
save('schema/draft/examples/WorkspaceIndex/minimal.json', {
  formatVersion: '0.2-alpha.1',
  indexerVersion: 'indexer-1',
  root: 'inventory-service',
  scannedAt: '2026-10-04T00:00:00.000Z',
  fingerprint: 'example',
  filesScanned: 2,
  truncated: false,
  findings: [
    {
      kind: 'interface',
      name: 'express',
      detail: 'HTTP server framework dependency',
      evidence: {
        kind: 'static',
        note: 'Declared dependency',
        source: { type: 'package-manifest', location: 'package.json' },
      },
    },
  ],
  system: {
    id: 'inventory-service',
    name: 'inventory-service',
    role: 'current project',
    interfaces: [
      {
        id: 'http-server',
        protocol: 'http',
        version: '1.1',
        direction: 'exposes',
        binding: 'HTTP+JSON',
      },
    ],
    operations: [
      {
        id: 'get-stock',
        interfaceId: 'http-server',
        description: 'GET /stock/{sku}',
        inputSchema: null,
        outputSchema: null,
        semantics: {
          effect: 'read',
          idempotent: null,
          outputMeaning: null,
          cachePermission: null,
          scope: 'unknown',
          keyDimensions: [],
          keysComplete: null,
          requiresLiveValidation: true,
          evidence: {
            kind: 'static',
            note: 'HTTP method semantics from the OpenAPI document; verify.',
            source: { type: 'openapi', location: 'openapi.yaml' },
          },
        },
      },
    ],
  },
  gaps: ['get-stock: latency distribution and hard timeout'],
});
const custom = flightInput();
const cc = custom.connections[0];
custom.systems[0].name = 'Inventory assistant';
custom.systems[1].name = 'Warehouse inventory API';
const inputSchema = {
  type: 'object',
  properties: { sku: { type: 'string' }, warehouse: { type: 'string' } },
  required: ['sku', 'warehouse'],
  additionalProperties: false,
};
const outputSchema = {
  type: 'object',
  properties: { stock: { type: 'number' }, warehouse: { type: 'string' } },
  required: ['stock', 'warehouse'],
  additionalProperties: false,
};
for (const s of custom.systems) {
  s.operations[0].inputSchema = inputSchema;
  s.operations[0].outputSchema = outputSchema;
  s.operations[0].semantics = {
    ...s.operations[0].semantics,
    keyDimensions: ['sku', 'warehouse'],
    outputMeaning: 'indicative stock count',
  };
  s.operations[0].description =
    'Read inventory snapshot for a SKU and warehouse';
}
cc.inputMapping = [
  { from: 'sku', to: 'sku' },
  { from: 'warehouse', to: 'warehouse' },
];
cc.outputMapping = [
  { from: 'stock', to: 'stock' },
  { from: 'warehouse', to: 'warehouse' },
];
cc.profile.latencyMs = fact(250);
cc.profile.timeoutMs = fact(1000);
cc.profile.callsPerMinute = fact(120);
cc.profile.changeIntervalMs = fact(60000);
cc.profile.responseBytes = fact(1024);
cc.experience.usefulOutput = 'indicative stock count';
cc.experience.latencyTargetMs = 100;
cc.experience.hitsWithinTargetMs = 100;
cc.experience.maxAgeMs = 15000;
custom.infrastructure.schedulingAllowanceMs = fact(100);
custom.infrastructure.foregroundReserveCallsPerMinute = 2;
for (const k of Object.keys(
  cc.remainingPath,
) as (keyof typeof cc.remainingPath)[])
  cc.remainingPath[k] = fact(k === 'deliveryAllowanceMs' ? 50 : 5);
const key = { sku: 'PLUG-1', warehouse: 'south' };
cc.workload.prewarmKeys = [key];
cc.workload.keyCount = fact(1);
cc.workload.burstPerMinute = fact(60);
cc.workload.hotKeyShare = {
  value: 1,
  evidence: cc.workload.traceEvidence,
};
cc.workload.trace = Array.from({ length: 100 }, (_, i) => ({
  atMs: 2000 + i * 2000,
  key,
}));
cc.workload.measurementStartMs = 2000;
cc.workload.requestsPerMinute = fact(30);
save('examples/your-http-api/input.json', custom);
