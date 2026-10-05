import type {
  Connection,
  DesignInput,
  Evidence,
  Fact,
  ExactKey,
  Semantics,
} from '../contracts/index';
export const synthetic: Evidence = {
  kind: 'synthetic',
  note: 'Bundled synthetic fixture assumption; validate with representative production traffic.',
  sampleSize: 500,
  windowMs: 600000,
  measuredAt: '2026-10-04',
};
export const fact = (value: number | null): Fact => ({
  value,
  evidence:
    value === null ? { kind: 'unknown', note: 'Not supplied' } : synthetic,
});
export const dimensions = [
  'origin',
  'destination',
  'departureDate',
  'returnDate',
  'adults',
  'children',
  'infants',
  'cabin',
  'currency',
  'locale',
  'fareContext',
];
export const keys: ExactKey[] = [
  {
    origin: 'DEL',
    destination: 'LHR',
    departureDate: '2026-12-15',
    returnDate: '2026-12-22',
    adults: 1,
    children: 0,
    infants: 0,
    cabin: 'economy',
    currency: 'INR',
    locale: 'en-IN',
    fareContext: 'public',
  },
  {
    origin: 'BOM',
    destination: 'SIN',
    departureDate: '2026-12-15',
    returnDate: '2026-12-22',
    adults: 1,
    children: 0,
    infants: 0,
    cabin: 'economy',
    currency: 'INR',
    locale: 'en-IN',
    fareContext: 'public',
  },
];
export const coldKey = { ...keys[0], destination: 'JFK' };
const semantics: Semantics = {
  effect: 'read',
  idempotent: true,
  outputMeaning: 'indicative flight options',
  cachePermission: true,
  scope: 'public',
  keyDimensions: dimensions,
  keysComplete: true,
  requiresLiveValidation: true,
  evidence: synthetic,
};
const inputSchema = {
  type: 'object',
  properties: Object.fromEntries(
    dimensions.map((d) => [
      d,
      {
        type: ['adults', 'children', 'infants'].includes(d)
          ? 'number'
          : 'string',
      },
    ]),
  ),
  required: dimensions,
  additionalProperties: false,
};
export const outputSchema = {
  type: 'object',
  properties: {
    offers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          price: { type: 'number' },
          currency: { type: 'string' },
        },
        required: ['id', 'price', 'currency'],
        additionalProperties: false,
      },
    },
  },
  required: ['offers'],
  additionalProperties: false,
};
function buildFlightInput(): DesignInput {
  return {
    formatVersion: '0.2-alpha.1',
    systems: [
      {
        id: 'agent',
        name: 'Flight-search agent',
        role: 'caller',
        trustDomain: 'plug-fixture',
        interfaces: [
          {
            id: 'http-client',
            protocol: 'http',
            version: '1.1',
            direction: 'calls',
            binding: 'HTTP+JSON',
          },
        ],
        operations: [
          {
            id: 'find-options',
            interfaceId: 'http-client',
            description: 'Find indicative flight options',
            inputSchema,
            outputSchema,
            semantics,
          },
        ],
      },
      {
        id: 'aggregator',
        name: 'Slow flight aggregator',
        role: 'downstream',
        trustDomain: 'plug-fixture',
        messaging: {
          delivery: 'none',
          ordering: 'none',
          durable: null,
          dlq: null,
        },
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
            id: 'search',
            interfaceId: 'http-server',
            description: 'Read a timestamped fare snapshot',
            inputSchema,
            outputSchema,
            semantics,
            interaction: {
              callback: false,
              polling: false,
              streaming: 'none',
              cancellation: true,
            },
          },
        ],
      },
    ],
    connections: [buildConnection()],
    infrastructure: {
      cacheAllowed: true,
      schedulingAllowed: true,
      cacheCapacity: 2,
      memoryBytes: 1048576,
      refreshConcurrency: 2,
      schedulingAllowanceMs: fact(5000),
      foregroundReserveCallsPerMinute: 2,
      callBudgetPerMinute: null,
    },
  };
}
function buildConnection(): Connection {
  return {
    id: 'primary',
    callerSystemId: 'agent',
    callerOperationId: 'find-options',
    downstreamSystemId: 'aggregator',
    downstreamOperationId: 'search',
    inputMapping: dimensions.map((d) => ({ from: d, to: d })),
    outputMapping: [{ from: 'offers', to: 'offers' }],
    adapter: null,
    profile: {
      systemId: 'aggregator',
      operationId: 'search',
      latencyMs: fact(15000),
      latencyPercentile: null,
      timeoutMs: fact(20000),
      callsPerMinute: fact(6),
      concurrency: fact(2),
      responseBytes: fact(4096),
      callCost: fact(null),
      changeIntervalMs: fact(300000),
      sourceTimestamp: 'requestStart',
      sourceLagMs: fact(0),
      invalidation: 'none',
    },
    workload: {
      requestsPerMinute: fact(50),
      burstPerMinute: fact(60),
      hotKeyShare: { value: 0.98, evidence: synthetic },
      prewarmKeys: keys,
      keyCount: fact(2),
      trace: Array.from({ length: 500 }, (_, i) => ({
        atMs: 25000 + i * 1200,
        key: i % 50 === 49 ? coldKey : keys[i % 2],
      })),
      traceEvidence: synthetic,
      measurementStartMs: 25000,
    },
    experience: {
      usefulOutput: 'indicative flight options',
      latencyTargetMs: 2000,
      scope: 'trafficPercentile',
      targetPercentile: 0.95,
      maxAgeMs: 90000,
      correctness: 'indicative',
      allowIndicative: true,
      allowDeferred: false,
      allowSlowMiss: true,
      finalDeadlineMs: 25000,
      hitsWithinTarget: { value: 0.99, evidence: synthetic },
      hitsWithinTargetMs: 2000,
      initialOutput: null,
      priorities: [
        'correctness',
        'cost',
        'latency',
        'availability',
        'simplicity',
      ],
    },
    remainingPath: {
      agentMs: fact(500),
      networkMs: fact(200),
      mappingMs: fact(0),
      renderingMs: fact(100),
      cacheLookupMs: fact(200),
      deliveryAllowanceMs: fact(1000),
    },
  };
}

export function flightInput(): DesignInput {
  return structuredClone(buildFlightInput());
}
