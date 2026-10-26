import { defaultPriorities } from '../../../../packages/plug/src/contracts/index';
import type {
  Connection,
  DesignInput,
  Fact,
  Operation,
  SystemDescription,
} from '../../../../packages/plug/src/contracts/index';
/** What the inspector edits: one connection (edge), operation (node) or system (group). */
export type Focus =
  | { kind: 'connection'; id: string }
  | { kind: 'operation'; systemId: string; operationId: string }
  | { kind: 'system'; systemId: string };
export type Endpoint = { systemId: string; operationId: string };
export const uniqueId = (base: string, taken: string[]) => {
  let id = base,
    n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
};
export const declared = (value: number | null): Fact => ({
  value,
  evidence: {
    kind: value === null ? 'unknown' : 'declared',
    note: 'Entered by the author in the playground.',
  },
});
export const blankOperation = (id: string, interfaceId: string): Operation => ({
  id,
  interfaceId,
  description: 'Describe the operation',
  inputSchema: null,
  outputSchema: null,
  semantics: {
    effect: 'unknown',
    idempotent: null,
    outputMeaning: null,
    cachePermission: null,
    scope: 'unknown',
    keyDimensions: [],
    keysComplete: null,
    requiresLiveValidation: true,
    evidence: {
      kind: 'unknown',
      note: 'Added in the playground; supply its facts.',
    },
  },
});
/** A complete, inert binding for the inspector to fill without inventing values. */
export const blankBinding = (
  protocol: SystemDescription['interfaces'][number]['protocol'],
): NonNullable<Operation['binding']> => ({
  request: {
    protocol,
    method:
      protocol === 'http'
        ? 'GET'
        : protocol === 'mcp'
          ? 'tools/call'
          : 'message/send',
    pathTemplate: '',
    query: {},
    headers: {},
    bodyTemplate: null,
    samples: [],
    samplesEvidence: {
      kind: 'unknown',
      note: 'No request samples supplied.',
    },
  },
  response: {
    dataPointer: null,
    snapshotPointer: null,
    snapshotHeader: null,
    timestampFormat: 'unknown',
  },
});
export const blankSystem = (id: string): SystemDescription => ({
  id,
  name: 'New system',
  role: 'downstream',
  interfaces: [
    {
      id: 'http',
      protocol: 'http',
      version: '1.1',
      direction: 'exposes',
      binding: 'HTTP+JSON',
    },
  ],
  operations: [blankOperation('operation', 'http')],
});
/** Points a connection at a new downstream operation; its operational facts become unknown. */
export function retarget(c: Connection, systemId: string, operationId: string) {
  c.downstreamSystemId = systemId;
  c.downstreamOperationId = operationId;
  c.inputMapping = [];
  c.outputMapping = [];
  c.adapter = null;
  c.profile = {
    ...c.profile,
    systemId,
    operationId,
    latencyMs: declared(null),
    timeoutMs: declared(null),
    callsPerMinute: declared(null),
    concurrency: declared(null),
    responseBytes: declared(null),
    callCost: declared(null),
    changeIntervalMs: declared(null),
    sourceLagMs: declared(null),
    sourceTimestamp: 'unknown',
    invalidation: 'unknown',
  };
  delete c.profile.availability;
  c.workload.trace = null;
  c.workload.prewarmKeys = null;
  c.workload.hotKeyShare = declared(null);
}
export const pairTaken = (
  d: DesignInput,
  callerSystemId: string,
  callerOperationId: string,
  downstreamSystemId: string,
  downstreamOperationId: string,
  except?: string,
) =>
  d.connections.some(
    (c) =>
      c.id !== except &&
      c.callerSystemId === callerSystemId &&
      c.callerOperationId === callerOperationId &&
      c.downstreamSystemId === downstreamSystemId &&
      c.downstreamOperationId === downstreamOperationId,
  );
