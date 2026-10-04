import { createHash } from 'node:crypto';
import type { ExactKey, RunnerConfig, Workload } from '../contracts/index';
import { scheduled } from '../patterns/catalog';
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
export function exactKey(
  key: ExactKey,
  dimensions: string[],
  scope: string,
): string {
  if (
    !dimensions.length ||
    dimensions.some((d) => key[d] === undefined) ||
    Object.keys(key).some((d) => !dimensions.includes(d))
  )
    throw new Error(
      'Key must include exactly every declared output-changing dimension',
    );
  if (
    scope === 'unknown' ||
    (scope === 'user' && !dimensions.includes('userId')) ||
    (scope === 'tenant' && !dimensions.includes('tenantId'))
  )
    throw new Error('Explicit scope dimension required');
  return stable({ scope, key });
}
/** Evenly spaced starts; verify the cyclic overlap bound, including wraparound. */
export function makeSchedule(
  keys: ExactKey[],
  interval: number,
  duration: number,
  concurrency: number,
) {
  if (!keys.length || interval < duration || concurrency < 1) return null;
  const offsets = keys.map((key, i) => ({
    key,
    offsetMs: Math.floor((i * interval) / keys.length),
  }));
  const events: { at: number; delta: number }[] = [];
  for (let cycle = -1; cycle <= 1; cycle++)
    for (const row of offsets) {
      events.push(
        { at: cycle * interval + row.offsetMs, delta: 1 },
        { at: cycle * interval + row.offsetMs + duration, delta: -1 },
      );
    }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  for (const e of events) {
    active += e.delta;
    if (e.at >= 0 && e.at < interval && active > concurrency) return null;
  }
  return offsets;
}
/** Deterministic event replay: no wall clock, pre-seeding, or scheduled benefit for cache-aside. */
export function replayCoverage(
  config: RunnerConfig,
  workload: Workload,
  duration: number,
): number | null {
  if (
    !workload.trace?.length ||
    workload.traceEvidence.kind === 'unknown' ||
    config.maxAgeMs === null ||
    config.deliveryAllowanceMs === null ||
    config.sourceLagMs === null
  )
    return null;
  const trace = workload.trace,
    end = trace.at(-1)!.atMs;
  const allowed = new Set(
    config.prewarmKeys.map((k) =>
      exactKey(k, config.keyDimensions, config.scope),
    ),
  );
  const entries = new Map<string, { snapshot: number; used: number }>();
  const inflight = new Map<
    string,
    { done: number; snapshot: number; store: boolean }
  >();
  const starts: number[] = [];
  let hits = 0,
    total = 0;
  const events: { at: number; key: ExactKey; kind: 'refresh' | 'request' }[] =
    trace.map((r) => ({ ...r, at: r.atMs, kind: 'request' }));
  if (scheduled(config.pattern) && config.refreshIntervalMs) {
    for (const key of config.prewarmKeys)
      events.push({ at: 0, key, kind: 'refresh' });
    for (const s of config.schedule)
      for (
        let at = s.offsetMs || config.refreshIntervalMs;
        at <= end;
        at += config.refreshIntervalMs
      ) {
        if (events.length >= 20000) return null;
        events.push({ at, key: s.key, kind: 'refresh' });
      }
  }
  events.sort((a, b) => a.at - b.at || (a.kind === 'refresh' ? -1 : 1));
  const fill = (k: string, at: number, refresh: boolean) => {
    if (inflight.has(k) || inflight.size >= config.concurrency) return;
    if (refresh && inflight.size >= config.refreshConcurrency) return;
    while (starts.length && starts[0] <= at - 60000) starts.shift();
    if (
      config.callsPerMinute !== null &&
      starts.length >=
        config.callsPerMinute -
          (refresh ? config.foregroundReserveCallsPerMinute : 0)
    )
      return;
    starts.push(at);
    inflight.set(k, {
      done: at + duration,
      snapshot: at - config.sourceLagMs!,
      store: refresh || config.pattern !== 'scheduled-cache',
    });
  };
  for (const e of events) {
    for (const [k, f] of inflight)
      if (f.done <= e.at) {
        inflight.delete(k);
        if (f.store && allowed.has(k)) {
          if (!entries.has(k) && entries.size >= config.capacity) {
            const oldest = [...entries].sort(
              (a, b) => a[1].used - b[1].used,
            )[0];
            if (oldest) entries.delete(oldest[0]);
          }
          if (config.capacity > 0)
            entries.set(k, { snapshot: f.snapshot, used: f.done });
        }
      }
    const k = exactKey(e.key, config.keyDimensions, config.scope);
    if (e.kind === 'refresh') {
      fill(k, e.at, true);
      continue;
    }
    const entry = entries.get(k),
      hit =
        !!entry &&
        e.at - entry.snapshot + config.deliveryAllowanceMs <= config.maxAgeMs;
    if (e.at >= workload.measurementStartMs) {
      total++;
      if (hit) hits++;
    }
    if (hit) entry!.used = e.at;
    if (
      (!hit &&
        config.missPolicy === 'slow' &&
        config.pattern !== 'scheduled-cache') ||
      config.pattern === 'cached-live'
    )
      fill(k, e.at, false);
    else if (!hit && config.missPolicy === 'slow') fill(k, e.at, false);
    // Scheduled-only miss calls do not fill hot entries; discard at completion.
    if (config.pattern === 'scheduled-cache' && !hit && !allowed.has(k))
      allowed.delete(k);
  }
  return total ? hits / total : null;
}
