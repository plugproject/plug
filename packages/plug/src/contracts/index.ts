import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument, visit, isAlias } from 'yaml';
import * as validators from '../../../../schema/draft/validators.js';
import type { ValidateFunction } from 'ajv';
import type {
  Connection,
  DesignInput,
  Fact,
  JsonObject,
  Priority,
  SystemDescription,
} from '../../../../schema/draft/schema';
export type * from '../../../../schema/draft/schema';
export const hostedDocumentLimit = 256 * 1024;
export const localDocumentLimit = 64 * 1024 * 1024;
export function assertContract<T>(
  root: string,
  value: unknown,
): asserts value is T {
  guardDocument(value);
  const validate = Object.hasOwn(validators, root)
    ? (validators as Record<string, ValidateFunction>)[root]
    : undefined;
  if (!validate) throw new Error(`Unknown contract ${root}`);
  if (!validate(value))
    throw new Error(
      `Invalid ${root}: ${validate.errors?.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`,
    );
}
/** No evaluation, alias expansion, remote resolution or prototype keys. */
export function guardDocument(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('Document nesting exceeds sixteen');
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Math.abs(value) > 1e15)
  )
    throw new Error('Numeric value outside finite bounds');
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (
        [
          '__proto__',
          'constructor',
          'prototype',
          '$function',
          '$eval',
        ].includes(key)
      )
        throw new Error('Executable/prototype expressions are unsupported');
      if (
        (key === '$ref' || key === '$dynamicRef') &&
        (typeof v !== 'string' || !v.startsWith('#'))
      )
        throw new Error('Remote schema references are unsupported');
      guardDocument(v, depth + 1);
    }
  }
}
export function parseInput(
  text: string,
  maxBytes = localDocumentLimit,
): unknown {
  if (new TextEncoder().encode(text).length > maxBytes)
    throw new Error(
      `Description exceeds ${maxBytes === hostedDocumentLimit ? '256 KB' : '64 MB'}`,
    );
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error('Invalid YAML/JSON or unsupported tag');
  visit(doc, (_key, node) => {
    if (
      isAlias(node) ||
      (node && typeof node === 'object' && 'tag' in node && node.tag)
    )
      throw new Error('YAML aliases and explicit tags are unsupported');
  });
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  guardDocument(value);
  return value;
}
export function checkSchemaDialect(contract: JsonObject): void {
  guardDocument(contract);
  const dialect = contract.$schema;
  if (
    dialect &&
    ![
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft-07/schema',
    ].includes(String(dialect))
  )
    throw new Error(
      'Unsupported schema dialect; metadata is preserved but execution requires a supported contract',
    );
}
export function compileOperationSchema(
  contract: JsonObject,
  protocol = 'http',
) {
  checkSchemaDialect(contract);
  const dialect = contract.$schema;
  const engine =
    dialect === 'https://json-schema.org/draft/2020-12/schema' ||
    (!dialect && protocol === 'mcp')
      ? new Ajv2020({
          strict: false,
          strictSchema: true,
          validateFormats: false,
        })
      : new Ajv({ strict: false, strictSchema: true, validateFormats: false });
  return engine.compile(contract);
}
export function normalizeSystems(systems: unknown): SystemDescription[] {
  if (!Array.isArray(systems) || systems.length < 2)
    throw new Error('At least two systems are required');
  for (const system of systems)
    assertContract<SystemDescription>('SystemDescription', system);
  return structuredClone(systems) as SystemDescription[];
}
export const defaultPriorities: Priority[] = [
  'correctness',
  'latency',
  'availability',
  'simplicity',
  'cost',
];
/** Lifts a 0.1-alpha.2 document mechanically; 0.2-alpha.1 documents pass through unchanged. */
export function migrateInput(value: unknown): unknown {
  guardDocument(value);
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { formatVersion?: unknown }).formatVersion !== '0.1-alpha.2'
  )
    return value;
  const {
    connection,
    profile,
    workload,
    experience,
    remainingPath,
    preference,
    systems,
    infrastructure,
    ...rest
  } = structuredClone(value) as Record<string, unknown>;
  if (Object.keys(rest).some((k) => k !== 'formatVersion'))
    throw new Error('Unknown 0.1-alpha.2 fields cannot be migrated');
  if (!connection || typeof connection !== 'object' || !experience)
    throw new Error('0.1-alpha.2 document lacks a connection or experience');
  const first = ['latency', 'cost', 'simplicity'].includes(String(preference))
    ? (preference as Priority)
    : 'latency';
  return {
    formatVersion: '0.2-alpha.1',
    systems,
    connections: [
      {
        id: 'primary',
        ...(connection as object),
        profile,
        workload,
        experience: {
          ...(experience as object),
          priorities: [
            'correctness',
            first,
            ...defaultPriorities.filter(
              (p) => p !== 'correctness' && p !== first,
            ),
          ],
        },
        remainingPath,
      },
    ],
    infrastructure,
  };
}
export function connectionById(
  input: DesignInput,
  connectionId?: string,
): Connection {
  const c = connectionId
    ? input.connections.find((x) => x.id === connectionId)
    : input.connections[0];
  if (!c) throw new Error(`Unknown connection ${connectionId}`);
  return c;
}
export function validateInput(raw: unknown): DesignInput {
  const value = migrateInput(raw);
  assertContract<DesignInput>('DesignInput', value);
  const input = structuredClone(value),
    { systems } = input;
  if (new Set(systems.map((s) => s.id)).size !== systems.length)
    throw new Error('System identities must be distinct');
  if (
    new Set(input.connections.map((c) => c.id)).size !==
    input.connections.length
  )
    throw new Error('Connection identities must be distinct');
  const pairs = input.connections.map((c) =>
    JSON.stringify([
      c.callerSystemId,
      c.callerOperationId,
      c.downstreamSystemId,
      c.downstreamOperationId,
    ]),
  );
  if (new Set(pairs).size !== pairs.length)
    throw new Error('Each connection must select a distinct operation pair');
  for (const c of input.connections)
    if (c.callerSystemId === c.downstreamSystemId)
      throw new Error('Connection endpoints must be distinct systems');
  for (const system of systems) {
    if (
      new Set(system.operations.map((o) => o.id)).size !==
        system.operations.length ||
      new Set(system.interfaces.map((i) => i.id)).size !==
        system.interfaces.length
    )
      throw new Error('Duplicate interface or operation ID');
    for (const op of system.operations)
      if (!system.interfaces.some((i) => i.id === op.interfaceId))
        throw new Error('Operation references an unknown interface');
  }
  const checkFacts = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if ('value' in v && 'evidence' in v) {
      const f = v as Fact;
      if ((f.value === null) !== (f.evidence.kind === 'unknown'))
        throw new Error(
          'Unknown facts require null values and unknown evidence',
        );
    }
    Object.values(v).forEach(checkFacts);
  };
  checkFacts(input);
  if (
    input.infrastructure.cacheCapacity > 1000 ||
    input.infrastructure.refreshConcurrency > 64
  )
    throw new Error('Analysis capacity exceeds alpha bounds');
  for (const c of input.connections) validateConnection(input, c);
  return input;
}
function validateConnection(input: DesignInput, c: Connection) {
  const { systems } = input,
    p = c.profile,
    infra = input.infrastructure;
  const caller = systems
    .find((s) => s.id === c.callerSystemId)
    ?.operations.find((o) => o.id === c.callerOperationId);
  const downstream = systems
    .find((s) => s.id === c.downstreamSystemId)
    ?.operations.find((o) => o.id === c.downstreamOperationId);
  if (!caller || !downstream) throw new Error('Selected operation not found');
  if (
    p.systemId !== c.downstreamSystemId ||
    p.operationId !== c.downstreamOperationId
  )
    throw new Error('Profile must describe the selected downstream operation');
  const priorities = c.experience.priorities ?? [];
  if (new Set(priorities).size !== priorities.length)
    throw new Error('Priorities must be distinct');
  for (const f of [
    p.timeoutMs,
    p.latencyMs,
    p.sourceLagMs,
    infra.schedulingAllowanceMs,
    ...Object.values(c.remainingPath),
  ])
    if (f.value !== null && f.value > 86400000)
      throw new Error('Duration bounds exceed the supported one-day horizon');
  if (
    c.experience.latencyTargetMs > 86400000 ||
    (c.experience.finalDeadlineMs ?? 0) > 86400000
  )
    throw new Error('UX timer exceeds the one-day horizon');
  if (p.concurrency.value !== null && p.concurrency.value > 64)
    throw new Error('Concurrency exceeds bounded analysis capacity');
  if (
    new Set(downstream.semantics.keyDimensions).size !==
    downstream.semantics.keyDimensions.length
  )
    throw new Error('Key dimensions must be unique');
  const keyIds =
    c.workload.prewarmKeys?.map((key) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(key).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    ) ?? [];
  if (new Set(keyIds).size !== keyIds.length)
    throw new Error('Prewarm keys must be distinct');
  for (const n of [
    infra.cacheCapacity,
    infra.refreshConcurrency,
    p.concurrency.value,
    p.responseBytes.value,
    c.workload.keyCount.value,
  ])
    if (n !== null && !Number.isInteger(n))
      throw new Error('Counts must be integers');
  if ((c.workload.prewarmKeys?.length ?? 0) > 100)
    throw new Error('Analysis capacity exceeds alpha bounds');
  let prev = -1;
  for (const row of c.workload.trace ?? []) {
    if (row.atMs < prev || row.atMs > 86400000)
      throw new Error('Trace must be ordered within a bounded day');
    prev = row.atMs;
  }
  if (
    p.timeoutMs.value === 0 ||
    p.concurrency.value === 0 ||
    p.callsPerMinute.value === 0
  )
    throw new Error('Known duration, concurrency and quota must be positive');
  if (
    p.latencyMs.value !== null &&
    p.timeoutMs.value !== null &&
    p.latencyMs.value > p.timeoutMs.value
  )
    throw new Error('Latency exceeds the declared hard bound');
}
export function selectedOperation(input: DesignInput, connectionId?: string) {
  const c = connectionById(input, connectionId);
  return input.systems
    .find((s) => s.id === c.downstreamSystemId)!
    .operations.find((o) => o.id === c.downstreamOperationId)!;
}