/** Why a new caller→downstream edge is not allowed, or null when it is. */
export function connectBlocked(
  d: DesignInput,
  from: { systemId: string; operationId: string },
  to: { systemId: string; operationId: string },
): string | null {
  if (from.systemId === to.systemId)
    return 'A connection joins two different systems.';
  if (
    pairTaken(d, from.systemId, from.operationId, to.systemId, to.operationId)
  )
    return 'These operations are already connected.';
  return null;
}
/** A connection with the placeholder experience of drafted workflow tasks; every fact is unknown. */
export function blankConnection(from: Endpoint, to: Endpoint): Connection {
  return {
    id: 'connection',
    callerSystemId: from.systemId,
    callerOperationId: from.operationId,
    downstreamSystemId: to.systemId,
    downstreamOperationId: to.operationId,
    inputMapping: [],
    outputMapping: [],
    adapter: null,
    profile: {
      systemId: to.systemId,
      operationId: to.operationId,
      latencyMs: declared(null),
      latencyPercentile: null,
      timeoutMs: declared(null),
      callsPerMinute: declared(null),
      concurrency: declared(null),
      responseBytes: declared(null),
      callCost: declared(null),
      changeIntervalMs: declared(null),
      sourceTimestamp: 'unknown',
      sourceLagMs: declared(null),
      invalidation: 'unknown',
    },
    workload: {
      requestsPerMinute: declared(null),
      hotKeyShare: declared(null),
      prewarmKeys: null,
      keyCount: declared(null),
      trace: null,
      traceEvidence: declared(null).evidence,
      measurementStartMs: 0,
    },
    experience: {
      usefulOutput: `Result of ${to.operationId}`,
      latencyTargetMs: 2000,
      scope: 'trafficPercentile',
      targetPercentile: 0.95,
      maxAgeMs: null,
      correctness: 'live',
      allowIndicative: false,
      allowDeferred: false,
      allowSlowMiss: false,
      finalDeadlineMs: null,
      hitsWithinTarget: declared(null),
      hitsWithinTargetMs: 2000,
      initialOutput: null,
      priorities: [...defaultPriorities],
    },
    remainingPath: {
      agentMs: declared(null),
      networkMs: declared(null),
      mappingMs: declared(null),
      renderingMs: declared(null),
      cacheLookupMs: declared(null),
      deliveryAllowanceMs: declared(null),
    },
  };
}
/**
 * Adds a connection that keeps the template's experience, or the placeholder one
 * without a template; downstream facts become unknown.
 */
