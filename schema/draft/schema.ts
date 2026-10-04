/** Plug alpha public serialized contracts. Replaces the earlier alpha draft. */
export type FormatVersion = '0.1-alpha.2';
/** Nonnegative, bounded finite measurement in the field's documented units.
 * @minimum 0
 * @maximum 1000000000000000
 */
export type Quantity = number;
/** A probability, never a percentage in the 0–100 range.
 * @minimum 0
 * @maximum 1
 */
export type Fraction = number;
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Each operational fact carries provenance; unknown values must be null. */
export interface Evidence {
  kind: 'declared' | 'observed' | 'synthetic' | 'unknown';
  note: string;
  measuredAt?: string;
  sampleSize?: Quantity;
  windowMs?: Quantity;
}
export interface Fact {
  value: Quantity | null;
  evidence: Evidence;
}
export interface RateFact {
  value: Fraction | null;
  evidence: Evidence;
}
export interface Interface {
  id: string;
  protocol: 'http' | 'mcp' | 'a2a';
  version: string;
  direction: 'exposes' | 'calls';
  binding: string;
  endpoint?: string;
}
export interface Semantics {
  effect: 'read' | 'write' | 'unknown';
  idempotent: boolean | null;
  outputMeaning: string | null;
  cachePermission: boolean | null;
  scope: 'public' | 'user' | 'tenant' | 'unknown';
  /** All output-changing dimensions, including identity where scoped. */
  keyDimensions: string[];
  keysComplete: boolean | null;
  requiresLiveValidation: boolean;
  evidence: Evidence;
}
export interface Operation {
  id: string;
  interfaceId: string;
  description: string;
  inputSchema: JsonObject | null;
  outputSchema: JsonObject | null;
  semantics: Semantics;
  metadata?: JsonObject;
}
export interface SystemDescription {
  id: string;
  name: string;
  role: string;
  interfaces: Interface[];
  /** Alpha accepts up to four selected operations per system. @maxItems 4 @minItems 1 */
  operations: Operation[];
  metadata?: JsonObject;
}
export interface SystemProfile {
  systemId: string;
  operationId: string;
  latencyMs: Fact;
  latencyPercentile: Fraction | null;
  /** Hard completion bound, not p95. */
  timeoutMs: Fact;
  callsPerMinute: Fact;
  concurrency: Fact;
  responseBytes: Fact;
  callCost: Fact;
  changeIntervalMs: Fact;
  sourceTimestamp:
    'requestStart' | 'responseSnapshot' | 'observationOnly' | 'unknown';
  sourceLagMs: Fact;
  invalidation: 'none' | 'unknown' | 'available';
}
export type ExactKey = { [dimension: string]: string | number | boolean };
export interface TraceRequest {
  atMs: Quantity;
  key: ExactKey;
}
export interface Workload {
  requestsPerMinute: Fact;
  hotKeyShare: RateFact;
  prewarmKeys: ExactKey[] | null;
  keyCount: Fact;
  /** Bounded ordered trace; replay starts cold at time zero. @maxItems 2000 */
  trace: TraceRequest[] | null;
  traceEvidence: Evidence;
  /** Count only requests at/after this time; warmup remains visible in the report. */
  measurementStartMs: Quantity;
  /** Matching observations bind to the exact policy fingerprint. */
  usableHitObservation?: { policyHash: string; hitRate: RateFact };
}
export interface Experience {
  usefulOutput: string;
  latencyTargetMs: Quantity;
  scope: 'warmHits' | 'trafficPercentile' | 'everyRequest';
  targetPercentile: Fraction;
  maxAgeMs: Quantity | null;
  correctness: 'indicative' | 'live';
  allowIndicative: boolean;
  allowDeferred: boolean;
  allowSlowMiss: boolean;
  finalDeadlineMs: Quantity | null;
  /** Independently justified complete-path probability for hits. */
  hitsWithinTarget: RateFact;
  /** Latency threshold to which the hit probability evidence applies. */
  hitsWithinTargetMs: Quantity;
  /** Optional complete-path evidence for direct calls at the specified threshold. */
  directWithinTarget?: { thresholdMs: Quantity; fraction: RateFact };
  /** Independently declared complete-path hard bound for everyRequest. */
  completePathBoundMs?: Fact;
  /** Optional independently available useful initial result. Acknowledgements do not qualify. */
  initialOutput: {
    meaning: string;
    latencyMs: Fact;
    useful: boolean;
    evidence: Evidence;
    withinTarget?: { thresholdMs: Quantity; fraction: RateFact };
  } | null;
}
export interface Infrastructure {
  cacheAllowed: boolean;
  schedulingAllowed: boolean;
  cacheCapacity: Quantity;
  memoryBytes: Quantity;
  refreshConcurrency: Quantity;
  schedulingAllowanceMs: Fact;
  foregroundReserveCallsPerMinute: Quantity;
  callBudgetPerMinute: Quantity | null;
}
export interface RemainingPath {
  agentMs: Fact;
  networkMs: Fact;
  mappingMs: Fact;
  renderingMs: Fact;
  cacheLookupMs: Fact;
  /** Bounded delivery allowance used in age eligibility, separate from point latency. */
  deliveryAllowanceMs: Fact;
}
export interface DesignInput {
  formatVersion: FormatVersion;
  /** Exactly two systems. */
  systems: [SystemDescription, SystemDescription];
  connection: {
    callerSystemId: string;
    callerOperationId: string;
    downstreamSystemId: string;
    downstreamOperationId: string;
    inputMapping: { from: string; to: string }[];
    outputMapping: { from: string; to: string }[];
    adapter: { supplied: boolean; overheadMs: Fact } | null;
  };
  profile: SystemProfile;
  workload: Workload;
  experience: Experience;
  infrastructure: Infrastructure;
  remainingPath: RemainingPath;
  preference: 'latency' | 'cost' | 'simplicity';
}
export type PatternId =
  | 'direct'
  | 'cache-aside'
  | 'scheduled-cache'
  | 'progressive'
  | 'scheduled-cache-aside'
  | 'cached-live';
