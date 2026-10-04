import { afterEach, describe, it, expect, vi } from 'vitest';
import { runDemo } from '../packages/plug/src/demo/runtime';
import { flightInput, keys } from '../packages/plug/src/demo/flight';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import type {
  Candidate,
  DemoEvent,
  SourceResponse,
} from '../packages/plug/src/contracts/index';
function design(pattern: Candidate['id'] = 'cache-aside') {
  const input = flightInput();
  input.experience.allowDeferred = true;
  const c = structuredClone(
    suggestDesign(input).candidates.find((c) => c.id === pattern)!,
  );
  Object.assign(c.config, {
    maxAgeMs: 1000,
    deliveryAllowanceMs: 10,
    timeoutMs: 100,
    callsPerMinute: 1000,
    foregroundReserveCallsPerMinute: 0,
    refreshIntervalMs: pattern.startsWith('scheduled') ? 500 : null,
    schedule: keys.map((key, i) => ({ key, offsetMs: i * 200 })),
  });
  return c;
}
function setup(c = design(), delay = 50, lifetimeMs: number | null = 10000) {
  const events: DemoEvent[] = [];
  let fail = false,
    version = 1,
    calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, opts: { signal: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const snapshotAt = Date.now(),
            capturedVersion = version;
          calls++;
          const timer = setTimeout(() => {
            opts.signal.removeEventListener('abort', abort);
            if (fail) {
              fail = false;
              resolve(new Response('error', { status: 503 }));
            } else
              resolve(
                new Response(
                  JSON.stringify({
                    snapshotAt,
                    version: capturedVersion,
                    data: { offers: [] },
                  } satisfies SourceResponse),
                  { status: 200 },
                ),
              );
          }, delay);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          };
          opts.signal.addEventListener('abort', abort, { once: true });
        }),
    ),
  );
  const runner = runDemo(c, {
    endpoint: 'http://127.0.0.1:4010/search',
    outputSchema: flightInput().systems[1].operations[0].outputSchema!,
    onEvent: (e) => events.push(e),
    lifetimeMs,
  });
  return {
    runner,
    events,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
    change: () => version++,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('bounded cache lifecycle with injected fake clock', () => {
  it('starts cold, coalesces fills, hits fast, and expires without changing source timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { runner, events, calls } = setup();
    const a = runner.request(keys[0]),
      b = runner.request(keys[0]);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([a, b]);
    expect(calls()).toBe(1);
    expect(runner.size).toBe(1);
    await runner.request(keys[0]);
    expect(events.some((e) => e.type === 'cache-hit')).toBe(true);
    expect(events.find((e) => e.type === 'cache-hit')?.sourceSnapshotAt).toBe(
      100000,
    );
    await vi.advanceTimersByTimeAsync(951);
    const expired = runner.request(keys[0]);
    await vi.advanceTimersByTimeAsync(50);
    await expired;
    expect(calls()).toBe(2);
    expect(events.some((e) => e.type === 'cache-expiry')).toBe(true);
    runner.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('failed refresh preserves age; later refresh updates version', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup(design('scheduled-cache'));
    await vi.advanceTimersByTimeAsync(50);
    s.fail();
    await vi.advanceTimersByTimeAsync(200);
    await s.runner.request(keys[1]);
    expect(s.events.some((e) => e.type === 'refresh-failure')).toBe(true);
    const hit = s.events.filter((e) => e.type === 'cache-hit').at(-1);
    expect(hit?.sourceSnapshotAt).toBe(100000);
    s.change();
    await vi.advanceTimersByTimeAsync(300);
    await s.runner.request(keys[0]);
    expect(
      s.events.filter((e) => e.type === 'result-delivery').at(-1)?.data
        ?.version,
    ).toBe(2);
    s.runner.stop();
  });
  it('times out, releases admission once and cannot deliver a late completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup(design(), 500);
    const promise = s.runner.request(keys[0]);
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    expect(s.runner.active).toBe(0);
    expect(s.events.some((e) => e.type === 'target-miss')).toBe(true);
    expect(s.events.some((e) => e.type === 'result-delivery')).toBe(false);
    s.runner.stop();
    s.runner.stop();
    expect(
      s.events.filter((e) => e.type === 'sandbox-termination'),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels in-flight work and clears entries/timers without later delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup();
    const p = s.runner.request(keys[0]);
    s.runner.stop();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(s.runner.size).toBe(0);
    expect(
      s.events.filter((e) => e.type === 'sandbox-termination'),
    ).toHaveLength(1);
    expect(s.events.some((e) => e.type === 'result-delivery')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never caches an unenumerated query, crosses scope or accepts oversized configs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup();
    const p = s.runner.request({ ...keys[0], destination: 'JFK' });
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(s.runner.size).toBe(0);
    const c = design();
    c.config.capacity = 3;
    expect(() => setup(c)).toThrow();
    s.runner.stop();
  });
  it('honors target-unmet without calling the source and terminates at lifetime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const c = design();
    c.config.missPolicy = 'target-unmet';
    const s = setup(c);
    await s.runner.request(keys[0]);
    expect(s.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(10001);
    expect(s.runner.ended).toBe(true);
    expect(s.events.at(-1)?.message).toBe('lifetime-expired');
  });
  it('rejects invalid responses without retaining cache entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              snapshotAt: 100000,
              version: 1,
              data: { bad: 'shape' },
            }),
          ),
      ),
    );
    await s.runner.request(keys[0]);
    expect(s.runner.size).toBe(0);
    expect(
      s.events.some(
        (e) => e.type === 'target-miss' && e.message.includes('contract'),
      ),
    ).toBe(true);
    s.runner.stop();
  });
  it('does not certify old source snapshots merely because they were fetched now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ snapshotAt: 1, version: 1, data: { offers: [] } }),
          ),
      ),
    );
    await s.runner.request(keys[0]);
    expect(s.events.some((e) => e.type === 'result-delivery')).toBe(false);
    expect(s.events.some((e) => e.type === 'target-miss')).toBe(true);
    s.runner.stop();
  });
  it('cached-live emits useful cached result then live version within final deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const s = setup(design('cached-live'));
    const first = s.runner.request(keys[0]);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    s.change();
    const next = s.runner.request(keys[0]);
    await vi.advanceTimersByTimeAsync(50);
    await next;
    expect(
      s.events
        .filter((e) => e.type === 'result-delivery')
        .map((e) => e.data?.version),
    ).toEqual([1, 1, 2]);
    s.runner.stop();
  });
});

it('keeps an explicitly trusted local scheduler alive until shutdown', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const s = setup(design('scheduled-cache'), 50, null);
  await vi.advanceTimersByTimeAsync(121000);
  expect(s.runner.ended).toBe(false);
  expect(s.calls()).toBeGreaterThan(100);
  s.runner.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(0);
});
