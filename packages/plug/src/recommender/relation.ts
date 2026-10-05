import { compileOperationSchema } from '../contracts/index';
import type {
  Connection,
  DesignInput,
  Evidence,
  JsonObject,
  RelationFact,
  RelationFacts,
} from '../contracts/index';
import { hash } from './policy';
const sum = (...values: (number | null)[]) =>
  values.some((v) => v === null)
    ? null
    : (values as number[]).reduce((a, b) => a + b, 0);
const fact = (
  value: boolean | null,
  reason: string,
  evidence: Evidence[] = [],
): RelationFact => ({ value, reason, evidence });
/** Three-valued conjunction: any false is false, otherwise any unknown is unknown. */
export const and3 = (...values: (boolean | null)[]) =>
  values.includes(false) ? false : values.includes(null) ? null : true;
export function endpoints(input: DesignInput, c: Connection) {
  const caller = input.systems.find((s) => s.id === c.callerSystemId)!,
    downstream = input.systems.find((s) => s.id === c.downstreamSystemId)!;
  const callerOp = caller.operations.find((o) => o.id === c.callerOperationId)!,
    op = downstream.operations.find((o) => o.id === c.downstreamOperationId)!;
  return {
    caller,
    downstream,
    callerOp,
    op,
    callerInterface: caller.interfaces.find(
      (i) => i.id === callerOp.interfaceId,
    )!,
    downstreamInterface: downstream.interfaces.find(
      (i) => i.id === op.interfaceId,
    )!,
  };
}
/** True when explicit mappings cover structured contracts, false when they demonstrably do not, null when contracts are missing or unsupported. */
export function contractCompatibility(
  input: DesignInput,
  c: Connection,
): boolean | null {
  const { caller, downstream, callerOp, op } = endpoints(input, c);
  if (
    !callerOp.inputSchema ||
    !callerOp.outputSchema ||
    !op.inputSchema ||
    !op.outputSchema
  )
    return null;
  try {
    for (const system of [caller, downstream])
      for (const operation of system.operations) {
        const protocol = system.interfaces.find(
          (i) => i.id === operation.interfaceId,
        )!.protocol;
        if (operation.inputSchema)
          compileOperationSchema(operation.inputSchema, protocol);
        if (operation.outputSchema)
          compileOperationSchema(operation.outputSchema, protocol);
      }
  } catch {
    return null;
  }
  const covers = (
    source: JsonObject,
    target: JsonObject,
    m: { from: string; to: string }[],
  ) => {
    const sp = source.properties as Record<string, unknown> | undefined,
      tp = target.properties as Record<string, unknown> | undefined;
    if (!sp || !tp || !m.length) return false;
    return (
      m.every(
        (x) =>
          Object.hasOwn(sp, x.from) &&
          Object.hasOwn(tp, x.to) &&
          hash(sp[x.from]) === hash(tp[x.to]),
      ) &&
      ((target.required as string[]) ?? []).every((k) =>
        m.some((x) => x.to === k),
      )
    );
  };
  return (
    covers(callerOp.inputSchema, op.inputSchema, c.inputMapping) &&
    covers(op.outputSchema, callerOp.outputSchema, c.outputMapping)
  );
}
export function protocolCompatible(input: DesignInput, c: Connection) {
  const { callerInterface: ci, downstreamInterface: di } = endpoints(input, c);
  return (
    ci.direction === 'calls' &&
    di.direction === 'exposes' &&
    ci.protocol === di.protocol &&
    ci.version === di.version &&
    ci.binding === di.binding
  );
}
/** Complete live-path point estimate including adapter overhead; null when any part is unknown. */
export function livePathMs(input: DesignInput, c: Connection) {
  const path = c.remainingPath;
  const adapter = protocolCompatible(input, c)
    ? 0
    : c.adapter?.supplied
      ? c.adapter.overheadMs.value
      : null;
  return sum(
    c.profile.latencyMs.value,
    path.agentMs.value,
    path.networkMs.value,
    path.mappingMs.value,
    path.renderingMs.value,
    adapter,
  );
}
export function deriveRelation(
  input: DesignInput,
  c: Connection,
): RelationFacts {
  const {
    caller,
    downstream,
    callerOp,
    op,
    callerInterface,
    downstreamInterface,
  } = endpoints(input, c);
  const p = c.profile,
    w = c.workload,
    x = c.experience,
    sem = op.semantics,
    infra = input.infrastructure;
  const live = livePathMs(input, c);
  const liveEvidence = [p.latencyMs.evidence, c.remainingPath.agentMs.evidence];
  const compatible = protocolCompatible(input, c);
  const contract = contractCompatibility(input, c);
  const budgets = [x.firstAckMs, x.silenceBudgetMs].filter(
    (b) => b !== undefined,
  );
  const firstResponse = !budgets.length
    ? fact(false, 'No first-acknowledgement or silence budget declared.')
    : budgets.includes(null) || live === null
      ? fact(
          null,
          'The first-response budget or the live-path estimate is unknown.',
          liveEvidence,
        )
      : fact(
          live > Math.min(...(budgets as number[])),
          `Live path ${live} ms compared with first-response budget ${Math.min(...(budgets as number[]))} ms.`,
          liveEvidence,
        );
  const quota =
    p.callsPerMinute.value === null && infra.callBudgetPerMinute === null
      ? null
      : Math.min(
          p.callsPerMinute.value ?? Infinity,
          infra.callBudgetPerMinute ?? Infinity,
        );
  const rate = (value: number | null | undefined, label: string) =>
    value === null || value === undefined || quota === null
      ? fact(null, `${label} or the downstream quota is unknown.`, [
          p.callsPerMinute.evidence,
        ])
      : fact(
          value > quota,
          `${label} ${value}/min compared with available quota ${quota}/min.`,
          [p.callsPerMinute.evidence],
        );
  const availabilityShortfall =
    x.availabilityTarget === undefined
      ? fact(false, 'No availability target declared.')
      : x.availabilityTarget.value === null ||
          p.availability?.value === null ||
          p.availability?.value === undefined
        ? fact(null, 'Downstream availability or the target is unknown.', [
            x.availabilityTarget.evidence,
          ])
        : fact(
            p.availability.value < x.availabilityTarget.value,
            `Downstream availability ${p.availability.value} compared with target ${x.availabilityTarget.value}.`,
            [p.availability.evidence, x.availabilityTarget.evidence],
          );
  const sideEffecting =
    sem.effect === 'unknown'
      ? fact(null, 'The downstream effect is unknown.', [sem.evidence])
      : fact(sem.effect === 'write', `Declared effect: ${sem.effect}.`, [
          sem.evidence,
        ]);
  const unsafeRetry =
    sem.effect === 'read' ||
    sem.idempotent === true ||
    sem.idempotencyKeySupported === true
      ? fact(
          false,
          'Repeating the call is safe: read, idempotent or keyed operation.',
          [sem.evidence],
        )
      : sem.effect === 'write' &&
          sem.idempotent === false &&
          sem.idempotencyKeySupported === false
        ? fact(
            true,
            'A repeated write is neither idempotent nor keyed and can duplicate its effect.',
            [sem.evidence],
          )
        : fact(
            null,
            'Effect, idempotency or idempotency-key support is unknown.',
            [sem.evidence],
          );
  const messaging = downstream.messaging;
  const delivery = messaging?.delivery ?? 'unknown';
  const duplicateDelivery =
    delivery === 'at-least-once'
      ? fact(true, 'At-least-once delivery can redeliver.')
      : delivery === 'at-most-once' || delivery === 'none'
        ? fact(false, `Declared delivery: ${delivery}.`)
        : fact(
            null,
            delivery === 'exactly-once-claimed'
              ? 'Exactly-once delivery is a claim to prove, not an established fact.'
              : 'Delivery semantics are unknown.',
          );
  const forbidden =
    x.duplicateEffectForbidden === undefined
      ? true
      : x.duplicateEffectForbidden;
  const duplicateEffect = and3(
    duplicateDelivery.value,
    sideEffecting.value,
    forbidden,
  );
  const lostForbidden =
    x.lostRequestAllowed === undefined
      ? true
      : x.lostRequestAllowed === null
        ? null
        : !x.lostRequestAllowed;
  const callerEffect = callerOp.semantics.effect;
  const atomicPublish = and3(
    callerEffect === 'unknown' ? null : callerEffect === 'write',
    delivery === 'unknown' ? null : delivery !== 'none',
    lostForbidden,
  );
  const ordering = x.orderingRequired ?? 'none';
  const channelOrdering = messaging?.ordering ?? 'unknown';
  const orderingGap =
    ordering === 'none'
      ? fact(false, 'No ordering requirement declared.')
      : ordering === 'unknown'
        ? fact(null, 'The ordering requirement is unknown.')
        : delivery === 'none'
          ? fact(
              false,
              'Synchronous request-reply answers each request in caller order.',
            )
          : delivery === 'unknown' || channelOrdering === 'unknown'
            ? fact(null, 'Channel ordering is unknown.')
            : fact(
                ordering === 'global'
                  ? channelOrdering !== 'global'
                  : channelOrdering === 'none',
                `Required ${ordering} ordering; channel provides ${channelOrdering}.`,
              );
  const interaction = op.interaction;
  const laterResult = !interaction
    ? fact(null, 'Callback, polling and streaming support are undeclared.')
    : interaction.callback === true ||
        interaction.polling === true ||
        ['server', 'bidi'].includes(interaction.streaming)
      ? fact(
          true,
          'A callback, polling resource or result stream is available.',
        )
      : interaction.callback === false &&
          interaction.polling === false &&
          interaction.streaming === 'none'
        ? fact(false, 'No callback, polling resource or result stream exists.')
        : fact(null, 'Some later-result mechanisms are unknown.');
  const domains = [caller.trustDomain, downstream.trustDomain];
  return {
    protocolCompatible: fact(
      compatible,
      compatible
        ? 'Caller calls the exposed protocol, version and binding.'
        : `Caller ${callerInterface.direction} ${callerInterface.protocol} ${callerInterface.version} ${callerInterface.binding}; downstream ${downstreamInterface.direction} ${downstreamInterface.protocol} ${downstreamInterface.version} ${downstreamInterface.binding}.`,
    ),
    contractCompatible: fact(
      contract,
      contract === null
        ? 'Structured contracts are missing or use an unsupported dialect.'
        : contract
          ? 'Explicit mappings cover both structured contracts.'
          : 'Explicit mappings do not cover the structured contracts.',
    ),
    semanticMatch: fact(
      sem.outputMeaning === null ? null : sem.outputMeaning === x.usefulOutput,
      sem.outputMeaning === null
        ? 'The downstream output meaning is unknown.'
        : `Output "${sem.outputMeaning}" compared with required "${x.usefulOutput}".`,
      [sem.evidence],
    ),
    deadlineRisk: fact(
      live === null ? null : live > x.latencyTargetMs,
      live === null
        ? 'The live-path estimate is unknown.'
        : `Live path ${live} ms compared with useful-output target ${x.latencyTargetMs} ms.`,
      liveEvidence,
    ),
    firstResponseGap: firstResponse,
    capacityMismatch: rate(w.requestsPerMinute.value, 'Request rate'),
    burstMismatch: rate(w.burstPerMinute?.value, 'Burst rate'),
    availabilityShortfall,
    sideEffecting,
    unsafeRetry,
    duplicateDeliveryPossible: duplicateDelivery,
    duplicateEffectRisk: fact(
      duplicateEffect,
      duplicateEffect === false
        ? 'No redelivered side effect, or duplicates are declared acceptable.'
        : duplicateEffect
          ? 'Redelivery can repeat a forbidden side effect.'
          : 'Whether redelivery can repeat a side effect is unknown.',
      [sem.evidence],
    ),
    atomicPublishRequired: fact(
      atomicPublish,
      atomicPublish === false
        ? 'The caller does not need to update state and publish atomically.'
        : atomicPublish
          ? 'The caller writes local state and must deliver a message that may not be lost.'
          : 'Caller effect, channel or loss tolerance is unknown.',
      [callerOp.semantics.evidence],
    ),
    orderingGap,
    globalOrderingRequired: fact(
      ordering === 'unknown' ? null : ordering === 'global',
      `Ordering requirement: ${ordering}.`,
    ),
    laterResultPath: laterResult,
    deferredAllowed: fact(
      x.allowDeferred,
      x.allowDeferred
        ? 'The experience permits a later result.'
        : 'The experience does not permit a later result.',
    ),
    trustBoundaryCrossed: domains.some((d) => d === undefined || d === null)
      ? fact(null, 'A trust domain is undeclared.')
      : fact(
          domains[0] !== domains[1],
          `Trust domains ${domains[0]} and ${domains[1]}.`,
        ),
  };
}
