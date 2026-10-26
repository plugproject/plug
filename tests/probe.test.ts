import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flightInput } from '../packages/plug/src/demo/flight';
import type {
  DesignInput,
  Operation,
  OperationManifest,
} from '../packages/plug/src/contracts/index';
import {
  addAuthorizedHost,
  applyOperationManifest,
  buildProbePlan,
  canonicalOrigin,
  classifyNoul,
  executeProbe,
  ProbeRateLimiter,
  readAuthorizedHosts,
  readOperationManifests,
  resolveRequestHeaders,
  runProbeOperation,
  safeProbeId,
  summarizeProbe,
  summarizeProbeMechanically,
  upsertOperationManifest,
} from '../packages/plug/src/probe/index';
import { startProbeServer, type ProbeFixture } from './fixtures/probe-server';

const workspaces: string[] = [];
const fixtures: ProbeFixture[] = [];
const workspace = () => {
  const value = mkdtempSync(join(tmpdir(), 'plug-probe-'));
  workspaces.push(value);
  return value;
};
const fixture = async (handler: Parameters<typeof startProbeServer>[0]) => {
  const value = await startProbeServer(handler);
  fixtures.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
  for (const directory of workspaces.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const evidence = { kind: 'declared' as const, note: 'test declaration' };

function probeOperation(
  headers: Record<string, string> = {},
  pathTemplate = '/items/{id}',
): Operation {
  return {
    id: 'probe-read',
    interfaceId: 'probe-http',
    description: 'Return a bounded item snapshot',
    inputSchema: null,
    outputSchema: null,
    semantics: {
      effect: 'unknown',
      idempotent: null,
      outputMeaning: 'an item snapshot',
      cachePermission: null,
      scope: 'public',
      keyDimensions: ['id'],
      keysComplete: true,
      requiresLiveValidation: false,
      evidence,
    },
    binding: {
      request: {
        protocol: 'http',
        method: 'GET',
        pathTemplate,
        query: { q: '{query}' },
        headers,
        bodyTemplate: { ignored: '{id}' },
        samples: [{ id: 'a b', query: 'blue' }],
        samplesEvidence: evidence,
      },
      response: {
        dataPointer: null,
        snapshotPointer: null,
        snapshotHeader: null,
        timestampFormat: 'unknown',
      },
    },
  };
}

function probeInput(base: string, operation = probeOperation()): DesignInput {
  const input = flightInput();
  const system = input.systems[1];
  system.interfaces = [
    {
      id: 'probe-http',
      protocol: 'http',
      version: '1.1',
      direction: 'exposes',
      binding: 'http',
      endpoint: base,
    },
  ];
  system.operations = [operation];
  const connection = input.connections[0];
  connection.downstreamSystemId = system.id;
  connection.downstreamOperationId = operation.id;
  connection.profile.systemId = system.id;
  connection.profile.operationId = operation.id;
  return input;
}

function shortPlan(input: DesignInput) {
  const operation = input.systems[1].operations[0];
  return buildProbePlan(input, {
    latencySamples: 2,
    changeSamples: 2,
    changeSpacingMs: 0,
    limits: {
      timeoutMs: 100,
      operationMaxMs: 1_000,
      responseMaxBytes: 16 * 1024,
    },
  }).operations.find(
    (row) =>
      row.systemId === input.systems[1].id && row.operationId === operation.id,
  )!;
}

describe('probe authorization and planning', () => {
  it('stores only canonical origins and matches them exactly', async () => {
    const root = workspace();
    const added = await addAuthorizedHost(
      root,
      'https://user:secret@EXAMPLE.com:443/path?q=secret#fragment',
      'cli',
      '2026-10-26T00:00:00.000Z',
    );
    expect(added.host).toBe('https://example.com');
    expect(await readAuthorizedHosts(root)).toEqual([added]);
    expect(canonicalOrigin('https://example.com/other')).toBe(added.host);
    expect(canonicalOrigin('https://sub.example.com')).not.toBe(added.host);
    expect(
      readFileSync(join(root, '.plug', 'hosts.json'), 'utf8'),
    ).not.toContain('secret');
  });

  it('makes the default connected plan bounded and exposes unsafe skips', () => {
    const input = probeInput('http://127.0.0.1:43210');
    const system = input.systems[1];
    const unsafe = probeOperation();
    unsafe.id = 'unsafe-write';
    unsafe.binding!.request.method = 'POST';
    const unconnected = probeOperation();
    unconnected.id = 'unconnected-read';
    system.operations.push(unsafe, unconnected);
    const plan = buildProbePlan(input);
    const connected = plan.operations.find(
      (row) => row.operationId === 'probe-read',
    )!;
    const skipped = plan.operations.find(
      (row) => row.operationId === 'unsafe-write',
    )!;
    const small = plan.operations.find(
      (row) => row.operationId === 'unconnected-read',
    )!;
    expect(connected.plannedCalls).toBe(25);
    expect(
      connected.attempts.filter((row) => row.kind === 'latency'),
    ).toHaveLength(20);
    expect(
      connected.attempts.filter((row) => row.kind === 'concurrency'),
    ).toHaveLength(2);
    expect(connected.limits).toMatchObject({
      hostMaxCalls: 300,
      callsPerMinute: 30,
      maxConcurrency: 2,
      timeoutMs: 10_000,
      operationMaxMs: 120_000,
    });
    expect(skipped.plannedCalls).toBe(0);
    expect(skipped.skippedReason).toMatch(/read and idempotent/);
    expect(small.plannedCalls).toBe(3);
  });

  it('recognizes intrinsic MCP listing and A2A card reads without trusting other protocol calls', () => {
    const listing = probeOperation({}, '');
    listing.binding!.request.protocol = 'mcp';
    listing.binding!.request.method = 'tools/list';
    listing.binding!.request.bodyTemplate = {};
    listing.binding!.request.samples = [];
    const mcp = probeInput('http://127.0.0.1:43210', listing);
    mcp.systems[1].interfaces[0].protocol = 'mcp';
    expect(shortPlan(mcp)).toMatchObject({ safe: true, executable: true });

    const card = probeOperation({}, '/.well-known/agent-card.json');
    card.binding!.request.protocol = 'a2a';
    card.binding!.request.method = 'GET';
    card.binding!.request.query = {};
    card.binding!.request.bodyTemplate = null;
    card.binding!.request.samples = [];
    const a2a = probeInput('http://127.0.0.1:43210', card);
    a2a.systems[1].interfaces[0].protocol = 'a2a';
    expect(shortPlan(a2a)).toMatchObject({ safe: true, executable: true });

    listing.binding!.request.method = 'tools/call';
    expect(shortPlan(mcp)).toMatchObject({ safe: false, executable: false });
  });

  it('executes an author-declared read-only MCP tool through its HTTP JSON-RPC binding', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = await fixture(async (request, response) => {
      if (request.method === 'DELETE') {
        expect(request.headers['mcp-session-id']).toBe('probe-session');
        response.statusCode = 204;
        response.end();
        return;
      }
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const body = JSON.parse(text) as Record<string, unknown>;
      bodies.push(body);
      if (body.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'probe-session');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            },
          }),
        );
        return;
      }
      if (body.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
        return;
      }
      expect(request.headers['mcp-session-id']).toBe('probe-session');
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            capturedAt: new Date().toISOString(),
            value: (
              (body.params as Record<string, unknown>).arguments as Record<
                string,
                unknown
              >
            ).query,
          },
        })}\n\n`,
      );
    });
    const root = workspace();
    const operation = probeOperation({}, '');
    operation.semantics.effect = 'read';
    operation.semantics.idempotent = true;
    operation.binding!.request = {
      protocol: 'mcp',
      method: 'tools/call',
      pathTemplate: '',
      query: {},
      headers: {},
      bodyTemplate: { name: 'search' },
      samples: [{ query: 'green' }],
      samplesEvidence: evidence,
    };
    const input = probeInput(server.base, operation);
    input.systems[1].interfaces[0].protocol = 'mcp';
    await addAuthorizedHost(root, server.base, 'cli');
    const plan = buildProbePlan(input, {
      latencySamples: 1,
      changeSamples: 0,
      limits: { maxConcurrency: 1 },
    }).operations.find((row) => row.operationId === operation.id)!;

    const run = await runProbeOperation({
      workspace: root,
      systemId: input.systems[1].id,
      operation,
      endpoint: server.base,
      plan,
    });

    expect(plan).toMatchObject({
      protocol: 'mcp',
      safe: true,
      executable: true,
      setupCalls: 3,
      plannedCalls: 4,
    });
    expect(server.calls).toHaveLength(4);
    expect(server.calls.map((call) => call.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(bodies[0]).toMatchObject({ method: 'initialize' });
    expect(bodies[1]).toMatchObject({ method: 'notifications/initialized' });
    expect(bodies[2]).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'green' } },
    });
    expect(run.observations[0].sample).toMatchObject({
      value: 'green',
    });
  });

  it('automatically inspects a parameterless A2A Agent Card without drafting values', async () => {
    const server = await fixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: 'Fixture agent',
          skills: [{ id: 'search', name: 'Search' }],
        }),
      );
    });
    const root = workspace();
    const operation = probeOperation({}, '/.well-known/agent-card.json');
    operation.inputSchema = null;
    operation.binding!.request.protocol = 'a2a';
    operation.binding!.request.method = 'GET';
    operation.binding!.request.query = {};
    operation.binding!.request.bodyTemplate = null;
    operation.binding!.request.samples = [];
    const input = probeInput(server.base, operation);
    input.systems[1].interfaces[0].protocol = 'a2a';
    await addAuthorizedHost(root, server.base, 'cli');
    const draft = vi.fn(async () => JSON.stringify({ sample: {} }));

    const result = await executeProbe(input, {
      workspace: root,
      systemId: input.systems[1].id,
      env: {},
      sampleDrafter: { model: 'must-not-run', draft },
      plan: {
        latencySamples: 1,
        changeSamples: 0,
        limits: { maxConcurrency: 1 },
      },
    });

    expect(draft).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
    });
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0].sampleSize).toBe(1);
  });

  it('applies the 300-call host budget deterministically', () => {
    const input = probeInput('http://127.0.0.1:43210');
    const system = input.systems[1];
    const templateOperation = system.operations[0];
    const templateConnection = input.connections[0];
    system.operations = Array.from({ length: 13 }, (_, index) => ({
      ...structuredClone(templateOperation),
      id: `read-${String(index).padStart(2, '0')}`,
    }));
    input.connections = system.operations.map((operation, index) => ({
      ...structuredClone(templateConnection),
      id: `connection-${index}`,
      downstreamOperationId: operation.id,
      profile: {
        ...structuredClone(templateConnection.profile),
        operationId: operation.id,
      },
    }));
    const first = buildProbePlan(input);
    const second = buildProbePlan(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.totalPlannedCalls).toBe(300);
    expect(Object.values(first.callsByOrigin)).toEqual([300]);
    expect(
      first.operations
        .filter((row) => row.systemId === system.id)
        .reduce((sum, row) => sum + row.plannedCalls, 0),
    ).toBe(300);
  });

  it('enforces the shared 30-call rolling-minute ceiling', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    };
    const limiter = new ProbeRateLimiter();
    const signal = new AbortController().signal;
    await limiter.acquire('http://example.test', 30, 30, clock, signal);
    await limiter.acquire('http://example.test', 1, 30, clock, signal);
    expect(sleeps).toEqual([60_000]);
  });

  it('refuses an unauthorized origin before calling fetch', async () => {
    const root = workspace();
    const input = probeInput('http://127.0.0.1:43211');
    const operation = input.systems[1].operations[0];
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      runProbeOperation({
        workspace: root,
        systemId: input.systems[1].id,
        operation,
        endpoint: 'http://127.0.0.1:43211',
        plan: shortPlan(input),
        authorizedHosts: [],
        fetch: fetcher,
      }),
    ).rejects.toThrow(/not authorized/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('HTTP probe execution and summaries', () => {
  it('measures bounded responses, changes, cache headers and timestamp candidates without persisting secrets', async () => {
    const snapshotAt = new Date().toISOString();
    const server = await fixture(async (_request, response, call) => {
      await new Promise((resolve) => setTimeout(resolve, 4));
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'public, max-age=30');
      response.setHeader('etag', `"v${call < 4 ? 1 : 2}"`);
      response.setHeader('ratelimit-limit', '120;w=60');
      response.setHeader('authorization', 'response-secret');
      response.end(
        JSON.stringify({
          version: call < 4 ? 1 : 2,
          snapshotAt,
          token: 'body-secret',
        }),
      );
    });
    const root = workspace();
    const operation = probeOperation({
      authorization: '${env:PROBE_TOKEN}',
    });
    const input = probeInput(server.base, operation);
    await addAuthorizedHost(root, `${server.base}/ignored`, 'cli');
    const run = await runProbeOperation({
      workspace: root,
      systemId: input.systems[1].id,
      operation,
      endpoint: server.base,
      plan: shortPlan(input),
      env: { PROBE_TOKEN: 'env-secret' },
      headers: { 'x-runtime-key': 'memory-secret' },
    });
    expect(run.attemptedCalls).toBe(6);
    expect(server.calls[0].url).toBe('/items/a%20b?q=blue');
    expect(server.calls[0].headers.authorization).toBe('env-secret');
    expect(server.calls[0].headers['x-runtime-key']).toBe('memory-secret');
    const manifest = summarizeProbeMechanically(run, {
      nodeVersion: 'v24.test',
    });
    expect(manifest.sampleSize).toBe(6);
    expect(manifest.latencyMs.p95).toBeGreaterThanOrEqual(1);
    expect(manifest.responseBytes).toBeGreaterThan(0);
    expect(manifest.availability).toBe(1);
    expect(manifest.cacheHeaders).toMatchObject({
      'cache-control': 'public, max-age=30',
      etag: '"v2"',
    });
    expect(manifest.rateLimitHeaders).toEqual({
      'ratelimit-limit': '120;w=60',
    });
    expect(manifest.timestampCandidates).toContain('/snapshotAt');
    expect(manifest.changeIntervalMs).not.toBeNull();
    expect(manifest.sourceTimestamp).toBeNull();
    expect(manifest.usefulOutput).toBeNull();
    const persisted = readFileSync(
      join(root, '.plug', 'probes', input.systems[1].id, 'probe-read.jsonl'),
      'utf8',
    );
    expect(persisted).not.toContain('env-secret');
    expect(persisted).not.toContain('memory-secret');
    expect(persisted).not.toContain('response-secret');
    expect(persisted).not.toContain('body-secret');
    expect(persisted).toContain('[redacted]');
  });

  it('stops at the first 429 and keeps only rate/cache response headers', async () => {
    const server = await fixture((_request, response, call) => {
      if (call === 2) {
        response.statusCode = 429;
        response.setHeader('retry-after', '2');
        response.setHeader('x-ratelimit-limit', '10');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('authorization', 'do-not-record');
      }
      response.end(JSON.stringify({ call }));
    });
    const root = workspace();
    const input = probeInput(server.base);
    await addAuthorizedHost(root, server.base, 'ui');
    const plan = shortPlan(input);
    plan.attempts = plan.attempts.slice(0, 3).map((attempt, index) => ({
      ...attempt,
      attempt: index + 1,
      concurrencyGroup: null,
    }));
    plan.plannedCalls = plan.attempts.length;
    const run = await runProbeOperation({
      workspace: root,
      systemId: input.systems[1].id,
      operation: input.systems[1].operations[0],
      endpoint: server.base,
      plan,
    });
    expect(server.calls).toHaveLength(2);
    expect(run.stoppedByRateLimit).toBe(true);
    const limited = run.observations.find((row) => row.status === 429)!;
    expect(limited.headers).toEqual({
      'cache-control': 'no-store',
      'retry-after': '2',
      'x-ratelimit-limit': '10',
    });
  });

  it('uses one optional Jev bundle and leaves semantics null without it', async () => {
    const observedAt = new Date().toISOString();
    const run = {
      systemId: 'system',
      operationId: 'operation',
      endpoint: 'http://127.0.0.1/items/{id}',
      startedAt: observedAt,
      completedAt: observedAt,
      attemptedCalls: 1,
      stoppedByRateLimit: false,
      cancelled: false,
      events: [],
      observations: [
        {
          attempt: 1,
          kind: 'latency' as const,
          startedAt: observedAt,
          observedAt,
          durationMs: 12,
          status: 200,
          bytes: 100,
          headers: {},
          sample: { snapshotAt: observedAt, item: 'result' },
          contentHash: 'a',
        },
      ],
    };
    expect(summarizeProbeMechanically(run).sourceTimestamp).toBeNull();
    const checker = vi.fn(async () => ({
      model: 'jev-test',
      answers: {
        useful_output: { type: 'noul', noul: 0.7 },
        source_timestamp_field: {
          type: 'choice',
          choice: 'candidate_1',
          confidence: 0.9,
          probabilities: { candidate_1: 0.9 },
        },
        source_timestamp_confirmed: { type: 'noul', noul: 0.8 },
      },
    }));
    const checked = await summarizeProbe(run, {
      operationDescription: 'read item',
      outputMeaning: 'item result',
      usefulOutputs: ['item result'],
      checker,
    });
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checked.usefulOutput).toEqual({
      probability: 0.7,
      model: 'jev-test',
    });
    expect(checked.sourceTimestamp).toMatchObject({
      pointer: '/snapshotAt',
      probability: 0.8,
      model: 'jev-test',
    });
    expect(classifyNoul(0.7)).toBe(true);
    expect(classifyNoul(0.3)).toBe(false);
    expect(classifyNoul(0.5)).toBeNull();
  });

  it('does not invent timestamp or change facts when neither was observed', () => {
    const at = new Date().toISOString();
    const run = {
      systemId: 'system',
      operationId: 'operation',
      endpoint: 'http://127.0.0.1/items',
      startedAt: at,
      completedAt: at,
      attemptedCalls: 2,
      stoppedByRateLimit: false,
      cancelled: false,
      events: [],
      observations: [1, 2].map((attempt) => ({
        attempt,
        kind: 'latency' as const,
        startedAt: at,
        observedAt: at,
        durationMs: attempt * 10,
        status: 200,
        bytes: 10,
        headers: {},
        sample: { item: 'same', sequence: 42 },
        contentHash: 'same',
      })),
    };
    const manifest = summarizeProbeMechanically(run);
    expect(manifest.timestampCandidates).toEqual([]);
    expect(manifest.changeIntervalMs).toBeNull();
    expect(manifest.latencyMs).toEqual({
      p50: 10,
      p90: 20,
      p95: 20,
      max: 20,
    });
  });
});

describe('probe execution guards', () => {
  it('rejects traversal-capable event-log identifiers', () => {
    expect(() => safeProbeId('../outside', 'Operation ID')).toThrow(
      /safe filename/,
    );
    expect(() => safeProbeId('system/operation')).toThrow(/safe filename/);
  });

  it('resolves only exact env references and rejects malformed, missing and CR/LF values', () => {
    expect(
      resolveRequestHeaders(
        { authorization: '${env:TOKEN}' },
        { TOKEN: 'secret' },
      ),
    ).toEqual({ authorization: 'secret' });
    expect(() =>
      resolveRequestHeaders({ authorization: 'literal' }, {}),
    ).toThrow(/exactly/);
    expect(() =>
      resolveRequestHeaders({ authorization: '${env:MISSING}' }, {}),
    ).toThrow(/required/);
    expect(() =>
      resolveRequestHeaders(
        { authorization: '${env:TOKEN}' },
        { TOKEN: 'good\r\nbad' },
      ),
    ).toThrow(/CR\/LF/);
  });

  it('records timeouts, cancellation and response-byte limits without overrun', async () => {
    const server = await fixture(async (request, response) => {
      if (request.url?.startsWith('/large')) {
        response.end('x'.repeat(500));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      response.end('late');
    });
    const root = workspace();
    await addAuthorizedHost(root, server.base, 'cli');

    const timeoutOperation = probeOperation({}, '/slow/{id}');
    const timeoutInput = probeInput(server.base, timeoutOperation);
    const timeoutPlan = shortPlan(timeoutInput);
    timeoutPlan.attempts = timeoutPlan.attempts.slice(0, 1);
    timeoutPlan.plannedCalls = 1;
    timeoutPlan.limits.timeoutMs = 15;
    const timedOut = await runProbeOperation({
      workspace: root,
      systemId: timeoutInput.systems[1].id,
      operation: timeoutOperation,
      endpoint: server.base,
      plan: timeoutPlan,
    });
    expect(timedOut.attemptedCalls).toBe(1);
    expect(timedOut.observations).toEqual([]);
    expect(
      timedOut.events.some((event) => /timed out/.test(event.message)),
    ).toBe(true);

    const largeOperation = probeOperation({}, '/large/{id}');
    const largeInput = probeInput(server.base, largeOperation);
    const largePlan = shortPlan(largeInput);
    largePlan.attempts = largePlan.attempts.slice(0, 1);
    largePlan.plannedCalls = 1;
    largePlan.limits.responseMaxBytes = 100;
    const tooLarge = await runProbeOperation({
      workspace: root,
      systemId: largeInput.systems[1].id,
      operation: largeOperation,
      endpoint: server.base,
      plan: largePlan,
    });
    expect(tooLarge.observations).toEqual([]);
    expect(
      tooLarge.events.some((event) => /100-byte limit/.test(event.message)),
    ).toBe(true);

    const abort = new AbortController();
    const abortPlan = shortPlan(timeoutInput);
    abortPlan.attempts = abortPlan.attempts.slice(0, 1);
    abortPlan.plannedCalls = 1;
    abortPlan.limits.timeoutMs = 100;
    setTimeout(() => abort.abort(), 10);
    const cancelled = await runProbeOperation({
      workspace: root,
      systemId: timeoutInput.systems[1].id,
      operation: timeoutOperation,
      endpoint: server.base,
      plan: abortPlan,
      signal: abort.signal,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.attemptedCalls).toBe(1);
  });
});

describe('manifest application and storage', () => {
  function measuredManifest(over: Partial<OperationManifest> = {}) {
    const manifest: OperationManifest = {
      formatVersion: '0.2-alpha.1',
      manifestHash: 'test-hash',
      systemId: 'aggregator',
      operationId: 'probe-read',
      endpoint: 'http://127.0.0.1/items/{id}',
      measuredAt: '2026-10-26T00:00:00.000Z',
      windowMs: 250,
      sampleSize: 20,
      vantage: { kind: 'local-workbench', nodeVersion: 'v24.test' },
      latencyMs: { p50: 10, p90: 15, p95: 18, max: 20 },
      availability: 0.95,
      responseBytes: 512,
      statusHistogram: { '200': 19, '500': 1 },
      rateLimitHeaders: { 'ratelimit-limit': '120;w=120' },
      cacheHeaders: { 'cache-control': 'max-age=30' },
      timestampCandidates: ['/snapshotAt'],
      sourceTimestamp: {
        pointer: '/snapshotAt',
        format: 'iso-8601',
        probability: 0.9,
        model: 'jev-test',
      },
      usefulOutput: null,
      changeIntervalMs: 1_000,
      stoppedByRateLimit: false,
      ...over,
    };
    return manifest;
  }

  it('updates every selected downstream profile while preserving guarded fields and prior values', () => {
    const operation = probeOperation();
    const input = probeInput('http://127.0.0.1:43212', operation);
    const duplicate = structuredClone(input.connections[0]);
    duplicate.id = 'second-selection';
    input.connections.push(duplicate);
    const before = structuredClone(input);
    const applied = applyOperationManifest(input, measuredManifest());
    expect(input).toEqual(before);
    for (const connection of applied.connections) {
      expect(connection.profile.latencyMs.value).toBe(18);
      expect(connection.profile.latencyPercentile).toBe(0.95);
      expect(connection.profile.responseBytes.value).toBe(512);
      expect(connection.profile.availability?.value).toBe(0.95);
      expect(connection.profile.callsPerMinute.value).toBe(60);
      expect(connection.profile.changeIntervalMs.value).toBe(1_000);
      expect(connection.profile.sourceTimestamp).toBe('responseSnapshot');
      expect(connection.profile.latencyMs.evidence).toMatchObject({
        kind: 'probed',
        source: {
          type: 'probe-manifest',
          location: 'manifest@test-hash',
        },
      });
      expect(connection.profile.latencyMs.evidence.note).toContain(
        'local-workbench',
      );
      expect(connection.profile.latencyMs.evidence.note).toContain(
        'N=20, window=250 ms',
      );
      expect(connection.profile.latencyMs.evidence.note).toContain(
        'Not a production measurement',
      );
      expect(connection.profile.latencyMs.evidence.note).toContain(
        'Previous value:',
      );
      expect(connection.profile.timeoutMs).toEqual(
        before.connections[0].profile.timeoutMs,
      );
      expect(connection.profile.callCost).toEqual(
        before.connections[0].profile.callCost,
      );
      expect(connection.profile.sourceLagMs).toEqual(
        before.connections[0].profile.sourceLagMs,
      );
      expect(connection.workload).toEqual(before.connections[0].workload);
      expect(connection.experience).toEqual(before.connections[0].experience);
    }
    expect(applied.systems[1].operations[0].semantics.effect).toBe('read');
    expect(applied.systems[1].operations[0].semantics.cachePermission).toBe(
      before.systems[1].operations[0].semantics.cachePermission,
    );
    expect(applied.systems[1].operations[0].semantics.outputMeaning).toBe(
      before.systems[1].operations[0].semantics.outputMeaning,
    );
    const unconfirmed = applyOperationManifest(
      input,
      measuredManifest({
        sourceTimestamp: {
          pointer: '/snapshotAt',
          format: 'iso-8601',
          probability: 0.69,
          model: 'jev-test',
        },
      }),
    );
    expect(unconfirmed.connections[0].profile.sourceTimestamp).toBe(
      'observationOnly',
    );
  });

  it('keeps one latest manifest per operation in stable order', async () => {
    const root = workspace();
    const older = measuredManifest({
      measuredAt: '2026-10-25T00:00:00.000Z',
      latencyMs: { p50: 20, p90: 20, p95: 20, max: 20 },
    });
    const latest = measuredManifest({
      measuredAt: '2026-10-26T00:00:00.000Z',
    });
    await upsertOperationManifest(root, latest);
    await upsertOperationManifest(root, older);
    const stored = await readOperationManifests(root);
    expect(stored).toHaveLength(1);
    expect(stored[0].measuredAt).toBe(latest.measuredAt);
    expect(stored[0].manifestHash).not.toBe('test-hash');
    expect(JSON.stringify(stored)).not.toContain('authorization');
  });

  it('orchestrates an authorized probe through manifest and spec persistence', async () => {
    const root = workspace();
    const server = await fixture((_request, response, call) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'max-age=30');
      response.end(
        JSON.stringify({
          snapshotAt: new Date(1_700_000_000_000 + call * 1_000).toISOString(),
          value: call,
        }),
      );
    });
    const input = probeInput(server.base, probeOperation());
    await addAuthorizedHost(root, server.base, 'cli');
    const events: string[] = [];
    const sampleDraft = vi.fn(async () => JSON.stringify({ sample: {} }));
    const result = await executeProbe(input, {
      workspace: root,
      systemId: 'aggregator',
      env: {},
      sampleDrafter: { model: 'must-not-run', draft: sampleDraft },
      plan: {
        latencySamples: 2,
        changeSamples: 0,
        changeSpacingMs: 0,
        limits: { maxConcurrency: 1 },
      },
      onEvent: (event) => events.push(event.type),
    });
    expect(server.calls).toHaveLength(2);
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]).toMatchObject({
      systemId: 'aggregator',
      operationId: 'probe-read',
      sampleSize: 2,
    });
    expect(result.updatedConnectionIds).toEqual(['primary']);
    expect(result.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(events).toContain('complete');
    expect(sampleDraft).not.toHaveBeenCalled();
    expect(await readOperationManifests(root)).toHaveLength(1);
    expect(
      readFileSync(join(root, '.plug', 'workflow.yaml'), 'utf8'),
    ).toContain('kind: probed');
  });

  it('drafts exactly one ephemeral request sample only when examples are absent', async () => {
    const root = workspace();
    const server = await fixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ value: 1 }));
    });
    const operation = probeOperation();
    operation.inputSchema = {
      type: 'object',
      required: ['id', 'query'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
      },
    };
    operation.binding!.request.samples = [];
    operation.binding!.request.samplesEvidence = {
      kind: 'unknown',
      note: 'No request example was declared.',
    };
    const input = probeInput(server.base, operation);
    await addAuthorizedHost(root, server.base, 'cli');
    const draft = vi.fn(async () =>
      JSON.stringify({
        sample: { id: 'drafted-id', query: 'drafted-query' },
      }),
    );

    await executeProbe(input, {
      workspace: root,
      systemId: 'aggregator',
      env: {},
      sampleDrafter: { model: 'draft-test', draft },
      plan: {
        latencySamples: 1,
        changeSamples: 0,
        changeSpacingMs: 0,
        limits: { maxConcurrency: 1 },
      },
    });

    expect(draft).toHaveBeenCalledOnce();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].url).toBe('/items/drafted-id?q=drafted-query');
    expect(input.systems[1].operations[0].binding!.request.samples).toEqual([]);
    expect(
      readFileSync(join(root, '.plug', 'workflow.yaml'), 'utf8'),
    ).not.toContain('drafted-id');
  });
});
