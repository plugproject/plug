/** Plug public serialized contracts. 0.2-alpha.1 replaces 0.1-alpha.2; migrate older documents with migrateInput. */
export type FormatVersion = '0.2-alpha.1';
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
/** Ordinal trade-off level: 0 none, 1 low, 2 medium, 3 high. */
export type Ordinal = 0 | 1 | 2 | 3;
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Each operational fact carries provenance; unknown values must be null. */
export interface Evidence {
  /** `static` facts are parsed from local code, configuration or contract files.
   * `probed` facts were measured by a bounded, author-authorized local probe;
   * they describe that workbench vantage and are never production verification.
   * `judged` facts are model judgments pinned to their exact inputs; they
   * qualify a verdict and are never production verification. */
  kind:
    | 'declared'
    | 'observed'
    | 'synthetic'
    | 'static'
    | 'probed'
    | 'unknown'
    | 'judged';
  note: string;
  measuredAt?: string;
  sampleSize?: Quantity;
  windowMs?: Quantity;
  /** Where the fact came from, e.g. a workspace-relative file path. */
  source?: { type: string; location: string };
  confidence?: Fraction;
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
  /** Completed effects have a domain inverse or compensation. */
  reversible?: boolean | null;
  /** The operation accepts a caller-supplied idempotency key. */
  idempotencyKeySupported?: boolean | null;
  evidence: Evidence;
}
/** How a later result can reach the caller. */
export interface Interaction {
  callback: boolean | null;
  polling: boolean | null;
  streaming: 'none' | 'server' | 'bidi' | 'unknown';
  cancellation: boolean | null;
}
/** A bounded request recipe. Header values may reference `${env:NAME}` and
 * those environment values are resolved only at execution time. */
export interface RequestBinding {
  protocol: Interface['protocol'];
  method: string;
  pathTemplate: string;
  query: { [key: string]: string };
  headers: { [key: string]: string };
  bodyTemplate: JsonValue | null;
  samples: JsonObject[];
  samplesEvidence: Evidence;
}
/** How a response is projected into the data and source-time used by a runner.
 * JSON pointers are RFC 6901 pointers; null leaves that field unavailable. */
