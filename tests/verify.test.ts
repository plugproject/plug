import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flightInput, keys, synthetic } from '../packages/plug/src/demo/flight';
import { addAuthorizedHost } from '../packages/plug/src/probe/hosts';
import { suggestDesign } from '../packages/plug/src/recommender/index';
import { verifyEdge } from '../packages/plug/src/verify/index';
import { startProbeServer, type ProbeFixture } from './fixtures/probe-server';

let workspace = '';
let fixture: ProbeFixture | null = null;

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

async function configuredInput() {
  workspace = mkdtempSync(join(tmpdir(), 'plug-verify-'));
  fixture = await startProbeServer(async (request, response) => {
    if (request.method === 'DELETE') {
      response.statusCode = 204;
      response.end();
      return;
    }
    let rpc: Record<string, unknown> | null = null;
    if (request.method === 'POST') {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      rpc = JSON.parse(text) as Record<string, unknown>;
      if (rpc.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'verify-session');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            },
          }),
        );
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
        return;
      }
    }
    response.setHeader('content-type', 'application/json');
    const result = {
      capturedAt: new Date().toISOString(),
      payload: { offers: [] },
    };
    response.end(
      JSON.stringify(rpc ? { jsonrpc: '2.0', id: rpc.id, result } : result),
    );
  });
  const input = flightInput();
  input.systems[1].interfaces[0].endpoint = fixture.base;
  input.systems[1].operations[0].binding = {
    request: {
      protocol: 'http',
      method: 'GET',
      pathTemplate: '/offers',
      query: { origin: '{origin}' },
      headers: {},
      bodyTemplate: null,
      samples: keys,
      samplesEvidence: synthetic,
    },
    response: {
      dataPointer: '/payload',
      snapshotPointer: '/capturedAt',
      snapshotHeader: null,
      timestampFormat: 'iso-8601',
    },
  };
  await addAuthorizedHost(workspace, fixture.base, 'cli');
  return input;
}

const positiveJudge = {
  model: 'jev-test',
  async ask() {
    return {
      equivalent: true,
      confidence: 0.95,
      rationale: 'The fixture payload is the required result.',
      model: 'jev-test-resolved',
    };
  },
};

describe('edge verification harness', () => {
  it('maps a plain REST response and records a bounded as-is demonstration', async () => {
    const input = await configuredInput();
    const messages: string[] = [];
    const sampleDraft = vi.fn(async () => JSON.stringify({ sample: {} }));
    const result = await verifyEdge(input, 'primary', 'as-is', {
      workspace,
      provider: positiveJudge,
      sampleDrafter: { model: 'must-not-run', draft: sampleDraft },
      sampleCount: 3,
      onEvent: (event) => messages.push(`${event.type}: ${event.message}`),
    });
    expect(
      result.verdict,
      `${JSON.stringify(result)} ${messages.join(' | ')}`,
    ).toBe('demonstrated');
    expect(result.sampleSize).toBe(3);
    expect(result.result.withinTarget).toBe(1);
    expect(result.result.judgeModel).toBe('jev-test-resolved');
    expect(fixture!.calls).toHaveLength(3);
    expect(sampleDraft).not.toHaveBeenCalled();
    expect(fixture!.calls[0].url).toContain('/offers?origin=DEL');
    const stored = readFileSync(
      join(workspace, '.plug', 'verifications.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(stored).toEqual([result]);
    expect(result.evidence.note).toContain(
      'not a production measurement or SLO',
    );
  });

  it('marks passing runner designs executable only with local host authorization', async () => {
    const input = await configuredInput();
    const canonical = suggestDesign(input);
    expect(
      canonical.connections[0].candidates.every(
        (candidate) => !candidate.executableHere,
      ),
    ).toBe(true);
    const authorized = await addAuthorizedHost(workspace, fixture!.base, 'cli');
    const local = suggestDesign(input, { authorizedHosts: [authorized] });
    expect(local.designHash).toBe(canonical.designHash);
    expect(
      local.connections[0].candidates.some(
        (candidate) =>
          candidate.status === 'feasible_under_declared_assumptions' &&
          candidate.executableHere,
      ),
    ).toBe(true);
  });

  it('never executes writes and labels the result inconclusive', async () => {
    const input = await configuredInput();
    input.systems[1].operations[0].semantics.effect = 'write';
    const result = await verifyEdge(input, 'primary', 'as-is', {
      workspace,
      provider: positiveJudge,
    });
    expect(result.verdict).toBe('inconclusive');
    expect(result.sampleSize).toBe(0);
    expect(fixture!.calls).toHaveLength(0);
    expect(result.evidence.note).toContain('never run');
  });

  it('does not claim success without a settled useful-output judgment', async () => {
    const input = await configuredInput();
    const result = await verifyEdge(input, 'primary', 'as-is', {
      workspace,
      provider: null,
    });
    expect(result.verdict).toBe('inconclusive');
    expect(result.sampleSize).toBe(3);
    expect(result.result.usefulOutputProbability).toBeNull();
  });

  it('drafts one ephemeral sample for verification when no sample or prewarm key exists', async () => {
    const input = await configuredInput();
    input.systems[1].operations[0].binding!.request.samples = [];
    input.connections[0].workload.prewarmKeys = null;
    const draft = vi.fn(async () => JSON.stringify({ sample: keys[0] }));

    const result = await verifyEdge(input, 'primary', 'as-is', {
      workspace,
      provider: positiveJudge,
      sampleDrafter: { model: 'draft-test', draft },
      sampleCount: 3,
    });

    expect(result.verdict).toBe('demonstrated');
    expect(draft).toHaveBeenCalledOnce();
    expect(fixture!.calls).toHaveLength(3);
    expect(fixture!.calls[0].url).toContain('/offers?origin=DEL');
    expect(input.systems[1].operations[0].binding!.request.samples).toEqual([]);
  });

  it('verifies an authorized author-declared MCP tool through JSON-RPC', async () => {
    const input = await configuredInput();
    const callerOperation = input.systems[0].operations.find(
      (operation) => operation.id === input.connections[0].callerOperationId,
    )!;
    input.systems[0].interfaces.find(
      (iface) => iface.id === callerOperation.interfaceId,
    )!.protocol = 'mcp';
    input.systems[1].interfaces[0].protocol = 'mcp';
    const request = input.systems[1].operations[0].binding!.request;
    request.protocol = 'mcp';
    request.method = 'tools/call';
    request.pathTemplate = '';
    request.query = {};
    request.bodyTemplate = { name: 'flight-search' };

    const result = await verifyEdge(input, 'primary', 'as-is', {
      workspace,
      provider: positiveJudge,
      sampleCount: 3,
    });

    expect(result.verdict).toBe('demonstrated');
    expect(fixture!.calls).toHaveLength(6);
    expect(fixture!.calls.map((call) => call.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(fixture!.calls[2].headers['content-type']).toContain(
      'application/json',
    );
    expect(fixture!.calls[2].headers['mcp-session-id']).toBe('verify-session');
    expect(fixture!.calls[5].headers['mcp-session-id']).toBe('verify-session');
  });
});
