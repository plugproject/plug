import {
  selectedOperation,
  validateInput,
  compileOperationSchema,
} from '../contracts/index';
import type {
  Candidate,
  Criterion,
  DesignInput,
  DesignRecommendation,
  Evidence,
  Fact,
  RunnerConfig,
} from '../contracts/index';
import {
  catalog,
  catalogVersion,
  cached,
  scheduled,
  intervals,
} from '../patterns/catalog';
import { exactKey, hash, makeSchedule, replayCoverage } from './policy';
import { flightInput } from '../demo/flight';
const unknown: Evidence = {
  kind: 'unknown',
  note: 'Not supplied; no guarantee inferred.',
};
const sum = (...values: (number | null)[]) =>
  values.some((v) => v === null)
    ? null
    : (values as number[]).reduce((a, b) => a + b, 0);
function mappingKnown(input: DesignInput): boolean {
  const c = input.connection,
    caller = input.systems
      .find((s) => s.id === c.callerSystemId)!
      .operations.find((o) => o.id === c.callerOperationId)!,
    down = selectedOperation(input);
  if (
    !caller.inputSchema ||
    !caller.outputSchema ||
    !down.inputSchema ||
    !down.outputSchema
  )
    return false;
  try {
    for (const system of input.systems)
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
    return false;
  }
  const covers = (
    source: Record<string, unknown>,
    target: Record<string, unknown>,
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
    covers(caller.inputSchema, down.inputSchema, c.inputMapping) &&
    covers(down.outputSchema, caller.outputSchema, c.outputMapping)
  );
}
export function suggestDesign(raw: unknown): DesignRecommendation {
  const input = validateInput(raw),
    op = selectedOperation(input),
    sem = op.semantics,
    p = input.profile,
    w = input.workload,
    x = input.experience,
    infra = input.infrastructure,
    path = input.remainingPath;
  const c = input.connection,
    caller = input.systems.find((s) => s.id === c.callerSystemId)!,
    down = input.systems.find((s) => s.id === c.downstreamSystemId)!;
  const callerOp = caller.operations.find((o) => o.id === c.callerOperationId)!;
  const ci = caller.interfaces.find((i) => i.id === callerOp.interfaceId)!,
    di = down.interfaces.find((i) => i.id === op.interfaceId)!;
  const metadataKnown =
    di.protocol === 'http' ||
    (di.protocol === 'mcp' && di.version === '2025-11-25') ||
    (di.protocol === 'a2a' && di.version === '1.0');
  const compatible =
    ci.direction === 'calls' &&
    di.direction === 'exposes' &&
    ci.protocol === di.protocol &&
    ci.version === di.version &&
    ci.binding === di.binding;
  const adapter = compatible
    ? 0
    : c.adapter?.supplied
      ? c.adapter.overheadMs.value
      : null;
  const remaining = sum(
    path.agentMs.value,
    path.networkMs.value,
    path.mappingMs.value,
    path.renderingMs.value,
    adapter,
  );
  const live = sum(p.latencyMs.value, remaining),
    fast = sum(path.cacheLookupMs.value, remaining);
  const evidence = (...facts: Fact[]) => facts.map((f) => f.evidence);
  const keys = w.prewarmKeys ?? [],
    n = keys.length,
    D = p.timeoutMs.value,
    J = infra.schedulingAllowanceMs.value,
    L = p.sourceLagMs.value,
    U = path.deliveryAllowanceMs.value;
  const availableQuota = Math.min(
    p.callsPerMinute.value ?? Infinity,
    infra.callBudgetPerMinute ?? Infinity,
  );
  const keyValid =
    sem.keysComplete === true &&
    sem.keyDimensions.length > 0 &&
    sem.scope !== 'unknown' &&
    [...keys, ...(w.trace ?? []).map((t) => t.key)].every((k) => {
      try {
        exactKey(k, sem.keyDimensions, sem.scope);
        return true;
      } catch {
        return false;
      }
    });
  const contractsKnown = mappingKnown(input);
  const candidates: Candidate[] = catalog.map((template) => {
    const id = template.id,
      isCache = cached(id),
      isScheduled = scheduled(id),
      progress = id === 'progressive' || id === 'cached-live';
    const criteria: Criterion[] = [];
    const add = (
      id: string,
      ok: boolean | null,
      reason: string,
      actual: number | string | null = null,
      required: number | string | null = null,
      ev: Evidence[] = [unknown],
    ) =>
      criteria.push({
        id,
        verdict:
          ok === null ? 'unknown' : ok ? 'pass_under_assumptions' : 'fail',
        reason,
        actual,
        required,
        evidence: ev,
      });
    add(
      'metadata-version',
      metadataKnown ? true : null,
      'Metadata semantics are evaluated only for pinned protocol versions.',
    );
    add(
      'contract',
      contractsKnown ? true : null,
      'Explicit top-level input/output mappings and structured operation schemas are required. Nested conversions require an adapter.',
    );
    add(
      'interface',
      compatible || !!c.adapter?.supplied
        ? adapter === null
          ? null
          : true
        : null,
      compatible
        ? 'Caller can invoke the exposed protocol and version.'
        : 'ADAPTER_REQUIRED: supply a conversion and measured overhead; exposing a protocol does not imply calling it.',
      adapter,
      'known adapter overhead',
    );
    const outputMeaning =
      id === 'progressive'
        ? (x.initialOutput?.meaning ?? null)
        : sem.outputMeaning;
    add(
      'semantics',
      outputMeaning === null ? null : outputMeaning === x.usefulOutput,
      'The operation must produce the requested useful output; names, progress acknowledgements and skill prose cannot establish equivalence.',
      outputMeaning,
      x.usefulOutput,
      [sem.evidence],
    );
    let interval: number | null = null,
      schedule: RunnerConfig['schedule'] = [],
      envelope: number | null = null;
    let hit: number | null = null,
      calls: number | null,
      coverageEvidence: Evidence[] = [unknown];
    const assumptions = [
      'Latency sums are point estimates, not an end-to-end percentile.',
      'Declared and synthetic facts need representative production validation.',
    ];
    const tradeoffs: string[] = [];
    if (isCache) {
      add(
        'read-only',
        sem.effect === 'unknown' ? null : sem.effect === 'read',
        'Only declared reads may enter a cache.',
        sem.effect,
        'read',
        [sem.evidence],
      );
      add(
        'permission',
        sem.cachePermission === null
          ? null
          : sem.cachePermission && infra.cacheAllowed,
        'Both source permission and allowed infrastructure must permit caching.',
        String(sem.cachePermission),
        'true',
        [sem.evidence],
      );
      add(
        'correctness',
        x.correctness === 'indicative' && x.allowIndicative,
        'Cached indicative results cannot substitute for a required live result.',
        x.correctness,
        'indicative',
      );
      add(
        'key-scope',
        sem.scope === 'unknown' || sem.keysComplete === null ? null : keyValid,
        'Every output-changing dimension and user/tenant identity must form the exact key.',
        sem.scope,
        'known complete scope',
        [sem.evidence],
      );
      add(
        'age-bound',
        x.maxAgeMs === null ||
          D === null ||
          L === null ||
          U === null ||
          p.sourceTimestamp === 'unknown'
          ? null
          : D + L + U <= x.maxAgeMs,
        'Fetch duration, source lag and delivery allowance must fit the accepted result age.',
        sum(D, L, U),
        x.maxAgeMs,
        evidence(p.timeoutMs, p.sourceLagMs, path.deliveryAllowanceMs),
      );
      const storage =
        p.responseBytes.value === null ? null : p.responseBytes.value * n;
      add(
        'storage',
        storage === null
          ? null
          : infra.cacheCapacity >= n &&
              infra.cacheCapacity > 0 &&
              storage <= infra.memoryBytes,
        'Pinned exact-key entries must fit cache capacity and memory.',
        storage,
        infra.memoryBytes,
        evidence(p.responseBytes),
      );
      if (isScheduled) {
        add(
          'scheduling',
          infra.schedulingAllowed,
          'The design introduces a scheduler and requires permission.',
        );
        add(
          'enumerable-keys',
          w.prewarmKeys === null ? null : n > 0 && keyValid,
          'Scheduled work requires explicitly enumerable exact keys.',
          n,
          'nonempty exact keys',
        );
        if (
          D !== null &&
          J !== null &&
          L !== null &&
          U !== null &&
          x.maxAgeMs !== null &&
          p.concurrency.value !== null &&
          n
        ) {
          const feasible = intervals.flatMap((I) => {
            if (
              I + D + J + L + U > x.maxAgeMs! ||
              (60000 * n) / I + infra.foregroundReserveCallsPerMinute >
                availableQuota
            )
              return [];
            const s = makeSchedule(
              keys,
              I,
              D + J,
              Math.min(infra.refreshConcurrency, p.concurrency.value!),
            );
            return s ? [{ I, s }] : [];
          });
          const heuristic = feasible.filter(
            (f) =>
              p.changeIntervalMs.value === null ||
              f.I <= p.changeIntervalMs.value / 2,
          );
          const chosen = (heuristic.length ? heuristic : feasible).at(-1);
          if (chosen) {
            interval = chosen.I;
            schedule = chosen.s;
            envelope = interval + D + J + L + U;
          }
          if (
            chosen &&
            p.changeIntervalMs.value !== null &&
            chosen.I > p.changeIntervalMs.value / 2
          )
            tradeoffs.push(
              'Capacity prevents the half-change-interval preference; the hard age envelope still holds.',
            );
          add(
            'refresh-schedule',
            !!chosen,
            'Deterministic evenly spaced cyclic starts must meet age, per-key nonoverlap, quota and concurrency.',
            interval,
            'feasible interval',
            evidence(
              p.timeoutMs,
              p.callsPerMinute,
              p.concurrency,
              infra.schedulingAllowanceMs,
            ),
          );
        } else
          add(
            'refresh-schedule',
            null,
            'Supply duration, source lag, delivery, queue allowance and concurrency bounds to derive a schedule.',
          );
        assumptions.push(
          'Successful refreshes obey I + D + J + L + U ≤ maximum age; failures reduce usable coverage.',
          'Half the typical change interval is a soft cadence heuristic, never a correctness guarantee.',
        );
      }
      tradeoffs.push(
        'Restart begins cold; cold, expired and unenumerated requests may miss the latency target.',
        'An entry keeps its original source timestamp after failed refreshes.',
      );
      if (sem.requiresLiveValidation)
        tradeoffs.push(
          'Live revalidation is required before commitment. Booking and payment execution are outside the demo.',
        );
    }
    if (progress) {
      add(
        'deferred',
        x.allowDeferred,
        'The experience must permit a useful initial result followed by a live result.',
      );
      add(
        'final-deadline',
        x.finalDeadlineMs === null || live === null
          ? null
          : live <= x.finalDeadlineMs,
        'Live completion must fit the declared final deadline (point estimate).',
        live,
        x.finalDeadlineMs,
        evidence(p.latencyMs),
      );
      if (id === 'progressive')
        add(
          'initial-useful',
          x.initialOutput === null
            ? null
            : x.initialOutput.useful &&
                x.initialOutput.meaning === x.usefulOutput,
          'An identified initial output must itself satisfy the useful-output requirement. A spinner is insufficient.',
          x.initialOutput?.meaning ?? null,
          x.usefulOutput,
          x.initialOutput ? [x.initialOutput.evidence] : [unknown],
        );
    }
    const useful =
      id === 'progressive'
        ? sum(x.initialOutput?.latencyMs.value ?? null, remaining)
        : isCache
          ? fast
          : live;
    add(
      'latency-estimate',
      useful === null ? null : useful <= x.latencyTargetMs,
      'Complete-path point estimate including adapter, agent, mapping, network and rendering.',
      useful,
      x.latencyTargetMs,
      evidence(
        p.latencyMs,
        path.agentMs,
        path.networkMs,
        path.mappingMs,
        path.renderingMs,
        path.cacheLookupMs,
      ),
    );
    const config: RunnerConfig = {
      formatVersion: '0.1-alpha.2',
      pattern: id,
      scope: sem.scope,
      keyDimensions: sem.keyDimensions,
      maxAgeMs: x.maxAgeMs,
      deliveryAllowanceMs: U,
      capacity: infra.cacheCapacity,
      maxBytes: infra.memoryBytes,
      refreshIntervalMs: interval,
      schedule,
      prewarmKeys: keys,
      concurrency: p.concurrency.value ?? 0,
      refreshConcurrency: infra.refreshConcurrency,
      callsPerMinute:
        p.callsPerMinute.value === null && infra.callBudgetPerMinute === null
          ? null
          : availableQuota,
      foregroundReserveCallsPerMinute: infra.foregroundReserveCallsPerMinute,
      timeoutMs: D,
      sourceLagMs: L,
      sourceTimestamp: p.sourceTimestamp,
      missPolicy: x.allowSlowMiss ? 'slow' : 'target-unmet',
      failurePolicy: 'serve-only-within-age',
      latencyTargetMs: x.latencyTargetMs,
      finalDeadlineMs: x.finalDeadlineMs,
    };
    const policyHash = hash(config);
    if (isCache && keyValid) {
      if (w.usableHitObservation?.policyHash === policyHash) {
        hit = w.usableHitObservation.hitRate.value;
        coverageEvidence = [w.usableHitObservation.hitRate.evidence];
      } else if (D !== null && (!isScheduled || interval !== null)) {
        hit = replayCoverage(config, w, D);
        coverageEvidence = [w.traceEvidence];
      }
      if (hit !== null && w.hotKeyShare.value !== null)
        hit = Math.min(hit, w.hotKeyShare.value);
    }
    const hitFraction =
      x.hitsWithinTargetMs <= x.latencyTargetMs
        ? x.hitsWithinTarget.value
        : null;
    const success =
      hit === null || hitFraction === null ? null : hit * hitFraction;
    if (isCache) {
      if (x.scope === 'trafficPercentile')
        add(
          'traffic-slo',
          success === null ? null : success >= x.targetPercentile,
          'Usable-hit replay × separately supplied within-target hit fraction; hot-key share is only a ceiling.',
          success,
          x.targetPercentile,
          [...coverageEvidence, x.hitsWithinTarget.evidence],
        );
      else if (x.scope === 'everyRequest')
        add(
          'every-request',
          false,
          'Cold starts and expired entries prevent an every-request guarantee with this bounded cache.',
          null,
          'every request',
        );
      else
        add(
          'warm-hit-slo',
          hitFraction === null ? null : hitFraction >= x.targetPercentile,
          'Warm-hit evidence applies only to eligible hits.',
          x.hitsWithinTarget.value,
          x.targetPercentile,
          [x.hitsWithinTarget.evidence],
        );
      assumptions.push(
        'Replay assumes successful bounded source calls, no restarts, and this exact pinned-key policy. It is synthetic, not an observed production hit rate.',
      );
    } else {
      const suppliedEvidence =
        id === 'progressive'
          ? x.initialOutput?.withinTarget
          : x.directWithinTarget;
      const observed =
        suppliedEvidence && suppliedEvidence.thresholdMs <= x.latencyTargetMs
          ? suppliedEvidence.fraction
          : null;
      const bound = x.completePathBoundMs;
      const ok =
        x.scope === 'everyRequest'
          ? bound?.value == null
            ? null
            : bound.value <= x.latencyTargetMs
          : observed?.value == null
            ? null
            : observed.value >= x.targetPercentile;
      add(
        'complete-path-slo',
        useful !== null && useful > x.latencyTargetMs ? false : ok,
        'Require independent end-to-end evidence at this target; component sums do not establish a percentile or every-request bound.',
        x.scope === 'everyRequest'
          ? (bound?.value ?? null)
          : (observed?.value ?? null),
        x.scope === 'everyRequest' ? x.latencyTargetMs : x.targetPercentile,
        [observed?.evidence ?? bound?.evidence ?? unknown],
      );
    }
    const requestRate = w.requestsPerMinute.value;
    if (isScheduled)
      calls =
        interval === null || hit === null || requestRate === null
          ? null
          : (60000 * n) / interval +
            Math.max(
              infra.foregroundReserveCallsPerMinute,
              requestRate * (1 - hit),
            );
    else if (id === 'cached-live' || id === 'direct' || id === 'progressive')
      calls = requestRate;
    else
      calls =
        hit === null || requestRate === null ? null : requestRate * (1 - hit);
    add(
      'quota',
      calls === null || p.callsPerMinute.value === null
        ? null
        : calls <= availableQuota,
      'Scheduled calls plus foreground/miss/live traffic must fit shared quota and call budget.',
      calls,
      Number.isFinite(availableQuota) ? availableQuota : null,
      evidence(p.callsPerMinute, w.requestsPerMinute),
    );
    add(
      'concurrency-load',
      calls === null || D === null || p.concurrency.value === null
        ? null
        : (calls * D) / 60000 <= p.concurrency.value,
      'Necessary mean load check; exact cyclic schedule and bounded source admission also apply.',
      calls === null || D === null ? null : (calls * D) / 60000,
      p.concurrency.value,
      evidence(p.timeoutMs, p.concurrency),
    );
    const cost =
      calls === null || p.callCost.value === null
        ? null
        : calls * p.callCost.value;
    const essential = [
      'semantics',
      'key-scope',
      'read-only',
      'permission',
      'contract',
    ];
    const status = criteria.some((r) => r.verdict === 'fail')
      ? 'infeasible'
      : criteria.some(
            (r) => r.verdict === 'unknown' && essential.includes(r.id),
          )
        ? 'insufficient_information'
        : criteria.some((r) => r.verdict === 'unknown')
          ? 'conditional'
          : 'feasible_under_declared_assumptions';
    const tasks = isCache
      ? [
          'Verify source cache permission, correctness, scope and all key dimensions.',
          'Place a bounded exact-key cache between the existing caller and source.',
          'Validate the response envelope and output schema; preserve source snapshot time and provenance.',
          ...(isScheduled
            ? [
                'Start the exported per-key schedule; reserve foreground quota and prevent overlap.',
              ]
            : []),
          'Coalesce fills per key; enforce age including delivery allowance on every read.',
          'Integrate the explicit slow/target-unmet miss path and expose data age.',
          ...(progress
            ? [
                'Deliver eligible initial options, then live refresh before the final deadline.',
              ]
            : []),
          'Keep live revalidation at commitment; never use indicative fares as booking confirmation.',
          'Measure cold starts, usable coverage, complete-path latency, failures and restarts under representative traffic.',
        ]
      : [
          'Connect the mapped operations through the stated interface/adapter.',
          ...(progress
            ? [
                'Implement the identified useful initial output and final deadline.',
              ]
            : []),
          'Validate outputs, enforce timeout/cancellation, and measure the complete path.',
        ];
    const diagram = isScheduled
      ? 'flowchart LR\n  A[Existing caller] --> C[Introduced exact-key cache]\n  C --> U[Indicative output + age]\n  S[Introduced scheduler] --> B[Existing slow source]\n  B --> C\n  C -. miss / expiry .-> B\n  U -. commitment .-> V[Live revalidation]'
      : isCache
        ? 'flowchart LR\n  A[Existing caller] --> C[Introduced exact-key cache]\n  C --> U[Eligible output + age]\n  C -. miss / live refresh .-> B[Existing source]\n  B --> C'
        : progress
          ? 'flowchart LR\n  A[Existing caller] --> I[Useful initial output]\n  A --> B[Existing source]\n  B --> F[Later live result]'
          : 'flowchart LR\n  A[Existing caller] --> B[Existing source]\n  B --> U[Useful output]';
    return {
      ...template,
      status,
      criteria,
      diagram,
      config,
      policyHash,
      estimates: {
        usefulLatencyMs: useful,
        liveLatencyMs: live,
        ageEnvelopeMs: envelope,
        callsPerMinute: calls,
        storageBytes:
          isCache && p.responseBytes.value !== null
            ? p.responseBytes.value * n
            : null,
        usableHitRate: hit,
        trafficSuccessRate: success,
        coldStartMs: D,
        costPerMinute: cost,
      },
      metadataUnderstood: metadataKnown,
      designEvaluated: true,
      executableHere:
        hash(input) === hash(flightInput()) &&
        id !== 'progressive' &&
        (id !== 'cached-live' || x.allowDeferred),
      prerequisites: criteria
        .filter((r) => r.verdict === 'unknown')
        .map((r) => r.reason),
      assumptions,
      tradeoffs,
      tasks,
    };
  });
  const costRankingAvailable = candidates.every(
    (c) => c.estimates.costPerMinute !== null,
  );
  const order = {
    feasible_under_declared_assumptions: 0,
    conditional: 1,
    insufficient_information: 2,
    infeasible: 3,
  };
  candidates.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (input.preference === 'latency'
        ? (a.estimates.usefulLatencyMs ?? Infinity) -
          (b.estimates.usefulLatencyMs ?? Infinity)
        : input.preference === 'cost' && costRankingAvailable
          ? a.estimates.costPerMinute! - b.estimates.costPerMinute!
          : 0) ||
      a.components.length - b.components.length ||
      (a.id < b.id ? -1 : 1),
  );
  const result = {
    formatVersion: input.formatVersion,
    catalogVersion,
    catalogHash: hash({ catalog, intervals, catalogVersion }),
    inputHash: hash(input),
    selectedId:
      candidates.find((c) => c.status === 'feasible_under_declared_assumptions')
        ?.id ?? null,
    candidates,
    missingInformation: [
      ...new Set(
        candidates
          .filter((c) => c.status !== 'infeasible')
          .flatMap((c) => c.prerequisites),
      ),
    ],
    costRankingAvailable,
  };
  return { ...result, designHash: hash(result) };
}
export function explainDesign(report: DesignRecommendation): string {
  return (
    `# Plug design report\n\nFormat: ${report.formatVersion}\nCatalog: ${report.catalogVersion} (${report.catalogHash})\nInput: ${report.inputHash}\nDesign: ${report.designHash}\n\nSelected: ${report.selectedId ?? 'No feasible candidate under supplied facts and supported catalog'}\n\nCost ranking: ${report.costRankingAvailable ? 'available' : 'unavailable; missing cost is not zero'}\n\n` +
    report.candidates
      .map(
        (c) =>
          `## ${c.title}\n\nStatus: ${c.status}\n\n\`\`\`mermaid\n${c.diagram}\n\`\`\`\n\n` +
          c.criteria
            .map(
              (r) =>
                `- ${r.id}: ${r.verdict}. ${r.reason} Compared ${r.actual ?? 'unknown'} with ${r.required ?? 'unspecified'}. Evidence: ${r.evidence.map((e) => e.kind).join(', ')}.`,
            )
            .join('\n') +
          `\n\n### Configuration\n\n\`\`\`json\n${JSON.stringify(c.config, null, 2)}\n\`\`\`\n\n### Estimates (not measurements)\n\n\`\`\`json\n${JSON.stringify(c.estimates, null, 2)}\n\`\`\`\n\n### Implementation\n\n` +
          c.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') +
          '\n\n' +
          [...c.assumptions, ...c.tradeoffs, ...c.prerequisites]
            .map((t) => `- ${t}`)
            .join('\n'),
      )
      .join('\n\n')
  );
}
