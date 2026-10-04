import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument, visit, isAlias } from 'yaml';
import * as validators from '../../../../schema/draft/validators.js';
import type { ValidateFunction } from 'ajv';
import type {
  DesignInput,
  Fact,
  JsonObject,
  SystemDescription,
} from '../../../../schema/draft/schema';
export type * from '../../../../schema/draft/schema';
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
export function parseInput(text: string): unknown {
  if (new TextEncoder().encode(text).length > 256 * 1024)
    throw new Error('Description exceeds 256 KB');
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
export function normalizeSystems(
  systems: unknown,
): [SystemDescription, SystemDescription] {
  if (!Array.isArray(systems) || systems.length !== 2)
    throw new Error('Exactly two systems are required');
  for (const system of systems)
    assertContract<SystemDescription>('SystemDescription', system);
  return structuredClone(systems) as [SystemDescription, SystemDescription];
}
export function validateInput(value: unknown): DesignInput {
  assertContract<DesignInput>('DesignInput', value);
  const input = structuredClone(value),
    { systems, connection: c, profile: p } = input;
  if (
    systems[0].id === systems[1].id ||
    c.callerSystemId === c.downstreamSystemId
  )
    throw new Error(
      'System identities and connection endpoints must be distinct',
    );
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
  const infra = input.infrastructure;
  for (const f of [
    p.timeoutMs,
    p.latencyMs,
    p.sourceLagMs,
    infra.schedulingAllowanceMs,
    ...Object.values(input.remainingPath),
  ])
    if (f.value !== null && f.value > 86400000)
      throw new Error('Duration bounds exceed the supported one-day horizon');
  if (
    input.experience.latencyTargetMs > 86400000 ||
    (input.experience.finalDeadlineMs ?? 0) > 86400000
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
    input.workload.prewarmKeys?.map((key) =>
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
    input.workload.keyCount.value,
  ])
    if (n !== null && !Number.isInteger(n))
      throw new Error('Counts must be integers');
  if (
    infra.cacheCapacity > 1000 ||
    infra.refreshConcurrency > 64 ||
    (input.workload.prewarmKeys?.length ?? 0) > 100
  )
    throw new Error('Analysis capacity exceeds alpha bounds');
  let prev = -1;
  for (const row of input.workload.trace ?? []) {
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
  return input;
}
export function selectedOperation(input: DesignInput) {
  return input.systems
    .find((s) => s.id === input.connection.downstreamSystemId)!
    .operations.find((o) => o.id === input.connection.downstreamOperationId)!;
}
