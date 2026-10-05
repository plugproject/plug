import { stringify } from 'yaml';
import {
  assertContract,
  defaultPriorities,
  guardDocument,
  parseInput,
  validateInput,
} from '../contracts/index';
import type {
  Connection,
  DesignInput,
  DesignRecommendation,
  Evidence,
  Fact,
  Interface,
  JsonObject,
  Operation,
  SystemDescription,
  WorkflowSpecMetadata,
  WorkflowTaskMetadata,
} from '../contracts/index';
/** Open Workflow Specification DSL version written on export; any 1.x document is read. */
export const workflowDsl = '1.0.3';
export const workflowLimits = {
  bytes: 256 * 1024,
  systems: 8,
  connections: 12,
  operationsPerSystem: 4,
};
export interface WorkflowImport {
  input: DesignInput;
  /** Everything Plug could not take from the document, or changed while reconciling it. */
  gaps: string[];
  /** The document carried valid Plug metadata and nothing had to be reconciled. */
  lossless: boolean;
}
type Task = Record<string, any>;
const placeholderPrefix = 'plug://systems/';
const placeholder = (systemId: string, operationId: string) =>
  `${placeholderPrefix}${encodeURIComponent(systemId)}/operations/${encodeURIComponent(operationId)}`;
const slug = (text: string, fallback: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '') || fallback;
const uniqueId = (base: string, taken: Iterable<string>) => {
  const used = new Set(taken);
  let id = base,
    n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
};
const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
function endpointsOf(input: DesignInput, c: Connection) {
  const caller = input.systems.find((s) => s.id === c.callerSystemId)!;
  const downstream = input.systems.find((s) => s.id === c.downstreamSystemId)!;
  const operation = downstream.operations.find(
    (o) => o.id === c.downstreamOperationId,
  )!;
  const iface = downstream.interfaces.find(
    (i) => i.id === operation.interfaceId,
  )!;
  return { caller, downstream, operation, iface };
}
function taskFor(input: DesignInput, c: Connection): Task {
  const { operation, iface } = endpointsOf(input, c);
  const endpoint =
    iface.endpoint ??
    placeholder(c.downstreamSystemId, c.downstreamOperationId);
  const call: Task =
    iface.protocol === 'mcp'
      ? {
          call: 'mcp',
          with: {
            protocolVersion: iface.version,
            method: 'tools/call',
            parameters: { name: operation.id },
            transport: { http: { endpoint } },
          },
        }
      : iface.protocol === 'a2a'
        ? { call: 'a2a', with: { method: 'message/send', server: endpoint } }
        : {
            call: 'http',
            with: {
              method: operation.semantics.effect === 'read' ? 'get' : 'post',
              endpoint,
            },
          };
  const timeout = c.profile.timeoutMs.value;
  if (timeout !== null)
    call.timeout = { after: { milliseconds: Math.ceil(timeout) } };
  const metadata: WorkflowTaskMetadata = {
    connectionId: c.id,
    callerSystemId: c.callerSystemId,
    callerOperationId: c.callerOperationId,
    downstreamSystemId: c.downstreamSystemId,
    downstreamOperationId: c.downstreamOperationId,
    priorities: c.experience.priorities ?? [...defaultPriorities],
    latencyTargetMs: c.experience.latencyTargetMs,
  };
  call.metadata = { plug: metadata };
  return call;
}
/**
 * Deterministic Open Workflow Specification document for an input. Pass the
 * design only when it was computed for this exact input.
 */