export interface ResponseBinding {
  dataPointer: string | null;
  snapshotPointer: string | null;
  snapshotHeader: string | null;
  timestampFormat:
    'iso-8601' | 'epoch-milliseconds' | 'epoch-seconds' | 'unknown';
}
export interface Operation {
  id: string;
  interfaceId: string;
  description: string;
  inputSchema: JsonObject | null;
  outputSchema: JsonObject | null;
  semantics: Semantics;
  interaction?: Interaction;
  binding?: { request: RequestBinding; response: ResponseBinding };
  metadata?: JsonObject;
}
/** Delivery behavior of the channel through which this system is reached. `none` means synchronous request-reply. */
export interface Messaging {
  delivery:
    | 'at-most-once'
    | 'at-least-once'
    | 'exactly-once-claimed'
    | 'none'
    | 'unknown';
  ordering: 'none' | 'key' | 'global' | 'unknown';
  durable: boolean | null;
  dlq: boolean | null;
}
export interface SystemDescription {
  id: string;
  name: string;
  role: string;
  interfaces: Interface[];
  /** Operations this system exposes or calls. @minItems 1 */
  operations: Operation[];
  /** Identity/trust domain; differing domains cross a trust boundary. */
  trustDomain?: string | null;
  messaging?: Messaging;
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
  /** Fraction of calls that succeed within the timeout. */
  availability?: RateFact;
}
export type ExactKey = { [dimension: string]: string | number | boolean };
export interface TraceRequest {
  atMs: Quantity;
  key: ExactKey;
}
export interface Workload {
  requestsPerMinute: Fact;
  /** Peak request rate within any one minute. */
  burstPerMinute?: Fact;
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
export type Priority =
  'correctness' | 'latency' | 'availability' | 'simplicity' | 'cost';
/** Required experience and interaction goal. Absent optional requirements mean none was declared. */
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
  /** Distinct lexicographic ranking order applied after hard constraints. @maxItems 5 */
  priorities?: Priority[];
  /** Budget for a first acknowledgement; an acknowledgement is not useful output. */
  firstAckMs?: Quantity | null;
  /** Longest acceptable period without any feedback. */
  silenceBudgetMs?: Quantity | null;
  availabilityTarget?: RateFact;
  duplicateEffectForbidden?: boolean | null;
  lostRequestAllowed?: boolean | null;
  orderingRequired?: 'none' | 'perKey' | 'global' | 'unknown';
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
export interface FieldMapping {
  from: string;
  to: string;
}
/** A recorded judgment that the declared output meaning satisfies the required
 * useful output. It binds to the exact judged strings: when either changes,
 * the judgment is void and the strict comparison applies again. */
export interface SemanticEquivalence {
  equivalent: boolean | null;
  outputMeaning: string;
  usefulOutput: string;
  evidence: Evidence;
}
/** An architecture choice explicitly adopted by the author. The engine
 * re-verifies the pattern set against every new input and catalog version. */
export interface AdoptedArchitecture {
  architectureId: string;
  patterns: string[];
  catalogVersion: string;
  evidence: Evidence;
}
/** One caller-to-downstream connection with its own facts and goal. */
export interface Connection {
  id: string;
  callerSystemId: string;
  callerOperationId: string;
  downstreamSystemId: string;
  downstreamOperationId: string;
  inputMapping: FieldMapping[];
  outputMapping: FieldMapping[];
  adapter: { supplied: boolean; overheadMs: Fact } | null;
  profile: SystemProfile;
  workload: Workload;
  experience: Experience;
  remainingPath: RemainingPath;
  semanticEquivalence?: SemanticEquivalence | null;
  adoptedArchitecture?: AdoptedArchitecture | null;
}
export interface DesignInput {
  formatVersion: FormatVersion;
  /** At least two systems. @minItems 2 */
  systems: SystemDescription[];
  /** Connections may share systems and operations. @minItems 1 */
  connections: Connection[];
  /** Shared by every connection. */
  infrastructure: Infrastructure;
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
/** Names of the derived pairwise predicates. */
export type RelationPredicate =
  | 'protocolCompatible'
  | 'contractCompatible'
  | 'semanticMatch'
  | 'deadlineRisk'
  | 'firstResponseGap'
  | 'capacityMismatch'
  | 'burstMismatch'
  | 'availabilityShortfall'
  | 'sideEffecting'
  | 'unsafeRetry'
  | 'duplicateDeliveryPossible'
  | 'duplicateEffectRisk'
  | 'atomicPublishRequired'
  | 'orderingGap'
  | 'globalOrderingRequired'
  | 'laterResultPath'
  | 'deferredAllowed'
  | 'trustBoundaryCrossed';
/** Three-valued predicate: null means unknown, never false. */
export interface RelationFact {
  value: boolean | null;
  reason: string;
  evidence: Evidence[];
}
export type RelationFacts = { [P in RelationPredicate]: RelationFact };
export interface Condition {
  fact: RelationPredicate;
  is: boolean;
}
export type PatternFamily =
  | 'interaction'
  | 'cache'
  | 'mediation'
  | 'resilience'
  | 'flow-control'
  | 'delivery'
  | 'consistency'
  | 'security'
  | 'global';
export interface PatternTradeoffs {
  consistencyWeakening: Ordinal;
  /** Remaining runtime coupling to the downstream; null leaves coupling unchanged. */
  runtimeCoupling: Ordinal | null;
  operationalComplexity: Ordinal;
  statefulness: Ordinal;
}
/** A pattern as versioned, machine-readable knowledge. */
export interface PatternDefinition {
  id: string;
  title: string;
  family: PatternFamily;
  scope: 'pairwise' | 'global';
  /** Seed designs carry their detailed evaluator template. */
  template: PatternId | null;
  /** All must hold. */
  preconditions: Condition[];
  /** Any holding contraindicates the pattern. */
  contraindications: Condition[];
  /** At least one must hold when nonempty. */
  requiresOneOf: Condition[];
  solves: string[];
  introduces: string[];
  conflicts: string[];
  composesWith: string[];
  components: string[];
  tradeoffs: PatternTradeoffs;
  evidenceNeeds: string[];
  tasks: string[];
  executableHere: boolean;
}
/** An obligation a pattern introduces; any holding condition discharges it. */
export interface ObligationDefinition {
  id: string;
  description: string;
  dischargedBy: Condition[];
}
export type Applicability =
  | 'required'
  | 'supported'
  | 'optional'
  | 'contraindicated'
  | 'not_applicable'
  | 'unknown'
  | 'needs_global_context';
export interface PatternEvaluation {
  id: string;
  applicability: Applicability;
  reason: string;
  facts: RelationPredicate[];
}
export interface TradeoffVector {
  usefulLatencyMs: Quantity | null;
  trafficSuccessRate: Fraction | null;
  costPerMinute: Quantity | null;
  consistencyWeakening: Quantity;
  runtimeCoupling: Quantity;
  operationalComplexity: Quantity;
  statefulness: Quantity;
  componentCount: Quantity;
}
export interface ObligationStatus {
  id: string;
  coveredBy: string | null;
  dischargedBy: RelationPredicate | null;
}
export interface ArchitectureProof {
  because: string[];
  rejectedAlternatives: { id: string; reason: string }[];
  unknowns: string[];
}
/** A closed pattern stack built on one seed base design. */
export interface ArchitectureCandidate {
  id: string;
  base: PatternId;
  patterns: string[];
  status: CandidateStatus;
  frontier: boolean;
  dominatedBy: string | null;
  problems: { id: string; solvedBy: string | null }[];
  obligations: ObligationStatus[];
  tradeoffs: TradeoffVector;
  proof: ArchitectureProof;
  components: string[];
  diagram: string;
  tasks: string[];
  executableHere: boolean;
  /** `planned` comes from bounded composition; `adopted` was checked on demand. */
  origin?: 'planned' | 'adopted';
}
export interface ConnectionReport {
  connectionId: string;
  selectedId: PatternId | null;
  candidates: Candidate[];
  relation: RelationFacts;
  patterns: PatternEvaluation[];
  architectures: ArchitectureCandidate[];
  selectedArchitectureId: string | null;
  /** Author-adopted design when it remains valid under this exact analysis. */
  adoptedArchitectureId?: string | null;
  adoption?: {
    status:
      | 'honored'
      | 'dominated'
      | 'not_feasible'
      | 'unknown_architecture'
      | 'catalog_changed';
    reason: string;
  };
  /** Two or more feasible frontier architectures tie on every declared priority. */
  policyDecisionNeeded: boolean;
  priorities: Priority[];
  missingInformation: string[];
  costRankingAvailable: boolean;
}
export interface DesignRecommendation {
  formatVersion: FormatVersion;
  catalogVersion: string;
  catalogHash: string;
  inputHash: string;
  designHash: string;
  connections: ConnectionReport[];
  crossConnection: Criterion[];
  missingInformation: string[];
}
/** Plug data under `document.metadata.plug` of an exported Open Workflow Specification document. */
export interface WorkflowSpecMetadata {
  formatVersion: FormatVersion;
  /** Canonical input; importers re-validate it and reconcile it with the task list. */
  input: DesignInput;
  /** The analysis exported with the workflow, only when it was computed for this exact input. */
  design: {
    inputHash: string;
    designHash: string;
    catalogVersion: string;
    selected: {
      connectionId: string;
      patternId: PatternId | null;
      architectureId: string | null;
      adoptedArchitectureId?: string | null;
    }[];
  } | null;
}
/** Plug data under `metadata.plug` of each exported call task. */
export interface WorkflowTaskMetadata {
  connectionId: string;
  callerSystemId: string;
  callerOperationId: string;
  downstreamSystemId: string;
  downstreamOperationId: string;
  /** @maxItems 5 */
  priorities: Priority[];
  latencyTargetMs: Quantity;
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
/** A host the author added to the local workbench. The value is an origin
 * (`scheme://host[:port]`), never a URL containing credentials or a path. */
export interface AuthorizedHost {
  host: string;
  addedAt: string;
  addedVia: 'ui' | 'mcp' | 'cli';
}
/** One append-only event from a bounded local integration probe. */
export interface ProbeEvent {
  formatVersion: FormatVersion;
  systemId: string;
  operationId: string;
  at: string;
  type:
    'plan' | 'request-start' | 'response' | 'rate-limit' | 'error' | 'complete';
  attempt?: Quantity;
  durationMs?: Quantity;
  status?: Quantity;
  bytes?: Quantity;
  headers?: { [key: string]: string };
  sample?: JsonValue;
  message: string;
}
/** Bounded measurements for one operation from one local-workbench vantage. */
export interface OperationManifest {
  formatVersion: FormatVersion;
  manifestHash: string;
  systemId: string;
  operationId: string;
  endpoint: string;
  measuredAt: string;
  windowMs: Quantity;
  sampleSize: Quantity;
  vantage: {
    kind: 'local-workbench';
    nodeVersion: string;
  };
  latencyMs: {
    p50: Quantity | null;
    p90: Quantity | null;
    p95: Quantity | null;
    max: Quantity | null;
  };
  availability: Fraction | null;
  responseBytes: Quantity | null;
  statusHistogram: { [status: string]: Quantity };
  rateLimitHeaders: { [key: string]: string };
  cacheHeaders: { [key: string]: string };
  timestampCandidates: string[];
  sourceTimestamp: {
    pointer: string;
    format: ResponseBinding['timestampFormat'];
    probability: Fraction;
    model: string;
  } | null;
  usefulOutput: { probability: Fraction; model: string } | null;
  changeIntervalMs: Quantity | null;
  stoppedByRateLimit: boolean;
}
/** A bounded workbench demonstration pinned to an exact spec and design. */
export interface VerificationRecord {
  formatVersion: FormatVersion;
  connectionId: string;
  mode: 'as-is' | 'design';
  verdict: 'demonstrated' | 'not_demonstrated' | 'inconclusive';
  inputHash: string;
  designHash: string;
  revisionId: string | null;
  architectureId: string | null;
  measuredAt: string;
  windowMs: Quantity;
  sampleSize: Quantity;
  vantage: 'local-workbench';
  requirement: {
    usefulOutput: string;
    latencyTargetMs: Quantity;
    scope: Experience['scope'];
    targetPercentile: Fraction;
  };
  result: {
    withinTarget: Fraction | null;
    latencyP95Ms: Quantity | null;
    usefulOutputProbability: Fraction | null;
    judgeModel: string | null;
  };
  evidence: Evidence;
}
export interface WorkspaceFinding {
  kind:
    | 'interface'
    | 'operation'
    | 'schema'
    | 'agent-card'
    | 'mcp'
    | 'broker'
    | 'cache'
    | 'scheduler'
    | 'resilience'
    | 'idempotency'
    | 'tracing'
    | 'auth';
  name: string;
  detail: string;
  evidence: Evidence;
}
/** Structural facts from a bounded local scan. Operational facts remain unknown and are listed in gaps. */
export interface WorkspaceIndex {
  formatVersion: FormatVersion;
  indexerVersion: string;
  /** Directory name only; absolute paths are never serialized. */
  root: string;
  scannedAt: string;
  /** Hash of scanned relative paths and contents, used for freshness. */
  fingerprint: string;
  filesScanned: Quantity;
  truncated: boolean;
  /** @maxItems 500 */
  findings: WorkspaceFinding[];
  /** Draft description for review; null when no operation was found. */
  system: SystemDescription | null;
  gaps: string[];
}
