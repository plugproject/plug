import { writeFileSync } from 'node:fs';
import { flightInput, fact } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const flight = flightInput();
save('examples/flight-search/input.json', flight);
save('schema/draft/examples/DesignInput/flight.json', flight);
save('schema/draft/examples/SystemProfile/flight.json', flight.profile);
save(
  'schema/draft/examples/DesignRecommendation/flight.json',
  suggestDesign(flight),
);
save('schema/draft/examples/DemoEvent/warmup.json', {
  formatVersion: '0.1-alpha.2',
  type: 'warmup',
  atMs: 1000,
  message: 'Empty cache; real HTTP prewarming begins.',
});
const custom = flightInput();
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
custom.connection.inputMapping = [
  { from: 'sku', to: 'sku' },
  { from: 'warehouse', to: 'warehouse' },
];
custom.connection.outputMapping = [
  { from: 'stock', to: 'stock' },
  { from: 'warehouse', to: 'warehouse' },
];
custom.profile.latencyMs = fact(250);
custom.profile.timeoutMs = fact(1000);
custom.profile.callsPerMinute = fact(120);
custom.profile.changeIntervalMs = fact(60000);
custom.profile.responseBytes = fact(1024);
custom.experience.usefulOutput = 'indicative stock count';
custom.experience.latencyTargetMs = 100;
custom.experience.hitsWithinTargetMs = 100;
custom.experience.maxAgeMs = 15000;
custom.infrastructure.schedulingAllowanceMs = fact(100);
custom.infrastructure.foregroundReserveCallsPerMinute = 2;
for (const k of Object.keys(
  custom.remainingPath,
) as (keyof typeof custom.remainingPath)[])
  custom.remainingPath[k] = fact(k === 'deliveryAllowanceMs' ? 50 : 5);
const key = { sku: 'PLUG-1', warehouse: 'south' };
custom.workload.prewarmKeys = [key];
custom.workload.keyCount = fact(1);
custom.workload.hotKeyShare = {
  value: 1,
  evidence: custom.workload.traceEvidence,
};
custom.workload.trace = Array.from({ length: 100 }, (_, i) => ({
  atMs: 2000 + i * 2000,
  key,
}));
custom.workload.measurementStartMs = 2000;
custom.workload.requestsPerMinute = fact(30);
save('examples/your-http-api/input.json', custom);