export function exportWorkflowSpec(
  raw: DesignInput,
  design: DesignRecommendation | null = null,
): JsonObject {
  const input = validateInput(raw);
  if (
    design &&
    stable(design.connections.map((r) => r.connectionId)) !==
      stable(input.connections.map((c) => c.id))
  )
    throw new Error('The design was computed for different connections');
  const first = endpointsOf(input, input.connections[0]).caller;
  const meta: WorkflowSpecMetadata = {
    formatVersion: input.formatVersion,
    input,
    design: design && {
      inputHash: design.inputHash,
      designHash: design.designHash,
      catalogVersion: design.catalogVersion,
      selected: design.connections.map((r) => ({
        connectionId: r.connectionId,
        patternId: r.selectedId,
        architectureId: r.selectedArchitectureId,
      })),
    },
  };
  const summary = input.connections
    .map((c) => {
      const { caller, downstream } = endpointsOf(input, c);
      return `- \`${c.id}\`: ${caller.name} \`${c.callerOperationId}\` → ${downstream.name} \`${c.downstreamOperationId}\`, ${c.experience.usefulOutput} within ${c.experience.latencyTargetMs} ms`;
    })
    .join('\n');
  return structuredClone({
    document: {
      dsl: workflowDsl,
      namespace: 'plug',
      name: slug(first.name, slug(first.id, 'workflow')),
      version: '0.1.0',
      title: `${first.name} integration`,
      summary: `Generated by Plug from ${input.formatVersion}. Edit it in the Plug workbench or with plug_update_spec.\n\n${summary}`,
      tags: { generator: 'plug' },
      metadata: { plug: meta },
    },
    do: input.connections.map((c) => ({ [c.id]: taskFor(input, c) })),
  }) as unknown as JsonObject;
}
export function workflowSpecYaml(
  input: DesignInput,
  design: DesignRecommendation | null = null,
): string {
  return (
    '# Open Workflow Specification document generated by Plug.\n' +
    '# document.metadata.plug holds the canonical input; re-import validates it.\n' +
    stringify(exportWorkflowSpec(input, design), {
      aliasDuplicateObjects: false,
      lineWidth: 0,
    })
  );
}
export function importWorkflowSpec(text: string): WorkflowImport {
  return importWorkflowDocument(parseInput(text));
}
/** Accepts a DesignInput (any supported version) or a workflow document. */
export function readSpecSource(raw: unknown): WorkflowImport {
  if (
    raw &&
    typeof raw === 'object' &&
    'document' in raw &&
    'do' in raw &&
    !('formatVersion' in raw)
  )
    return importWorkflowDocument(raw);
  return { input: validateInput(raw), gaps: [], lossless: true };
}
function object(v: unknown, label: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`${label} must be an object`);
  return v as Record<string, any>;
}
const unmodeled = [
  'switch',
  'fork',
  'for',
  'try',
  'listen',
  'emit',
  'run',
  'set',
  'wait',
  'raise',
] as const;
function collectCalls(
  list: unknown,
  path: string,
  gaps: string[],
  out: { name: string; path: string; task: Task }[],
) {
  if (!Array.isArray(list)) throw new Error(`${path} must be a task list`);
  list.forEach((item, i) => {
    const entry = object(item, `${path}/${i}`);
    const names = Object.keys(entry);
    if (names.length !== 1)
      throw new Error(`${path}/${i} must name exactly one task`);
    const name = names[0],
      task = object(entry[name], `Task ${name}`),
      at = `${path}/${i}/${name}`;
    if (typeof task.if === 'string')
      gaps.push(
        `${name}: its condition is not modeled; the call is analyzed as always taken.`,
      );
    if (typeof task.call === 'string') {
      out.push({ name, path: at, task });
      return;
    }
    if (Array.isArray(task.do)) {
      if (task.for)
        gaps.push(
          `${name}: loop iterations are not modeled; supply the call rate as workload.`,
        );
      collectCalls(task.do, `${at}/do`, gaps, out);
      return;
    }
    if (task.fork && Array.isArray(task.fork.branches)) {
      gaps.push(
        `${name}: parallel branches are analyzed as separate connections.`,
      );
      collectCalls(task.fork.branches, `${at}/fork/branches`, gaps, out);
      return;
    }
    if (Array.isArray(task.try)) {
      gaps.push(
        `${name}: error handling is not modeled; declare retry and timeout facts instead.`,
      );
      collectCalls(task.try, `${at}/try`, gaps, out);
      return;
    }
    const kind = unmodeled.find((k) => k in task) ?? 'unknown';
    gaps.push(`${name}: ${kind} task is not modeled.`);
  });
}
const unknownFact = (): Fact => ({
  value: null,
  evidence: { kind: 'unknown', note: 'Not stated in the workflow document.' },
});
function hostOf(endpoint: unknown): string | null {
  const uri =
    typeof endpoint === 'string'
      ? endpoint
      : endpoint && typeof endpoint === 'object'
        ? (endpoint as Record<string, unknown>).uri
        : null;
  if (typeof uri !== 'string' || /^\s*\$\{/.test(uri)) return null;
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}
function durationMs(timeout: unknown): number | null {
  const after =
    timeout && typeof timeout === 'object'
      ? (timeout as Record<string, unknown>).after
      : undefined;
  if (after && typeof after === 'object') {
    const d = after as Record<string, unknown>;
    const units: [string, number][] = [
      ['days', 86400000],
      ['hours', 3600000],
      ['minutes', 60000],
      ['seconds', 1000],
      ['milliseconds', 1],
    ];
    let total = 0;
    for (const [unit, ms] of units) {
      const n = d[unit];
      if (n === undefined) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
      total += n * ms;
    }
    return total;
  }
  if (typeof after !== 'string') return null;
  const m =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      after,
    );
  if (!m || after === 'P' || after.endsWith('T')) return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  return Math.round(((d * 24 + h) * 60 + min) * 60000 + s * 1000);
}
interface DraftTarget {
  key: string;
  name: string;
  iface: Interface;
  operationId: string;
  description: string;
  effect: Operation['semantics']['effect'];
}
function targetOf(
  name: string,
  task: Task,
  gaps: string[],
): DraftTarget | null {
  const w = task.with && typeof task.with === 'object' ? task.with : {};
  const iface = (
    protocol: Interface['protocol'],
    version: unknown,
    binding: string,
  ): Interface => ({
    id: protocol,
    protocol,
    version: typeof version === 'string' ? version : 'unknown',
    direction: 'exposes',
    binding,
  });
  const located = (host: string | null, kind: string) => {
    if (!host)
      gaps.push(
        `${name}: the ${kind} is an expression or missing; review the drafted system.`,
      );
    return host ?? 'unresolved-endpoint';
  };
  if (task.call === 'http' || task.call === 'openapi') {
    const openapi = task.call === 'openapi';
    const method = String(
      openapi ? 'post' : (w.method ?? 'post'),
    ).toLowerCase();
    const host = located(
      hostOf(openapi ? w.document?.endpoint : w.endpoint),
      'endpoint',
    );
    return {
      key: `http:${host}`,
      name: host,
      iface: iface('http', '1.1', 'HTTP'),
      operationId:
        openapi && typeof w.operationId === 'string' ? w.operationId : name,
      description: openapi
        ? `OpenAPI operation ${w.operationId ?? name} called by workflow task ${name}.`
        : `${method.toUpperCase()} request made by workflow task ${name}.`,
      effect: openapi
        ? 'unknown'
        : ['get', 'head'].includes(method)
          ? 'read'
          : method === 'post'
            ? 'unknown'
            : 'write',
    };
  }
  if (task.call === 'mcp') {
    const transport =
      w.transport && typeof w.transport === 'object' ? w.transport : {};
    const command =
      typeof transport.stdio?.command === 'string'
        ? transport.stdio.command.split(/[\\/]/).pop()
        : null;
    const host =
      command ?? located(hostOf(transport.http?.endpoint), 'MCP endpoint');
    const tool =
      w.method === 'tools/call' && typeof w.parameters?.name === 'string'
        ? w.parameters.name
        : name;
    return {
      key: `mcp:${host}`,
      name: host,
      iface: iface('mcp', w.protocolVersion, 'MCP'),
      operationId: tool,
      description: `MCP ${w.method ?? 'call'} ${tool} made by workflow task ${name}.`,
      effect: 'unknown',
    };
  }
  if (task.call === 'a2a') {
    const host = located(
      hostOf(w.server) ?? hostOf(w.agentCard?.endpoint),
      'A2A server',
    );
    return {
      key: `a2a:${host}`,
      name: host,
      iface: iface('a2a', undefined, 'A2A'),
      operationId: name,
      description: `A2A ${w.method ?? 'call'} made by workflow task ${name}.`,
      effect: 'unknown',
    };
  }
  gaps.push(
    `${name}: call type ${String(task.call)} is not mapped; Plug models HTTP, OpenAPI, MCP and A2A calls.`,
  );
  return null;
}
function draftConnection(
  id: string,
  caller: { systemId: string; operationId: string },
  systemId: string,
  operationId: string,
  name: string,
  path: string,
  timeoutMs: number | null,
): Connection {
  const timeoutEvidence: Evidence = {
    kind: 'declared',
    note: 'Hard bound from the workflow task timeout.',
    source: { type: 'open-workflow-specification', location: path },
  };
  return {
    id,
    callerSystemId: caller.systemId,
    callerOperationId: caller.operationId,
    downstreamSystemId: systemId,
    downstreamOperationId: operationId,
    inputMapping: [],
    outputMapping: [],
    adapter: null,
    profile: {
      systemId,
      operationId,
      latencyMs: unknownFact(),
      latencyPercentile: null,
      timeoutMs:
        timeoutMs === null
          ? unknownFact()
          : { value: timeoutMs, evidence: timeoutEvidence },
      callsPerMinute: unknownFact(),
      concurrency: unknownFact(),
      responseBytes: unknownFact(),
      callCost: unknownFact(),
      changeIntervalMs: unknownFact(),
      sourceTimestamp: 'unknown',
      sourceLagMs: unknownFact(),
      invalidation: 'unknown',
    },
    workload: {
      requestsPerMinute: unknownFact(),
      hotKeyShare: unknownFact(),
      prewarmKeys: null,
      keyCount: unknownFact(),
      trace: null,
      traceEvidence: unknownFact().evidence,
      measurementStartMs: 0,
    },
    experience: {
      usefulOutput: `Result of workflow task ${name}`,
      latencyTargetMs: 2000,
      scope: 'trafficPercentile',
      targetPercentile: 0.95,
      maxAgeMs: null,
      correctness: 'live',
      allowIndicative: false,
      allowDeferred: false,
      allowSlowMiss: false,
      finalDeadlineMs: null,
      hitsWithinTarget: unknownFact(),
      hitsWithinTargetMs: 2000,
      initialOutput: null,
      priorities: [...defaultPriorities],
    },
    remainingPath: {
      agentMs: unknownFact(),
      networkMs: unknownFact(),
      mappingMs: unknownFact(),
      renderingMs: unknownFact(),
      cacheLookupMs: unknownFact(),
      deliveryAllowanceMs: unknownFact(),
    },
  };
}
function plugMetadata<T>(
  root: string,
  value: unknown,
  gaps: string[],
  label: string,
) {
  if (value === undefined) return null;
  try {
    assertContract<T>(root, value);
    return value as T;
  } catch (e) {
    gaps.push(`${label}: Plug metadata ignored (${(e as Error).message}).`);
    return null;
  }
}
/** Parse-only import: nothing in the document is fetched, resolved or called. */
export function importWorkflowDocument(raw: unknown): WorkflowImport {
  guardDocument(raw);
  if (
    new TextEncoder().encode(JSON.stringify(raw)).length > workflowLimits.bytes
  )
    throw new Error('Workflow document exceeds 256 KB');
  const doc = object(raw, 'Workflow document');
  const head = object(doc.document, 'document');
  if (typeof head.dsl !== 'string' || !/^1\.\d+\.\d+/.test(head.dsl))
    throw new Error(
      'Only Open Workflow Specification 1.x documents are supported (document.dsl)',
    );
  for (const field of ['namespace', 'name', 'version'])
    if (typeof head[field] !== 'string' || !head[field])
      throw new Error(`document.${field} is required`);
  const gaps: string[] = [];
  const calls: { name: string; path: string; task: Task }[] = [];
  collectCalls(doc.do, 'do', gaps, calls);
  const meta = plugMetadata<WorkflowSpecMetadata>(
    'WorkflowSpecMetadata',
    head.metadata?.plug,
    gaps,
    'document',
  );
  let base: DesignInput | null = null;
  if (meta)
    try {
      base = validateInput(meta.input);
    } catch (e) {
      gaps.push(`document: embedded input ignored (${(e as Error).message}).`);
    }
  const systems: SystemDescription[] = structuredClone(base?.systems ?? []);
  const connections: Connection[] = [];
  const drafted = new Map<string, string>();
  let reconciled = false,
    caller: { systemId: string; operationId: string } | null = base
      ? {
          systemId: base.connections[0].callerSystemId,
          operationId: base.connections[0].callerOperationId,
        }
      : null;
  const ensureCaller = () => {
    if (caller) return caller;
    const id = uniqueId(
      slug(head.name, 'workflow'),
      systems.map((s) => s.id),
    );
    systems.push({
      id,
      name: typeof head.title === 'string' ? head.title : head.name,
      role: 'caller',
      interfaces: [
        {
          id: 'workflow',
          protocol: 'http',
          version: '1.1',
          direction: 'calls',
          binding: 'Open Workflow Specification',
        },
      ],
      operations: [
        {
          id: 'run',
          interfaceId: 'workflow',
          description:
            typeof head.summary === 'string'
              ? head.summary.slice(0, 500)
              : `Runs workflow ${head.name}.`,
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
            evidence: unknownFact().evidence,
          },
        },
      ],
    });
    caller = { systemId: id, operationId: 'run' };
    return caller;
  };
  const pairs = new Set<string>();
  const add = (c: Connection, name: string) => {
    const pair = stable([
      c.callerSystemId,
      c.callerOperationId,
      c.downstreamSystemId,
      c.downstreamOperationId,
    ]);
    if (pairs.has(pair)) {
      gaps.push(
        `${name}: repeats an earlier task's operation pair and was merged into it.`,
      );
      reconciled = true;
      return;
    }
    pairs.add(pair);
    connections.push(c);
  };
  for (const { name, path, task } of calls) {
    const tm = plugMetadata<WorkflowTaskMetadata>(
      'WorkflowTaskMetadata',
      task.metadata?.plug,
      gaps,
      name,
    );
    const known =
      base && tm
        ? base.connections.find((c) => c.id === tm.connectionId)
        : undefined;
    if (known && !connections.some((c) => c.id === known.id)) {
      const c = structuredClone(known);
      if (
        tm!.callerSystemId !== c.callerSystemId ||
        tm!.callerOperationId !== c.callerOperationId ||
        tm!.downstreamSystemId !== c.downstreamSystemId ||
        tm!.downstreamOperationId !== c.downstreamOperationId
      ) {
        gaps.push(
          `${name}: endpoint edits in task metadata are ignored; reconnect the edge in Plug.`,
        );
        reconciled = true;
      }
      if (
        stable(tm!.priorities) !==
        stable(c.experience.priorities ?? defaultPriorities)
      ) {
        c.experience.priorities = [...tm!.priorities];
        gaps.push(`${c.id}: applied the edited priority order.`);
        reconciled = true;
      }
      if (tm!.latencyTargetMs !== c.experience.latencyTargetMs) {
        c.experience.latencyTargetMs = tm!.latencyTargetMs;
        gaps.push(
          `${c.id}: applied the edited latency target of ${tm!.latencyTargetMs} ms.`,
        );
        reconciled = true;
      }
      const { metadata: _a, ...given } = task;
      const { metadata: _b, ...expected } = taskFor(
        { ...base!, systems, connections: [c] },
        c,
      );
      if (stable(given) !== stable(expected)) {
        gaps.push(
          `${name}: call edits other than priorities and latency target are not imported; edit the system in Plug.`,
        );
        reconciled = true;
      }
      add(c, name);
      continue;
    }
    if (base) reconciled = true;
    const target = targetOf(name, task, gaps);
    if (!target) continue;
    const from = ensureCaller();
    const placeholderRef =
      typeof task.with?.endpoint === 'string' &&
      task.with.endpoint.startsWith(placeholderPrefix)
        ? /^plug:\/\/systems\/([^/]+)\/operations\/([^/]+)$/.exec(
            task.with.endpoint,
          )
        : null;
    const existing = placeholderRef
      ? systems
          .find((s) => s.id === decodeURIComponent(placeholderRef[1]))
          ?.operations.find(
            (o) => o.id === decodeURIComponent(placeholderRef[2]),
          )
      : undefined;
    let systemId: string, operationId: string;
    if (existing && placeholderRef) {
      systemId = decodeURIComponent(placeholderRef[1]);
      operationId = existing.id;
    } else {
      systemId =
        drafted.get(target.key) ??
        uniqueId(
          slug(target.name, 'system'),
          systems.map((s) => s.id),
        );
      let system = systems.find((s) => s.id === systemId);
      if (!system) {
        system = {
          id: systemId,
          name: target.name,
          role: 'downstream',
          interfaces: [target.iface],
          operations: [],
        };
        systems.push(system);
        drafted.set(target.key, systemId);
      }
      operationId = /^[A-Za-z0-9._-]{1,64}$/.test(target.operationId)
        ? target.operationId
        : slug(target.operationId, 'operation');
      if (!system.operations.some((o) => o.id === operationId))
        system.operations.push({
          id: operationId,
          interfaceId: target.iface.id,
          description: target.description,
          inputSchema: null,
          outputSchema: null,
          semantics: {
            effect: target.effect,
            idempotent: null,
            outputMeaning: null,
            cachePermission: null,
            scope: 'unknown',
            keyDimensions: [],
            keysComplete: null,
            requiresLiveValidation: true,
            evidence: {
              kind: 'static',
              note:
                target.effect === 'unknown'
                  ? 'Called from a workflow task; effect not stated.'
                  : 'Effect from HTTP method semantics; verify against the implementation.',
              source: { type: 'open-workflow-specification', location: path },
            },
          },
        });
    }
    const timeout =
      task.timeout === undefined ? null : durationMs(task.timeout);
    if (task.timeout !== undefined && (timeout === null || timeout > 86400000))
      gaps.push(
        `${name}: timeout is a reference, expression or beyond one day; supply the hard bound.`,
      );
    const id = uniqueId(slug(name, 'connection'), [
      ...connections.map((c) => c.id),
      ...(base?.connections.map((c) => c.id) ?? []),
    ]);
    add(
      draftConnection(
        id,
        from,
        systemId,
        operationId,
        name,
        path,
        timeout !== null && timeout > 0 && timeout <= 86400000 ? timeout : null,
      ),
      name,
    );
    gaps.push(
      `${id}: drafted from task ${name}. Its experience is a placeholder (live result within 2000 ms at p95) and every operational fact is unknown; set them before relying on the analysis.`,
    );
  }
  if (base) {
    for (const c of base.connections)
      if (!connections.some((x) => x.id === c.id)) {
        gaps.push(`${c.id}: removed because its workflow task was removed.`);
        reconciled = true;
      }
    const kept = base.connections
      .map((c) => c.id)
      .filter((id) => connections.some((c) => c.id === id));
    if (
      stable(kept) !==
      stable(connections.filter((c) => kept.includes(c.id)).map((c) => c.id))
    ) {
      gaps.push('Connection order now follows the workflow task order.');
      reconciled = true;
    }
  } else
    gaps.push(
      'Infrastructure is a placeholder: caching and scheduling stay disallowed until you permit them.',
    );
  if (!connections.length)
    throw new Error(
      'The workflow has no HTTP, OpenAPI, MCP or A2A call task to map',
    );
  const crowded = systems.find(
    (s) => s.operations.length > workflowLimits.operationsPerSystem,
  );
  if (crowded)
    throw new Error(
      `${crowded.name} would select ${crowded.operations.length} operations; Plug supports four per system`,
    );
  if (
    systems.length > workflowLimits.systems ||
    connections.length > workflowLimits.connections
  )
    throw new Error(
      `The workflow maps to ${systems.length} systems and ${connections.length} connections; Plug supports up to ${workflowLimits.systems} systems and ${workflowLimits.connections} connections`,
    );
  const input = validateInput({
    formatVersion: '0.2-alpha.1',
    systems,
    connections,
    infrastructure: base?.infrastructure ?? {
      cacheAllowed: false,
      schedulingAllowed: false,
      cacheCapacity: 0,
      memoryBytes: 0,
      refreshConcurrency: 1,
      schedulingAllowanceMs: unknownFact(),
      foregroundReserveCallsPerMinute: 0,
      callBudgetPerMinute: null,
    },
  });
  return { input, gaps: [...new Set(gaps)], lossless: !!base && !reconciled };
}
