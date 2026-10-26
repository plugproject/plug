import { useState } from 'react';
import type {
  Connection,
  DesignInput,
  Evidence,
} from '../../../../packages/plug/src/contracts/index';
import type {
  DraftFactKind,
  DraftFactsRequest,
  DraftFactsResult,
  FactProposal,
} from '../../../../packages/plug/src/judgment/draft';
import { downstreamOp } from './model';

interface FactDraftingProps {
  input: DesignInput;
  connection: Connection;
  requested: DraftFactKind[];
  local: boolean;
  editConnection: (fn: (c: Connection, d: DesignInput) => void) => void;
}

const hiddenMetadataKey =
  /(?:url|uri|endpoint|header|authorization|credential|password|secret|token|fetchms)/i;
const hiddenMetadataValue =
  /(?:https?|wss?):\/\/|Bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]/i;

/** Removes transport locations, credentials and synthetic timing before model use. */
function scrubMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubMetadata);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !hiddenMetadataKey.test(key))
        .map(([key, item]) => [key, scrubMetadata(item)]),
    );
  if (typeof value === 'string' && hiddenMetadataValue.test(value))
    return '[redacted local-only value]';
  return value;
}

const boundedJson = (value: unknown) => JSON.stringify(value).slice(0, 4096);

/** Builds the only metadata bundle the local drafter is allowed to see. */
export function buildDraftRequest(
  input: DesignInput,
  connection: Connection,
  requested: DraftFactKind[],
): DraftFactsRequest {
  const caller = input.systems.find(
    (system) => system.id === connection.callerSystemId,
  )!;
  const downstream = input.systems.find(
    (system) => system.id === connection.downstreamSystemId,
  )!;
  const callerOperation = caller.operations.find(
    (operation) => operation.id === connection.callerOperationId,
  )!;
  const downstreamOperation = downstreamOp(input, connection);
  const contracts = {
    callerInput: callerOperation.inputSchema,
    callerOutput: callerOperation.outputSchema,
    downstreamInput: downstreamOperation.inputSchema,
    downstreamOutput: downstreamOperation.outputSchema,
  };
  const modelContracts = scrubMetadata(
    contracts,
  ) as DraftFactsRequest['basis']['contracts'];
  const sources: DraftFactsRequest['basis']['sources'] = [];
  const add = (id: string, label: string, value: string | undefined) => {
    const bounded = value?.trim().slice(0, 4096);
    if (bounded) sources.push({ id, label, text: bounded });
  };
  add(
    'caller-operation-description',
    'Caller operation description',
    callerOperation.description,
  );
  add(
    'downstream-operation-description',
    'Downstream operation description',
    downstreamOperation.description,
  );
  if (caller.metadata)
    add(
      'caller-system-metadata',
      'Caller system metadata',
      boundedJson(scrubMetadata(caller.metadata)),
    );
  if (callerOperation.metadata)
    add(
      'caller-operation-metadata',
      'Caller operation metadata',
      boundedJson(scrubMetadata(callerOperation.metadata)),
    );
  if (downstream.metadata)
    add(
      'downstream-system-metadata',
      'Downstream system metadata',
      boundedJson(scrubMetadata(downstream.metadata)),
    );
  if (downstreamOperation.metadata)
    add(
      'downstream-operation-metadata',
      'Downstream operation metadata',
      boundedJson(scrubMetadata(downstreamOperation.metadata)),
    );
  add(
    'contract-schemas',
    'Selected operation schemas',
    boundedJson(modelContracts),
  );
  return {
    version: 1,
    target: {
      connectionId: connection.id,
      callerSystemId: connection.callerSystemId,
      callerOperationId: connection.callerOperationId,
      downstreamSystemId: connection.downstreamSystemId,
      downstreamOperationId: connection.downstreamOperationId,
    },
    requested: [...new Set(requested)],
    basis: { sources, contracts: modelContracts },
  };
}

const proposalLabel = (proposal: FactProposal) =>
  proposal.kind === 'output-meaning'
    ? 'Downstream output meaning'
    : proposal.kind === 'contract-mappings'
      ? 'Contract mappings'
      : 'Upstream calls / minute';

/** Evidence written only after the author adopts a reviewed proposal. */
export function draftAdoptionEvidence(
  proposal: FactProposal,
  result: DraftFactsResult,
): Evidence {
  const quote = proposal.support.quote.replace(/\s+/g, ' ').slice(0, 500);
  const crossCheck = proposal.support.crossCheck;
  return {
    kind: 'declared',
    note:
      `${proposalLabel(proposal)} adopted by the author from ${result.model}. ` +
      `Supporting quote (${proposal.support.sourceId}): ${JSON.stringify(quote)}. ` +
      (crossCheck
        ? `Jev ${crossCheck.model} support probability: ${crossCheck.probability}.`
        : 'Jev cross-check was not configured.'),
    source: {
      type: 'model-draft',
      location: `${result.model}@${result.basisHash}`,
    },
    ...(crossCheck ? { confidence: crossCheck.probability } : {}),
  };
}

