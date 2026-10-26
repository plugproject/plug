import type {
  DesignInput,
  OperationManifest,
  ProbeEvent,
} from '../contracts/index';
import { validateInput } from '../contracts/index';
import { writeSpecBundle } from '../openspec/bundle';
import { applyOperationManifestWithReport } from './apply';
import { readAuthorizedHosts } from './hosts';
import { readOperationManifests, writeOperationManifests } from './index';
import { buildProbePlan, type ProbePlan, type ProbePlanOptions } from './plan';
import { createTypeSafeProbeChecker } from './questions';
import { runProbePlan } from './run';
import {
  draftRequestSample,
  requestSampleRequired,
  requestSampleDrafterFromEnv,
  type RequestSampleDrafter,
} from './samples';
import { summarizeProbe } from './summarize';

export interface ExecuteProbeOptions {
  workspace: string;
  systemId?: string;
  operationId?: string;
  plan?: ProbePlanOptions;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onEvent?: (event: ProbeEvent) => void;
  writeSpec?: boolean;
  sampleDrafter?: RequestSampleDrafter | null;
}

export interface ExecuteProbeResult {
  input: DesignInput;
  plan: ProbePlan;
  manifests: OperationManifest[];
  updatedConnectionIds: string[];
  revisionId: string | null;
}

/** Executes only the author-authorized, read-safe operations selected by a plan. */
export async function executeProbe(
  raw: unknown,
  options: ExecuteProbeOptions,
): Promise<ExecuteProbeResult> {
  const input = validateInput(raw);
  const completePlan = buildProbePlan(input, options.plan);
  const operations = completePlan.operations.filter(
    (operation) =>
      (!options.systemId || operation.systemId === options.systemId) &&
      (!options.operationId || operation.operationId === options.operationId),
  );
  if (!operations.length)
    throw new Error('No operation matches the requested probe selection.');
  const plan: ProbePlan = {
    ...completePlan,
    operations,
    totalPlannedCalls: operations.reduce(
      (total, operation) => total + operation.plannedCalls,
      0,
    ),
    callsByOrigin: Object.fromEntries(
      [...new Set(operations.map((operation) => operation.origin))]
        .filter((origin): origin is string => origin !== null)
        .map((origin) => [
          origin,
          operations
            .filter((operation) => operation.origin === origin)
            .reduce((total, operation) => total + operation.plannedCalls, 0),
        ]),
    ),
  };
  const runnable = operations.filter(
    (operation) => operation.safe && operation.executable,
  );
  if (!runnable.length)
    throw new Error(
      operations.map((operation) => operation.skippedReason).join(' ') ||
        'No selected operation is safe and executable.',
    );
  const env = options.env ?? process.env;
  const executionInput = structuredClone(input);
  const sampleDrafter =
    options.sampleDrafter === undefined
      ? requestSampleDrafterFromEnv(env)
      : options.sampleDrafter;
  for (const planned of runnable) {
    const operation = executionInput.systems
      .find((system) => system.id === planned.systemId)!
      .operations.find((candidate) => candidate.id === planned.operationId)!;
    if (operation.binding!.request.samples.length) continue;
    if (!requestSampleRequired(operation)) continue;
    if (!sampleDrafter)
      throw new Error(
        `${planned.systemId}/${planned.operationId} has no request sample. Declare one or configure PLUG_DRAFT_PROVIDER and PLUG_DRAFT_MODEL.`,
      );
    const drafted = await draftRequestSample(
      operation,
      sampleDrafter,
      options.signal,
    );
    operation.binding!.request.samples = [drafted.sample];
    operation.binding!.request.samplesEvidence = {
      kind: 'synthetic',
      note:
        `Ephemeral schema-validated request sample proposed by ${drafted.model}. ` +
        'It is used only for this bounded local probe and is not an operational fact.',
      source: { type: 'model-draft', location: drafted.model },
    };
    options.onEvent?.({
      formatVersion: input.formatVersion,
      systemId: planned.systemId,
      operationId: planned.operationId,
      at: new Date().toISOString(),
      type: 'plan',
      message: `Validated one ephemeral request sample from ${drafted.model}.`,
    });
  }
  const hosts = await readAuthorizedHosts(options.workspace);
  const runs = await runProbePlan({
    workspace: options.workspace,
    input: executionInput,
    plan,
    authorizedHosts: hosts,
    env: options.env,
    signal: options.signal,
    onEvent: options.onEvent,
  });
  const checker =
    env.TYPESAFE_API_KEY && env.PLUG_JUDGE_MODEL
      ? createTypeSafeProbeChecker(env.TYPESAFE_API_KEY, env.PLUG_JUDGE_MODEL)
      : undefined;
  const manifests: OperationManifest[] = [];
  let updatedInput = structuredClone(input);
  const updatedConnectionIds = new Set<string>();
  for (const run of runs) {
    const system = input.systems.find(
      (candidate) => candidate.id === run.systemId,
    )!;
    const operation = system.operations.find(
      (candidate) => candidate.id === run.operationId,
    )!;
    const usefulOutputs = input.connections
      .filter(
        (connection) =>
          connection.downstreamSystemId === run.systemId &&
          connection.downstreamOperationId === run.operationId,
      )
      .map((connection) => connection.experience.usefulOutput);
    const manifest = await summarizeProbe(run, {
      operationDescription: operation.description,
      outputMeaning: operation.semantics.outputMeaning,
      usefulOutputs,
      checker,
      signal: options.signal,
    });
    manifests.push(manifest);
    const applied = applyOperationManifestWithReport(updatedInput, manifest);
    updatedInput = applied.input;
    applied.updatedConnectionIds.forEach((id) => updatedConnectionIds.add(id));
  }
  const existing = await readOperationManifests(options.workspace);
  await writeOperationManifests(options.workspace, [...existing, ...manifests]);
  let revisionId: string | null = null;
  if (options.writeSpec !== false) {
    const written = await writeSpecBundle(
      options.workspace,
      updatedInput,
      'probe',
    );
    revisionId = written.revisionId;
  }
  return {
    input: updatedInput,
    plan,
    manifests,
    updatedConnectionIds: [...updatedConnectionIds].sort(),
    revisionId,
  };
}