export type CandidateStatus =
  | 'feasible_under_declared_assumptions'
  | 'conditional'
  | 'infeasible'
  | 'insufficient_information';
export interface Criterion {
  id: string;
  verdict: 'pass_under_assumptions' | 'fail' | 'unknown';
  reason: string;
  actual: number | string | null;
  required: number | string | null;
  evidence: Evidence[];
}
export interface RunnerConfig {
  formatVersion: FormatVersion;
  pattern: PatternId;
  scope: Semantics['scope'];
  keyDimensions: string[];
  maxAgeMs: Quantity | null;
  deliveryAllowanceMs: Quantity | null;
  capacity: Quantity;
  maxBytes: Quantity;
  refreshIntervalMs: Quantity | null;
  schedule: { key: ExactKey; offsetMs: Quantity }[];
  prewarmKeys: ExactKey[];
  concurrency: Quantity;
  refreshConcurrency: Quantity;
  callsPerMinute: Quantity | null;
  foregroundReserveCallsPerMinute: Quantity;
  timeoutMs: Quantity | null;
  sourceLagMs: Quantity | null;
  sourceTimestamp: SystemProfile['sourceTimestamp'];
  missPolicy: 'slow' | 'target-unmet';
  failurePolicy: 'serve-only-within-age';
  latencyTargetMs: Quantity;
  finalDeadlineMs: Quantity | null;
}
export interface Candidate {
  id: PatternId;
  title: string;
  status: CandidateStatus;
  criteria: Criterion[];
  components: string[];
  diagram: string;
  config: RunnerConfig;
  policyHash: string;
  estimates: {
    usefulLatencyMs: Quantity | null;
    liveLatencyMs: Quantity | null;
    ageEnvelopeMs: Quantity | null;
    callsPerMinute: Quantity | null;
    storageBytes: Quantity | null;
    usableHitRate: Fraction | null;
    trafficSuccessRate: Fraction | null;
    coldStartMs: Quantity | null;
    costPerMinute: Quantity | null;
  };
  metadataUnderstood: boolean;
  designEvaluated: boolean;
  executableHere: boolean;
  prerequisites: string[];
  assumptions: string[];
  tradeoffs: string[];
  tasks: string[];
}
export interface DesignRecommendation {
  formatVersion: FormatVersion;
  catalogVersion: string;
  catalogHash: string;
  inputHash: string;
  designHash: string;
  selectedId: PatternId | null;
  candidates: Candidate[];
  missingInformation: string[];
  costRankingAvailable: boolean;
}
export interface DemoEvent {
  formatVersion: FormatVersion;
  type:
    | 'session'
    | 'warmup'
    | 'request-start'
    | 'cache-hit'
    | 'cache-miss'
    | 'cache-expiry'
    | 'refresh-start'
    | 'refresh-success'
    | 'refresh-failure'
    | 'source-start'
    | 'fault-armed'
    | 'source-completion'
    | 'result-delivery'
    | 'target-miss'
    | 'sandbox-termination'
    | 'data-change';
  atMs: Quantity;
  actionId?: string;
  sessionId?: string;
  actionToken?: string;
  key?: ExactKey;
  durationMs?: Quantity;
  dataAgeMs?: Quantity;
  observedAt?: Quantity;
  sourceSnapshotAt?: Quantity;
  cost?: Quantity | null;
  data?: JsonObject;
  message: string;
}
/** Fixed trusted-local HTTP response envelope; data is checked against the selected output contract. */
export interface SourceResponse {
  snapshotAt: Quantity;
  version: Quantity;
  data: JsonObject;
}
