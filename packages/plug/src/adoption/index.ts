import type { DesignInput, Evidence } from '../contracts/index';
import { validateInput } from '../contracts/index';
import { effectiveArchitectureId, suggestDesign } from '../recommender/index';

export class AdoptionError extends Error {}

export interface AdoptDesignOptions {
  architectureId: string;
  patterns?: string[];
  evidence: Evidence;
}

/**
 * Pins an architecture only after the deterministic planner re-checks the
 * exact pattern set. A review or model can propose; it cannot bypass this gate.
 */
export function adoptDesign(
  raw: unknown,
  connectionId: string,
  options: AdoptDesignOptions,
): {
  input: DesignInput;
  design: ReturnType<typeof suggestDesign>;
} {
  const input = validateInput(raw);
  const current = suggestDesign(input);
  const report = current.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  );
  const connection = input.connections.find(
    (candidate) => candidate.id === connectionId,
  );
  if (!report || !connection)
    throw new AdoptionError(`Unknown connection ${connectionId}.`);
  const known = report.architectures.find(
    (candidate) => candidate.id === options.architectureId,
  );
  const patterns = options.patterns ?? known?.patterns;
  if (!patterns?.length)
    throw new AdoptionError(
      'Adoption requires the exact architecture pattern set.',
    );
  if (
    options.evidence.kind !== 'declared' &&
    options.evidence.kind !== 'judged'
  )
    throw new AdoptionError('Adoption evidence must be declared or judged.');
  const updated = structuredClone(input);
  const target = updated.connections.find(
    (candidate) => candidate.id === connectionId,
  )!;
  target.adoptedArchitecture = {
    architectureId: options.architectureId,
    patterns: [...new Set(patterns)],
    catalogVersion: current.catalogVersion,
    evidence: structuredClone(options.evidence),
  };
  const design = suggestDesign(updated);
  const checked = design.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  )!;
  if (
    checked.adoption?.status !== 'honored' ||
    effectiveArchitectureId(checked) !== options.architectureId
  )
    throw new AdoptionError(
      `The deterministic planner did not honor this adoption: ${
        checked.adoption?.reason ?? 'architecture is not feasible'
      }`,
    );
  return { input: updated, design };
}

export function clearAdoptedDesign(
  raw: unknown,
  connectionId: string,
): {
  input: DesignInput;
  design: ReturnType<typeof suggestDesign>;
} {
  const input = validateInput(raw);
  const updated = structuredClone(input);
  const connection = updated.connections.find(
    (candidate) => candidate.id === connectionId,
  );
  if (!connection)
    throw new AdoptionError(`Unknown connection ${connectionId}.`);
  connection.adoptedArchitecture = null;
  return { input: updated, design: suggestDesign(updated) };
}