export function addConnection(
  d: DesignInput,
  from: { systemId: string; operationId: string },
  to: { systemId: string; operationId: string },
  template: Connection | null,
): string {
  const blocked = connectBlocked(d, from, to);
  if (blocked) throw new Error(blocked);
  const next = template ? structuredClone(template) : blankConnection(from, to);
  next.id = uniqueId(
    'connection',
    d.connections.map((c) => c.id),
  );
  next.callerSystemId = from.systemId;
  next.callerOperationId = from.operationId;
  retarget(next, to.systemId, to.operationId);
  d.connections.push(next);
  return next.id;
}
/** Why moving an existing edge to new ends is not allowed, or null when it is. */
export function reconnectBlocked(
  d: DesignInput,
  connectionId: string,
  from: { systemId: string; operationId: string },
  to: { systemId: string; operationId: string },
): string | null {
  if (from.systemId === to.systemId)
    return 'A connection joins two different systems.';
  if (
    pairTaken(
      d,
      from.systemId,
      from.operationId,
      to.systemId,
      to.operationId,
      connectionId,
    )
  )
    return 'These operations are already connected.';
  return null;
}
/** Moves an edge; a new caller drops mappings, a new downstream makes its facts unknown. */
export function reconnect(
  d: DesignInput,
  connectionId: string,
  from: { systemId: string; operationId: string },
  to: { systemId: string; operationId: string },
) {
  const blocked = reconnectBlocked(d, connectionId, from, to);
  if (blocked) throw new Error(blocked);
  const c = d.connections.find((x) => x.id === connectionId)!;
  if (
    c.callerSystemId !== from.systemId ||
    c.callerOperationId !== from.operationId
  ) {
    c.callerSystemId = from.systemId;
    c.callerOperationId = from.operationId;
    c.inputMapping = [];
    c.outputMapping = [];
  }
  if (
    c.downstreamSystemId !== to.systemId ||
    c.downstreamOperationId !== to.operationId
  )
    retarget(c, to.systemId, to.operationId);
}
const operationIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
/** Renames an operation everywhere it is referenced. */
export function renameOperation(
  d: DesignInput,
  systemId: string,
  from: string,
  to: string,
) {
  if (from === to) return;
  if (!operationIdPattern.test(to))
    throw new Error(
      'Operation IDs use 1–64 letters, digits, dots, dashes or underscores.',
    );
  const system = d.systems.find((s) => s.id === systemId)!;
  if (system.operations.some((o) => o.id === to))
    throw new Error(`${system.name} already has an operation ${to}.`);
  system.operations.find((o) => o.id === from)!.id = to;
  for (const c of d.connections) {
    if (c.callerSystemId === systemId && c.callerOperationId === from)
      c.callerOperationId = to;
    if (c.downstreamSystemId === systemId && c.downstreamOperationId === from)
      c.downstreamOperationId = to;
    if (c.profile.systemId === systemId && c.profile.operationId === from)
      c.profile.operationId = to;
  }
}
/** Adds a blank operation to the system and returns its generated ID. */
export function addOperation(d: DesignInput, systemId: string): string {
  const system = d.systems.find((s) => s.id === systemId)!;
  const id = uniqueId(
    'operation',
    system.operations.map((o) => o.id),
  );
  system.operations.push(blankOperation(id, system.interfaces[0].id));
  return id;
}
/** Operations of other systems this one can still call, and those it can still serve. */
export function freePartnersFor(
  d: DesignInput,
  systemId: string,
  operationId: string,
) {
  const calls: Endpoint[] = [],
    serves: Endpoint[] = [];
  for (const other of d.systems) {
    if (other.id === systemId) continue;
    for (const op of other.operations) {
      if (!pairTaken(d, systemId, operationId, other.id, op.id))
        calls.push({ systemId: other.id, operationId: op.id });
      if (!pairTaken(d, other.id, op.id, systemId, operationId))
        serves.push({ systemId: other.id, operationId: op.id });
    }
  }
  return { calls, serves };
}
/** Why the operation cannot move into the system, or into a new one when it is null; null when it can. */
export function moveBlocked(
  d: DesignInput,
  from: Endpoint,
  toSystemId: string | null,
): string | null {
  const source = d.systems.find((s) => s.id === from.systemId)!;
  if (toSystemId === from.systemId)
    return `It already belongs to ${source.name}.`;
  if (toSystemId === null) return null;
  const target = d.systems.find((s) => s.id === toSystemId)!;
  const joins = d.connections.some(
    (c) =>
      (c.callerSystemId === from.systemId &&
        c.callerOperationId === from.operationId &&
        c.downstreamSystemId === toSystemId) ||
      (c.downstreamSystemId === from.systemId &&
        c.downstreamOperationId === from.operationId &&
        c.callerSystemId === toSystemId),
  );
  return joins
    ? `It is connected to ${target.name}, and a connection joins two different systems.`
    : null;
}
/**
 * Moves an operation into another system, or into a new system that copies its
 * interface without the endpoint. Its connections follow: a moved caller drops
 * its mappings and a moved downstream operation has unknown facts, as when
 * rewiring. Returns where the operation now lives.
 */