export function FactDrafting({
  input,
  connection,
  requested,
  local,
  editConnection,
}: FactDraftingProps) {
  const currentRequest = buildDraftRequest(input, connection, requested);
  const currentSignature = JSON.stringify(currentRequest.basis);
  const [drafting, setDrafting] = useState(false);
  const [problem, setProblem] = useState('');
  const [review, setReview] = useState<{
    result: DraftFactsResult;
    signature: string;
  } | null>(null);
  if (!requested.length) return null;
  if (!local)
    return (
      <p className="small">
        Fact drafting runs in the local workbench: run <code>npx plug ui</code>{' '}
        in your project.
      </p>
    );
  const stale = review !== null && review.signature !== currentSignature;
  const draft = async () => {
    setDrafting(true);
    setProblem('');
    try {
      const request = buildDraftRequest(input, connection, requested);
      const response = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = (await response.json().catch(() => ({}))) as
        DraftFactsResult | { error?: string };
      if (!response.ok)
        throw new Error(
          'error' in data
            ? (data.error ?? `Drafting failed with HTTP ${response.status}.`)
            : `Drafting failed with HTTP ${response.status}.`,
        );
      if (
        !('version' in data) ||
        data.version !== 1 ||
        !Array.isArray(data.proposals)
      )
        throw new Error('The drafter returned no proposal list.');
      setReview({ result: data, signature: JSON.stringify(request.basis) });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDrafting(false);
    }
  };
  const adopt = (proposal: FactProposal, index: number) => {
    if (!review || stale) {
      setProblem(
        'These proposals are stale; draft again from current metadata.',
      );
      return;
    }
    if (
      proposal.support.crossCheck &&
      proposal.support.crossCheck.probability < 0.7
    ) {
      setProblem('Jev did not confirm that the quote supports this fact.');
      return;
    }
    const evidence = draftAdoptionEvidence(proposal, review.result);
    editConnection((next, draftInput) => {
      if (proposal.kind === 'output-meaning') {
        const operation = downstreamOp(draftInput, next);
        operation.semantics.outputMeaning = proposal.value;
        operation.semantics.evidence = evidence;
      } else if (proposal.kind === 'contract-mappings') {
        next.inputMapping = structuredClone(proposal.value.input);
        next.outputMapping = structuredClone(proposal.value.output);
      } else {
        next.profile.callsPerMinute = {
          value: proposal.value,
          evidence,
        };
      }
    });
    setProblem('');
    setReview({
      ...review,
      result: {
        ...review.result,
        proposals: review.result.proposals.filter(
          (_item, proposalIndex) => proposalIndex !== index,
        ),
      },
    });
  };
  return (
    <div className="fact-drafting">
      <button type="button" disabled={drafting} onClick={() => void draft()}>
        {drafting ? 'Drafting…' : 'Draft missing facts'}
      </button>
      <p className="small">
        A model may propose only quote-backed facts. Nothing changes until you
        adopt a proposal.
      </p>
      {problem && (
        <p className="small discovery-problem" role="alert">
          {problem}
        </p>
      )}
      {review && (
        <div
          className="fact-proposals"
          role="region"
          aria-label="Draft fact proposals"
        >
          <p className="small">
            Drafted by <strong>{review.result.model}</strong>
            {stale && ' — stale: metadata changed.'}
          </p>
          {!review.result.proposals.length && (
            <p className="small">No quote-backed proposals were found.</p>
          )}
          {review.result.proposals.map((proposal, index) => {
            const source = currentRequest.basis.sources.find(
              (item) => item.id === proposal.support.sourceId,
            );
            const probability = proposal.support.crossCheck?.probability;
            const unsupported = probability !== undefined && probability < 0.7;
            return (
              <article
                className="fact-proposal"
                key={`${proposal.kind}-${index}`}
              >
                <h4>{proposalLabel(proposal)}</h4>
                <p className="small proposal-value">
                  {proposal.kind === 'contract-mappings'
                    ? `${proposal.value.input.length} input, ${proposal.value.output.length} output mappings`
                    : String(proposal.value)}
                </p>
                <blockquote>{proposal.support.quote}</blockquote>
                <p className="small">
                  Source: {source?.label ?? proposal.support.sourceId}.{' '}
                  {proposal.support.rationale}
                </p>
                <p className="small">
                  {proposal.support.crossCheck
                    ? `Jev ${proposal.support.crossCheck.model}: ${Math.round(
                        proposal.support.crossCheck.probability * 100,
                      )}% support.`
                    : 'Jev cross-check not configured.'}
                </p>
                <button
                  type="button"
                  disabled={stale || unsupported}
                  onClick={() => adopt(proposal, index)}
                >
                  Adopt {proposalLabel(proposal)}
                </button>
              </article>
            );
          })}
          <button
            type="button"
            className="text-button"
            onClick={() => setReview(null)}
          >
            Clear proposals
          </button>
        </div>
      )}
    </div>
  );
}
