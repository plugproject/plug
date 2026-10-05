import type {
  ObligationDefinition,
  PatternDefinition,
  PatternTradeoffs,
  RelationPredicate,
} from '../contracts/index';
import { catalog } from './catalog';
export const knowledgeVersion = 'knowledge-1';
/** Problems a connection can exhibit; each is established by one relation predicate. */
export const problems: {
  id: string;
  fact: RelationPredicate;
  is: boolean;
  description: string;
}[] = [
  {
    id: 'protocol_mismatch',
    fact: 'protocolCompatible',
    is: false,
    description: 'The caller cannot natively call the exposed interface',
  },
  {
    id: 'contract_mismatch',
    fact: 'contractCompatible',
    is: false,
    description: 'Mappings do not cover the structured contracts',
  },
  {
    id: 'first_response_gap',
    fact: 'firstResponseGap',
    is: true,
    description: 'The live path exceeds the first-response budget',
  },
  {
    id: 'capacity_overload',
    fact: 'capacityMismatch',
    is: true,
    description: 'Request rate exceeds the downstream quota',
  },
  {
    id: 'burst_overload',
    fact: 'burstMismatch',
    is: true,
    description: 'Burst rate exceeds the downstream quota',
  },
  {
    id: 'availability_shortfall',
    fact: 'availabilityShortfall',
    is: true,
    description: 'Downstream availability is below the target',
  },
  {
    id: 'duplicate_effect',
    fact: 'duplicateEffectRisk',
    is: true,
    description: 'Redelivery can repeat a forbidden side effect',
  },
  {
    id: 'atomic_publish',
    fact: 'atomicPublishRequired',
    is: true,
    description: 'Local state and a lossless message must change together',
  },
  {
    id: 'ordering_gap',
    fact: 'orderingGap',
    is: true,
    description: 'The channel cannot preserve the required order',
  },
  {
    id: 'trust_boundary',
    fact: 'trustBoundaryCrossed',
    is: true,
    description: 'The connection crosses a trust boundary',
  },
];
export const obligations: ObligationDefinition[] = [
  {
    id: 'bounded_attempt',
    description: 'Every remote attempt needs a hard deadline',
    dischargedBy: [],
  },
  {
    id: 'correlation',
    description: 'Later or parallel results must be matched to their request',
    dischargedBy: [],
  },
  {
    id: 'duplicate_attempts',
    description: 'Repeated attempts must not repeat side effects',
    dischargedBy: [{ fact: 'unsafeRetry', is: false }],
  },
  {
    id: 'duplicate_effect',
    description: 'Redelivered messages must not repeat side effects',
    dischargedBy: [{ fact: 'sideEffecting', is: false }],
  },
  {
    id: 'terminal_failure',
    description: 'Unprocessable work needs an isolated failure store',
    dischargedBy: [],
  },
  {
    id: 'relay',
    description: 'Outbox entries need a relay to the channel',
    dischargedBy: [],
  },
  {
    id: 'overload_rejection',
    description:
      'Requests rejected above the limit miss the experience; accept or remove that loss explicitly',
    dischargedBy: [],
  },
];
const t = (
  consistencyWeakening: PatternTradeoffs['consistencyWeakening'],
  runtimeCoupling: PatternTradeoffs['runtimeCoupling'],
  operationalComplexity: PatternTradeoffs['operationalComplexity'],
  statefulness: PatternTradeoffs['statefulness'],
): PatternTradeoffs => ({
  consistencyWeakening,
  runtimeCoupling,
  operationalComplexity,
  statefulness,
});
const seedTradeoffs: Record<string, PatternTradeoffs> = {
  direct: t(0, 3, 0, 0),
  'cache-aside': t(2, 2, 1, 1),
  'scheduled-cache': t(2, 1, 2, 2),
  progressive: t(1, 2, 2, 0),
  'scheduled-cache-aside': t(2, 1, 3, 2),
  'cached-live': t(1, 2, 2, 1),
};
const seeds: PatternDefinition[] = catalog.map((entry) => ({
  id: entry.id,
  title: entry.title,
  family:
    entry.id === 'direct' || entry.id === 'progressive'
      ? 'interaction'
      : 'cache',
  scope: 'pairwise',
  template: entry.id,
  preconditions: [],
  contraindications: [],
  requiresOneOf: [],
  solves: [],
  introduces: [],
  conflicts: [],
  composesWith: [],
  components: entry.components,
  tradeoffs: seedTradeoffs[entry.id],
  evidenceNeeds: [
    'Detailed age, schedule, coverage, quota and complete-path criteria',
  ],
  tasks: [],
  executableHere: entry.id !== 'progressive',
}));
const addOn = (
  p: Partial<PatternDefinition> &
    Pick<PatternDefinition, 'id' | 'title' | 'family' | 'tradeoffs'>,
): PatternDefinition => ({
  scope: 'pairwise',
  template: null,
  preconditions: [],
  contraindications: [],
  requiresOneOf: [],
  solves: [],
  introduces: [],
  conflicts: [],
  composesWith: [],
  components: [p.title],
  evidenceNeeds: [],
  tasks: [],
  executableHere: false,
  ...p,
});
const tranche: PatternDefinition[] = [
  addOn({
    id: 'adapter',
    title: 'Protocol adapter',
    family: 'mediation',
    tradeoffs: t(0, null, 1, 0),
    preconditions: [{ fact: 'protocolCompatible', is: false }],
    solves: ['protocol_mismatch'],
    evidenceNeeds: ['Measured adapter overhead'],
    tasks: [
      'Build a mechanical protocol adapter and measure its overhead on the complete path.',
    ],
  }),
  addOn({
    id: 'translator',
    title: 'Message translator',
    family: 'mediation',
    tradeoffs: t(0, null, 1, 0),
    preconditions: [
      { fact: 'contractCompatible', is: false },
      { fact: 'trustBoundaryCrossed', is: false },
    ],
    solves: ['contract_mismatch'],
    tasks: [
      'Translate representations between the mapped contracts within one domain model.',
    ],
  }),
  addOn({
    id: 'anti-corruption-layer',
    title: 'Anti-corruption layer',
    family: 'mediation',
    tradeoffs: t(0, null, 2, 1),
    preconditions: [
      { fact: 'contractCompatible', is: false },
      { fact: 'trustBoundaryCrossed', is: true },
    ],
    solves: ['contract_mismatch'],
    tasks: [
      'Isolate the external domain model behind a translation layer owned by the caller.',
    ],
  }),
  addOn({
    id: 'async-request-reply',
    title: 'Asynchronous request-reply',
    family: 'interaction',
    tradeoffs: t(1, 1, 2, 1),
    preconditions: [{ fact: 'deferredAllowed', is: true }],
    requiresOneOf: [{ fact: 'laterResultPath', is: true }],
    solves: ['first_response_gap'],
    introduces: ['correlation', 'bounded_attempt'],
    composesWith: ['correlation-identifier', 'timeout'],
    tasks: [
      'Acknowledge immediately, then deliver the result through the declared callback, polling resource or stream. An acknowledgement is not useful output.',
      'Expire unclaimed results and propagate cancellation.',
    ],
  }),
  addOn({
    id: 'correlation-identifier',
    title: 'Correlation identifier',
    family: 'delivery',
    tradeoffs: t(0, null, 1, 0),
    solves: ['correlation'],
    tasks: ['Attach a correlation ID to each request and its later result.'],
  }),
  addOn({
    id: 'timeout',
    title: 'Timeout',
    family: 'resilience',
    tradeoffs: t(0, null, 0, 0),
    solves: ['bounded_attempt'],
    tasks: ['Abort each attempt at the declared hard bound.'],
  }),
  addOn({
    id: 'queue-load-leveling',
    title: 'Queue-based load leveling',
    family: 'flow-control',
    tradeoffs: t(1, 1, 2, 2),
    preconditions: [{ fact: 'deferredAllowed', is: true }],
    solves: ['capacity_overload', 'burst_overload'],
    introduces: ['correlation', 'terminal_failure'],
    composesWith: ['competing-consumers'],
    evidenceNeeds: ['Queue capacity and retention policy'],
    tasks: [
      'Buffer requests in a bounded queue drained at the downstream quota; set retention and overflow policy.',
    ],
  }),
  addOn({
    id: 'competing-consumers',
    title: 'Competing consumers',
    family: 'flow-control',
    tradeoffs: t(0, null, 1, 0),
    contraindications: [{ fact: 'globalOrderingRequired', is: true }],
    composesWith: ['queue-load-leveling'],
    tasks: [
      'Drain the queue with parallel workers within the concurrency limit.',
    ],
  }),
  addOn({
    id: 'rate-limiting',
    title: 'Rate limiting',
    family: 'flow-control',
    tradeoffs: t(0, null, 1, 1),
    solves: ['capacity_overload', 'burst_overload'],
    introduces: ['overload_rejection'],
    tasks: [
      'Reject or delay calls above the available quota with Retry-After.',
    ],
  }),
  addOn({
    id: 'retry-backoff',
    title: 'Retry with backoff and jitter',
    family: 'resilience',
    tradeoffs: t(0, null, 1, 0),
    contraindications: [{ fact: 'unsafeRetry', is: true }],
    solves: ['availability_shortfall'],
    introduces: ['bounded_attempt', 'duplicate_attempts'],
    conflicts: [],
    evidenceNeeds: ['Transient failure classes and recovery intervals'],
    tasks: [
      'Retry transient failures with capped exponential backoff and jitter inside the deadline budget.',
    ],
  }),
  addOn({
    id: 'circuit-breaker',
    title: 'Circuit breaker',
    family: 'resilience',
    tradeoffs: t(0, null, 2, 1),
    solves: ['availability_shortfall'],
    introduces: ['bounded_attempt'],
    composesWith: ['retry-backoff'],
    evidenceNeeds: ['Rolling failure and timeout rates'],
    tasks: [
      'Stop calls into a failing dependency, probe recovery, and return an explicit failure while open.',
    ],
  }),
  addOn({
    id: 'idempotent-consumer',
    title: 'Idempotent consumer',
    family: 'delivery',
    tradeoffs: t(0, null, 1, 1),
    solves: ['duplicate_effect', 'duplicate_attempts'],
    tasks: [
      'Deduplicate by idempotency key or message ID before applying effects.',
    ],
  }),
  addOn({
    id: 'dlq',
    title: 'Dead-letter channel',
    family: 'delivery',
    tradeoffs: t(0, null, 1, 1),
    solves: ['terminal_failure'],
    tasks: [
      'Move unprocessable messages to a dead-letter store for repair and replay.',
    ],
  }),
  addOn({
    id: 'transactional-outbox',
    title: 'Transactional outbox',
    family: 'consistency',
    tradeoffs: t(1, 1, 2, 2),
    solves: ['atomic_publish'],
    introduces: ['relay', 'duplicate_effect'],
    tasks: ['Write state and the outgoing message in one local transaction.'],
  }),
  addOn({
    id: 'outbox-relay',
    title: 'Outbox relay',
    family: 'consistency',
    tradeoffs: t(0, null, 1, 1),
    solves: ['relay'],
    tasks: ['Publish outbox entries by polling or change-data capture.'],
  }),
  addOn({
    id: 'sequential-convoy',
    title: 'Sequential convoy',
    family: 'delivery',
    tradeoffs: t(0, null, 2, 1),
    contraindications: [{ fact: 'globalOrderingRequired', is: true }],
    solves: ['ordering_gap'],
    tasks: ['Partition by ordering key and process each key in sequence.'],
  }),
  addOn({
    id: 'boundary-authentication',
    title: 'Boundary authentication',
    family: 'security',
    tradeoffs: t(0, null, 1, 0),
    solves: ['trust_boundary'],
    tasks: [
      'Authenticate both workloads at the boundary (mutual TLS or token exchange) and pass only scoped credentials.',
    ],
  }),
];
const global = (id: string, title: string): PatternDefinition =>
  addOn({
    id,
    title,
    family: 'global',
    scope: 'global',
    tradeoffs: t(0, null, 3, 1),
    evidenceNeeds: ['Context beyond one pair of systems'],
  });
const globalPatterns: PatternDefinition[] = [
  global('backend-for-frontend', 'Backend for frontend'),
  global('canonical-data-model', 'Canonical data model'),
  global('message-bus', 'Message bus'),
  global('deployment-stamps', 'Deployment stamps'),
  global('service-decomposition', 'Service decomposition'),
];
export const knowledge: PatternDefinition[] = [
  ...seeds,
  ...tranche,
  ...globalPatterns,
];