export function moveOperation(
  d: DesignInput,
  from: Endpoint,
  toSystemId: string | null,
): Endpoint {
  const blocked = moveBlocked(d, from, toSystemId);
  if (blocked) throw new Error(blocked);
  const source = d.systems.find((s) => s.id === from.systemId)!;
  const op = source.operations.find((o) => o.id === from.operationId)!;
  const face = source.interfaces.find((i) => i.id === op.interfaceId)!;
  let target = d.systems.find((s) => s.id === toSystemId);
  if (!target) {
    const copy = structuredClone(face);
    delete copy.endpoint;
    target = {
      ...blankSystem(
        uniqueId(
          'system',
          d.systems.map((s) => s.id),
        ),
      ),
      role: source.role,
      interfaces: [copy],
      operations: [],
    };
    d.systems.push(target);
  }
  source.operations = source.operations.filter((o) => o !== op);
  op.id = uniqueId(
    op.id,
    target.operations.map((o) => o.id),
  );
  op.interfaceId = (
    target.interfaces.find(
      (i) => i.protocol === face.protocol && i.direction === face.direction,
    ) ??
    target.interfaces.find((i) => i.protocol === face.protocol) ??
    target.interfaces[0]
  ).id;
  target.operations.push(op);
  const to = { systemId: target.id, operationId: op.id };
  for (const c of d.connections) {
    if (
      c.callerSystemId === from.systemId &&
      c.callerOperationId === from.operationId
    ) {
      c.callerSystemId = to.systemId;
      c.callerOperationId = to.operationId;
      c.inputMapping = [];
      c.outputMapping = [];
    }
    if (
      c.downstreamSystemId === from.systemId &&
      c.downstreamOperationId === from.operationId
    )
      retarget(c, to.systemId, to.operationId);
  }
  return to;
}
const touches = (c: Connection, f: Focus) =>
  f.kind === 'connection'
    ? c.id === f.id
    : f.kind === 'system'
      ? c.callerSystemId === f.systemId || c.downstreamSystemId === f.systemId
      : (c.callerSystemId === f.systemId &&
          c.callerOperationId === f.operationId) ||
        (c.downstreamSystemId === f.systemId &&
          c.downstreamOperationId === f.operationId);
/**
 * Removes a connection, or an operation or system together with every connection
 * that touches it. Returns the IDs of the removed connections.
 */
export function removeElement(d: DesignInput, f: Focus): string[] {
  const removed = d.connections.filter((c) => touches(c, f)).map((c) => c.id);
  d.connections = d.connections.filter((c) => !touches(c, f));
  if (f.kind === 'system')
    d.systems = d.systems.filter((s) => s.id !== f.systemId);
  if (f.kind === 'operation') {
    const system = d.systems.find((s) => s.id === f.systemId);
    if (system)
      system.operations = system.operations.filter(
        (o) => o.id !== f.operationId,
      );
  }
  return removed;
}
/**
 * Replaces a system's operations; an operation that is no longer listed is removed
 * with its connections. Returns the IDs of the removed connections.
 */
export function setOperations(
  d: DesignInput,
  systemId: string,
  operations: Operation[],
): string[] {
  const system = d.systems.find((s) => s.id === systemId)!;
  const ids = new Set(operations.map((o) => o.id));
  if (ids.size < operations.length)
    throw new Error('Operation IDs within a system must differ.');
  const removed = system.operations
    .filter((o) => !ids.has(o.id))
    .flatMap((o) =>
      removeElement(d, { kind: 'operation', systemId, operationId: o.id }),
    );
  system.operations = operations;
  return removed;
}
/** What the edited graph still needs before Plug can analyze or export it; empty when complete. */
export function draftGaps(d: DesignInput): string[] {
  const gaps: string[] = [];
  if (d.systems.length < 2) gaps.push('Add at least two systems.');
  for (const s of d.systems)
    if (!s.operations.length)
      gaps.push(`Give ${s.name} an operation, or remove it.`);
  if (!d.connections.length)
    gaps.push('Connect an operation to an operation of another system.');
  return gaps;
}
export const downstreamOp = (d: DesignInput, c: Connection) =>
  d.systems
    .find((s) => s.id === c.downstreamSystemId)!
    .operations.find((o) => o.id === c.downstreamOperationId)!;
