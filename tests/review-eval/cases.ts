import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignInput } from '../../packages/plug/src/contracts/index';
import { validateInput } from '../../packages/plug/src/contracts/index';

export interface ReviewEvalCase {
  id: string;
  input: DesignInput;
  operationalContext: string;
  expectedEngine: string | null;
  expectedAdoptable: string[];
}
interface Descriptor {
  id: string;
  input: string;
  variant: 'identity' | 'direct-feasible' | 'latency-priority' | 'unknowns';
  operationalContext: string;
  expectedEngine: string | null;
  expectedAdoptable: string[];
}
const here = dirname(fileURLToPath(import.meta.url));
const caseDirectory = join(here, 'cases');

function directFeasible(input: DesignInput) {
  const connection = input.connections[0];
  connection.experience.latencyTargetMs = 20000;
  connection.experience.hitsWithinTargetMs = 20000;
  connection.experience.directWithinTarget = {
    thresholdMs: 20000,
    fraction: {
      value: 0.99,
      evidence: { kind: 'declared', note: 'Review evaluation case.' },
    },
  };
  connection.profile.callsPerMinute.value = 100;
  connection.profile.concurrency.value = 64;
  connection.workload.requestsPerMinute.value = 5;
  if (connection.workload.burstPerMinute)
    connection.workload.burstPerMinute.value = 5;
  for (const key of [
    'agentMs',
    'networkMs',
    'mappingMs',
    'renderingMs',
  ] as const)
    connection.remainingPath[key].value = 0;
}
function unknowns(input: DesignInput) {
  const profile = input.connections[0].profile;
  for (const key of [
    'latencyMs',
    'timeoutMs',
    'callsPerMinute',
    'concurrency',
    'responseBytes',
    'changeIntervalMs',
    'sourceLagMs',
  ] as const)
    profile[key] = {
      value: null,
      evidence: { kind: 'unknown', note: 'Review evaluation unknown.' },
    };
  delete profile.availability;
  profile.sourceTimestamp = 'unknown';
}

export function loadReviewEvalCases(
  workspace = resolve(here, '../..'),
): ReviewEvalCase[] {
  return readdirSync(caseDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const descriptor = JSON.parse(
        readFileSync(join(caseDirectory, file), 'utf8'),
      ) as Descriptor;
      const input = JSON.parse(
        readFileSync(resolve(workspace, descriptor.input), 'utf8'),
      ) as DesignInput;
      if (
        descriptor.variant === 'direct-feasible' ||
        descriptor.variant === 'latency-priority'
      )
        directFeasible(input);
      if (descriptor.variant === 'latency-priority')
        input.connections[0].experience.priorities = [
          'latency',
          'correctness',
          'availability',
          'simplicity',
          'cost',
        ];
      if (descriptor.variant === 'unknowns') unknowns(input);
      return {
        id: descriptor.id,
        input: validateInput(input),
        operationalContext: descriptor.operationalContext,
        expectedEngine: descriptor.expectedEngine,
        expectedAdoptable: descriptor.expectedAdoptable,
      };
    });
}
