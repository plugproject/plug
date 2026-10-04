import { it, expect } from 'vitest';
import {
  startFixture,
  runDemo,
  flightInput,
  suggestDesign,
  flightKeys,
} from '../packages/plug/src/index';
import type { DemoEvent } from '../packages/plug/src/index';
it('real 15-second HTTP source retains latency while eligible warm hits are fast', async () => {
  const fixture = await startFixture(),
    input = flightInput(),
    c = suggestDesign(input).candidates.find((c) => c.id === 'cache-aside')!,
    events: DemoEvent[] = [];
  const runner = runDemo(c, {
    endpoint: fixture.endpoint,
    outputSchema: input.systems[1].operations[0].outputSchema!,
    onEvent: (e) => events.push(e),
  });
  try {
    const start = performance.now();
    await runner.request(flightKeys[0], 'cold');
    expect(performance.now() - start).toBeGreaterThanOrEqual(14900);
    expect(
      events.some((e) => e.type === 'target-miss' && e.actionId === 'cold'),
    ).toBe(true);
    const warm = performance.now();
    await runner.request(flightKeys[0], 'warm');
    expect(performance.now() - warm).toBeLessThan(500);
    const hit = events.find((e) => e.type === 'cache-hit');
    expect(hit?.dataAgeMs).toBeGreaterThanOrEqual(14900);
    expect(
      events.find((e) => e.type === 'source-completion')?.durationMs,
    ).toBeGreaterThanOrEqual(14900);
  } finally {
    runner.stop();
    await fixture.close();
  }
}, 25000);
