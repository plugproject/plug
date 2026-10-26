import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '../packages/plug/src/contracts/index';
import {
  draftRequestSample,
  requestSampleRequired,
  RequestSampleError,
  stubRequestSampleDrafter,
  type RequestSampleDrafter,
} from '../packages/plug/src/probe/samples';

const evidence = { kind: 'declared' as const, note: 'test declaration' };

function operation(): Operation {
  return {
    id: 'read-item',
    interfaceId: 'http',
    description: 'Read one item',
    inputSchema: {
      type: 'object',
      required: ['id', 'query'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    semantics: {
      effect: 'read',
      idempotent: true,
      outputMeaning: 'one item',
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
        pathTemplate: '/items/{id}',
        query: { q: '{query}' },
        headers: {},
        bodyTemplate: null,
        samples: [],
        samplesEvidence: {
          kind: 'unknown',
          note: 'No request example was declared.',
        },
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

const drafter = (text: string): RequestSampleDrafter => ({
  model: 'draft-test',
  draft: vi.fn(async () => text),
});

describe('model-proposed request samples', () => {
  it('accepts one strict, schema-valid sample that fills every template placeholder', async () => {
    const provider = drafter(
      JSON.stringify({ sample: { id: 'item-1', query: 'green' } }),
    );
    const result = await draftRequestSample(operation(), provider);

    expect(result).toEqual({
      sample: { id: 'item-1', query: 'green' },
      model: 'draft-test',
    });
    expect(provider.draft).toHaveBeenCalledOnce();
    expect(provider.draft).toHaveBeenCalledWith(
      expect.objectContaining({
        operationDescription: 'Read one item',
        requiredValues: ['id', 'query'],
      }),
      undefined,
    );
  });

  it.each([
    ['malformed output', 'not json', /valid JSON/],
    [
      'a schema-invalid value',
      JSON.stringify({ sample: { id: 7, query: 'green' } }),
      /input schema/,
    ],
    [
      'an extra response field',
      JSON.stringify({
        sample: { id: 'item-1', query: 'green' },
        rationale: 'not allowed',
      }),
      /return only/,
    ],
  ])('rejects %s', async (_label, text, message) => {
    await expect(
      draftRequestSample(operation(), drafter(text)),
    ).rejects.toThrow(message);
  });

  it('rejects a sample that omits a template placeholder even when the schema makes it optional', async () => {
    const target = operation();
    target.inputSchema = {
      ...target.inputSchema,
      required: ['id'],
    };

    await expect(
      draftRequestSample(
        target,
        drafter(JSON.stringify({ sample: { id: 'item-1' } })),
      ),
    ).rejects.toThrow(/scalar value query/);
  });

  it('does not expose endpoint metadata or credential values to the drafter', async () => {
    const target = operation();
    target.metadata = {
      endpoint: 'https://private.example.test',
      token: 'secret-value',
    };
    target.binding!.request.headers = {
      authorization: '${env:PRIVATE_TOKEN}',
    };
    const provider = drafter(
      JSON.stringify({ sample: { id: 'item-1', query: 'green' } }),
    );

    await draftRequestSample(target, provider);
    const basis = vi.mocked(provider.draft).mock.calls[0][0];
    expect(basis).not.toHaveProperty('endpoint');
    expect(JSON.stringify(basis)).not.toContain('private.example.test');
    expect(JSON.stringify(basis)).not.toContain('secret-value');
  });

  it('refuses operations without an input schema', async () => {
    const target = operation();
    target.inputSchema = null;
    const provider = drafter(JSON.stringify({ sample: {} }));

    await expect(draftRequestSample(target, provider)).rejects.toBeInstanceOf(
      RequestSampleError,
    );
    expect(provider.draft).not.toHaveBeenCalled();
  });

  it('does not require model values for a parameterless safe request', () => {
    const target = operation();
    target.inputSchema = null;
    target.binding!.request.pathTemplate = '/health';
    target.binding!.request.query = {};
    target.binding!.request.samples = [];

    expect(requestSampleRequired(target)).toBe(false);
  });

  it('makes the explicit stub fill optional fields used by templates', async () => {
    const target = operation();
    target.inputSchema = {
      ...target.inputSchema,
      required: ['id'],
    };

    await expect(
      draftRequestSample(target, stubRequestSampleDrafter()),
    ).resolves.toMatchObject({
      sample: { id: 'sample', query: 'sample' },
      model: 'stub-drafter',
    });
  });
});
