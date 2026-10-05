import { assertContract, compileOperationSchema } from '../contracts/index';
import type {
  Candidate,
  DemoEvent,
  ExactKey,
  JsonObject,
  SourceResponse,
} from '../contracts/index';
import { cached, scheduled } from '../patterns/catalog';
import { exactKey } from '../recommender/policy';
export interface DemoOptions {
  /** Explicit trusted local binding; never populated from a submitted descriptor. */
  endpoint: string;
  outputSchema: JsonObject;
  inputSchema?: JsonObject;
  onEvent: (event: DemoEvent) => void;
  signal?: AbortSignal;
  /** Null is an explicit trusted-local continuous service; hosted API never accepts it. */
  lifetimeMs?: number | null;
  callCost?: number | null;
  onTerminal?: (reason: string) => void;
}
export function runDemo(design: Candidate, options: DemoOptions) {
  const config = design.config;
  const required = cached(config.pattern)
    ? [
        'read-only',
        'permission',
        'correctness',
        'key-scope',
        'contract',
        'interface',
      ]
    : ['contract', 'interface'];
  if (
    required.some(
      (id) =>
        design.criteria.find((c) => c.id === id)?.verdict !==
        'pass_under_assumptions',
    )
  )
    throw new Error(
      'Execution requires verified semantics, permission, scope, contracts and interface',
    );
  if (
    config.pattern === 'cached-live' &&
    design.criteria.find((c) => c.id === 'deferred')?.verdict !==
      'pass_under_assumptions'
  )
    throw new Error('Live updates are not permitted by this experience');
  assertContract('RunnerConfig', config);
  const url = new URL(options.endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Execution requires an explicitly trusted loopback HTTP binding',
    );
  if (
    config.timeoutMs === null ||
    config.timeoutMs <= 0 ||
    config.timeoutMs > 86400000 ||
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 2 ||
    config.capacity > 2 ||
    config.maxBytes > 1048576
  )
    throw new Error(
      'Runner requires a bounded timeout, one/two calls, two entries and at most 1 MB',
    );
  if (
    cached(config.pattern) &&
    (config.maxAgeMs === null ||
      config.deliveryAllowanceMs === null ||
      config.sourceLagMs === null ||
      config.sourceTimestamp === 'unknown')
  )
    throw new Error('Cache execution requires source-age and delivery bounds');
  if (config.pattern === 'progressive')
    throw new Error(
      'Independent useful-output execution is not supported by this runner',
    );
  const validate = compileOperationSchema(options.outputSchema),
    validateInput = options.inputSchema
      ? compileOperationSchema(options.inputSchema)
      : null;
  const entries = new Map<
    string,
    { response: SourceResponse; fetchedAt: number; bytes: number }
  >();
  const admittedKeys = new Set(
    config.prewarmKeys.map((k) =>
      exactKey(k, config.keyDimensions, config.scope),
    ),
  );
  const inflight = new Map<string, Promise<SourceResponse>>(),
    controllers = new Set<AbortController>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const starts: number[] = [];
  let active = 0,
    refreshActive = 0,
    ended = false,
    usedBytes = 0;
  function emit(
    type: DemoEvent['type'],
    message: string,
    details: Partial<DemoEvent> = {},
  ) {
    if (!ended)
      options.onEvent({
        formatVersion: '0.2-alpha.1',
        type,
        atMs: Date.now(),
        message,
        ...details,
      });
  }
  function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!ended) fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function stop(reason = 'cancelled') {
    if (ended) return;
    ended = true;
    options.onEvent({
      formatVersion: '0.2-alpha.1',
      type: 'sandbox-termination',
      atMs: Date.now(),
      message: reason,
    });
    timers.forEach(clearTimeout);
    timers.clear();
    controllers.forEach((c) => c.abort());
    controllers.clear();
    entries.clear();
    inflight.clear();
    usedBytes = 0;
    options.signal?.removeEventListener('abort', abort);
    options.onTerminal?.(reason);
  }
  const abort = () => stop('cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  function source(
    key: ExactKey,
    refresh: boolean,
    fill: boolean,
    actionId?: string,
  ): Promise<SourceResponse> {
    if (ended) return Promise.reject(new Error('Sandbox terminated'));
    let k: string;
    try {
      k = cached(config.pattern)
        ? exactKey(key, config.keyDimensions, config.scope)
        : JSON.stringify(key);
      if (validateInput && !validateInput(key))
        throw new Error('Input contract validation failed');
    } catch (e) {
      return Promise.reject(e);
    }
    const existing = inflight.get(k);
    if (existing) return existing;
    const now = Date.now();
    while (starts.length && starts[0] <= now - 60000) starts.shift();
    const quota = config.callsPerMinute === null ? 6 : config.callsPerMinute;
    if (
      active >= config.concurrency ||
      (refresh && refreshActive >= config.refreshConcurrency) ||
      starts.length >=
        quota - (refresh ? config.foregroundReserveCallsPerMinute : 0)
    )
      return Promise.reject(
        new Error('Source admission capacity exhausted; no queue'),
      );
    active++;
    if (refresh) refreshActive++;
    starts.push(now);
    emit(
      'source-start',
      'Upstream call admitted; declared cost is per started call',
      { key, actionId, cost: options.callCost ?? null },
    );
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Source timeout')),
      config.timeoutMs!,
    );
    if (refresh)
      emit('refresh-start', 'Real HTTP refresh started', {
        key,
        actionId,
        cost: options.callCost ?? null,
      });
    const promise = (async () => {
      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Plug-Refresh': String(refresh),
          },
          body: JSON.stringify(key),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
        const reader = response.body!.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > config.maxBytes || size > 1048576) {
            controller.abort();
            throw new Error('Source response exceeds memory limit');
          }
          chunks.push(value);
        }
        const combined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const data: unknown = JSON.parse(new TextDecoder().decode(combined));
        assertContract<SourceResponse>('SourceResponse', data);
        if (!validate(data.data))
          throw new Error('Source output contract validation failed');
        const completed = Date.now();
        if (ended || controller.signal.aborted)
          throw new Error('Late completion ignored');
        if (data.snapshotAt > completed || data.snapshotAt < 0)
          throw new Error('Invalid source timestamp');
        // Observation-only sources need a bounded lag; never relabel fetch time as snapshot time.
        const snapshot =
          config.sourceTimestamp === 'observationOnly'
            ? now - config.sourceLagMs!
            : data.snapshotAt - (config.sourceLagMs ?? 0);
        const stored = { ...data, snapshotAt: snapshot };
        emit(
          'source-completion',
          'Source call completed; duration is measured HTTP time',
          {
            key,
            actionId,
            durationMs: completed - now,
            sourceSnapshotAt: snapshot,
            observedAt: completed,
            cost: options.callCost ?? null,
          },
        );
        if (fill && admittedKeys.has(k)) {
          const previous = entries.get(k);
          if (
            (entries.size < config.capacity || previous) &&
            usedBytes - (previous?.bytes ?? 0) + size <= config.maxBytes
          ) {
            usedBytes -= previous?.bytes ?? 0;
            entries.set(k, {
              response: stored,
              fetchedAt: completed,
              bytes: size,
            });
            usedBytes += size;
          }
        }
        if (refresh)
          emit(
            'refresh-success',
            'Validated snapshot retained with its source timestamp',
            {
              key,
              actionId,
              sourceSnapshotAt: snapshot,
              observedAt: completed,
            },
          );
        return stored;
      } catch (e) {
        if (refresh)
          emit('refresh-failure', (e as Error).message, { key, actionId });
        throw e;
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
        active--;
        if (refresh) refreshActive--;
        inflight.delete(k);
      }
    })();
    inflight.set(k, promise);
    return promise;
  }
  async function request(key: ExactKey, actionId?: string) {
    const start = Date.now();
    emit('request-start', 'Useful-result timer started', { key, actionId });
    try {
      const k = cached(config.pattern)
        ? exactKey(key, config.keyDimensions, config.scope)
        : JSON.stringify(key);
      const entry = entries.get(k);
      const age = entry ? Date.now() - entry.response.snapshotAt : null;
      if (
        cached(config.pattern) &&
        entry &&
        age !== null &&
        age + config.deliveryAllowanceMs! <= config.maxAgeMs!
      ) {
        emit('cache-hit', 'Eligible exact-key hit', {
          key,
          actionId,
          dataAgeMs: age,
          sourceSnapshotAt: entry.response.snapshotAt,
          observedAt: entry.fetchedAt,
        });
        deliver(entry.response, start, key, actionId, true);
        if (config.pattern === 'cached-live') {
          const live = await source(key, false, true, actionId);
          deliver(live, start, key, actionId, false, true);
        }
        return;
      }
      if (cached(config.pattern))
        emit(
          entry ? 'cache-expiry' : 'cache-miss',
          entry
            ? 'Entry is too old; stale data will not be served'
            : 'Cache begins empty or key is unprewarmed',
          { key, actionId, ...(age === null ? {} : { dataAgeMs: age }) },
        );
      if (cached(config.pattern) && config.missPolicy === 'target-unmet') {
        emit('target-miss', 'Slow miss path is disallowed', { key, actionId });
        return;
      }
      const data = await source(
        key,
        false,
        cached(config.pattern) && config.pattern !== 'scheduled-cache',
        actionId,
      );
      deliver(data, start, key, actionId, false);
    } catch (e) {
      emit('target-miss', (e as Error).message, {
        key,
        actionId,
        durationMs: Date.now() - start,
      });
    }
  }
  function deliver(
    data: SourceResponse,
    start: number,
    key: ExactKey,
    actionId: string | undefined,
    hit: boolean,
    final = false,
  ) {
    const now = Date.now(),
      durationMs = now - start,
      age = now - data.snapshotAt;
    const ageValid =
      !cached(config.pattern) ||
      age + config.deliveryAllowanceMs! <= config.maxAgeMs!;
    const target = final ? config.finalDeadlineMs : config.latencyTargetMs;
    if (!ageValid || (target !== null && durationMs > target))
      emit(
        'target-miss',
        !ageValid
          ? 'Source data cannot meet accepted age'
          : 'Measured result missed its latency/deadline target',
        { key, actionId, durationMs, dataAgeMs: age },
      );
    if (!ageValid) return;
    emit(
      'result-delivery',
      `${hit ? 'Measured cache path' : 'Measured HTTP path'}; agent/model overhead is not executed; production SLO remains unverified${final ? '; final live update' : ''}`,
      {
        key,
        actionId,
        durationMs,
        dataAgeMs: age,
        sourceSnapshotAt: data.snapshotAt,
        observedAt: now,
        data: { ...data.data, version: data.version },
      },
    );
  }
  function refresh(key: ExactKey) {
    void source(key, true, true).catch((e) => {
      if ((e as Error).message.includes('admission'))
        emit('refresh-failure', (e as Error).message, { key });
    });
  }
  const warmup = async () => {
    if (!scheduled(config.pattern)) return;
    emit(
      'warmup',
      'Empty cache: real HTTP prewarming starts now; setup is outside warm-request timing',
    );
    await Promise.all(
      config.prewarmKeys.map((key) =>
        source(key, true, true).catch(() => undefined),
      ),
    );
    emit(
      'warmup',
      'Warmup attempts completed; only validated, age-eligible entries can be served',
    );
  };
  if (options.signal?.aborted) stop('cancelled');
  if (!ended) {
    if (options.lifetimeMs !== null)
      later(
        () => stop('lifetime-expired'),
        Math.min(options.lifetimeMs ?? 120000, 120000),
      );
    void warmup();
    if (scheduled(config.pattern) && config.refreshIntervalMs) {
      const interval = config.refreshIntervalMs;
      for (const item of config.schedule) {
        const tick = () => {
          refresh(item.key);
          later(tick, interval);
        };
        later(tick, item.offsetMs || interval);
      }
    }
  }
  return {
    request,
    stop,
    expire: (actionId?: string) => {
      entries.clear();
      usedBytes = 0;
      emit('cache-expiry', 'All sandbox entries explicitly expired', {
        actionId,
      });
    },
    get ended() {
      return ended;
    },
    get size() {
      return entries.size;
    },
    get active() {
      return active;
    },
  };
}
