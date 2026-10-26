import React, { useEffect, useState } from 'react';
import type {
  Connection,
  DesignInput,
  JsonObject,
  JsonValue,
  Operation,
  Priority,
} from '../../../../packages/plug/src/contracts/index';
import type { DraftFactKind } from '../../../../packages/plug/src/judgment/draft';
import {
  defaultPriorities,
  guardDocument,
} from '../../../../packages/plug/src/contracts/index';
import { ServerDiscovery } from './Discovery';
import { FactDrafting } from './FactDrafting';
import {
  addOperation,
  blankBinding,
  declared,
  downstreamOp,
  moveBlocked,
  moveOperation,
  pairTaken,
  retarget,
} from './model';
import type { Endpoint, Focus } from './model';
export const priorityLabels: Record<Priority, string> = {
  correctness: 'Correctness',
  latency: 'Latency',
  availability: 'Availability',
  simplicity: 'Simplicity',
  cost: 'Cost',
};
interface InspectorProps {
  input: DesignInput;
  /** Null when nothing is selected, such as after removing the last connection. */
  focus: Focus | null;
  /** Whether this is the local workbench, which can discover servers. */
  local: boolean;
  edit: (fn: (next: DesignInput) => void) => void;
  onFocus: (focus: Focus) => void;
  onHostAdded?: (systemId: string, name: string) => void;
  /** Removes the element with every connection that touches it. */
  onRemove: (focus: Focus) => void;
}
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** Pinned protocol versions and bindings used when an author switches protocol. */
const protocolDefaults = {
  http: { version: '1.1', binding: 'HTTP+JSON' },
  mcp: { version: '2025-11-25', binding: 'MCP' },
  a2a: { version: '1.0', binding: 'JSONRPC' },
} as const;
const factField = (
  label: string,
  value: number | null,
  onChange: (n: number | null) => void,
  step = 1,
) => (
  <label>
    {label}
    <input
      type="number"
      min="0"
      step={step}
      value={value ?? ''}
      placeholder="Unknown"
      onChange={(e) =>
        onChange(e.target.value === '' ? null : Number(e.target.value))
      }
    />
  </label>
);
const tri = (v: boolean | null) => String(v);
const fromTri = (v: string) => (v === 'null' ? null : v === 'true');
/**
 * Declarations this edge still lacks. Plug never fills them in: unknown facts
 * stay unknown, and these name the fields whose verdicts are waiting.
 */
interface NeededFact {
  id: string;
  label: string;
  draftKind?: DraftFactKind;
}
function factsStillNeeded(input: DesignInput, conn: Connection): NeededFact[] {
  const out: NeededFact[] = [];
  const add = (id: string, label: string, draftKind?: DraftFactKind) =>
    out.push({ id, label, ...(draftKind ? { draftKind } : {}) });
  const op = downstreamOp(input, conn);
  const exp = conn.experience;
  if (!op.semantics.outputMeaning)
    add('output-meaning', 'Downstream output meaning', 'output-meaning');
  if (exp.finalDeadlineMs === null) add('final-deadline', 'Final deadline');
  if ((exp.availabilityTarget?.value ?? null) === null)
    add('availability-target', 'Availability target');
  if (exp.lostRequestAllowed === null)
    add('lost-request-tolerance', 'Lost-request tolerance');
  if (conn.workload.requestsPerMinute.value === null)
    add('requests-per-minute', 'Requests / minute');
  if (conn.workload.keyCount.value === null)
    add('distinct-keys', 'Distinct keys');
  if (conn.profile.latencyMs.value === null)
    add('source-latency', 'Source latency');
  if (conn.profile.timeoutMs.value === null)
    add('hard-timeout', 'Hard timeout');
  if (conn.profile.changeIntervalMs.value === null)
    add('change-interval', 'Typical change interval');
  if (conn.profile.callsPerMinute.value === null)
    add('calls-per-minute', 'Upstream calls / minute', 'calls-per-minute');
  if ((conn.profile.availability?.value ?? null) === null)
    add('downstream-availability', 'Downstream availability');
  if (conn.profile.sourceTimestamp === 'unknown')
    add('source-timestamp', 'Source timestamp meaning');
  if (op.semantics.cachePermission === null)
    add('cache-permission', 'Source cache permission');
  const pathNames = (
    [
      ['agentMs', 'agent'],
      ['networkMs', 'network'],
      ['mappingMs', 'mapping'],
      ['renderingMs', 'rendering'],
      ['cacheLookupMs', 'cache lookup'],
      ['deliveryAllowanceMs', 'delivery allowance'],
    ] as const
  )
    .filter(([key]) => conn.remainingPath[key].value === null)
    .map(([, name]) => name);
  if (pathNames.length)
    add('caller-path', `Caller path (${pathNames.join(', ')})`);
  if (!conn.inputMapping.length)
    add('input-mappings', 'Input field mappings', 'contract-mappings');
  if (!conn.outputMapping.length)
    add('output-mappings', 'Output field mappings', 'contract-mappings');
  if (
    [conn.callerSystemId, conn.downstreamSystemId].some(
      (sid) =>
        (input.systems.find((s) => s.id === sid)?.trustDomain ?? null) === null,
    )
  )
    add('trust-domains', 'Trust domains (system panels)');
  return out;
}
export function Inspector(props: InspectorProps) {
  const { input, focus } = props;
  const body = !focus ? (
    <div className="inspector-heading">
      <span className="tag">Nothing selected</span>
      <p className="small">
        Select a system, operation or connection to edit it. Double-click empty
        canvas to add a system.
      </p>
    </div>
  ) : focus.kind === 'connection' ? (
    <ConnectionInspector key={focus.id} {...props} id={focus.id} />
  ) : focus.kind === 'operation' ? (
    <OperationInspector
      key={`${focus.systemId}\0${focus.operationId}`}
      {...props}
      systemId={focus.systemId}
      operationId={focus.operationId}
    />
  ) : (
    <SystemInspector {...props} systemId={focus.systemId} />
  );
  return (
    <aside id="inspector" className="inspector" aria-label="Inspector">
      {body}
      <div className="checks">
        <h3>Shared infrastructure</h3>
        {(['cacheAllowed', 'schedulingAllowed'] as const).map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={input.infrastructure[key]}
              onChange={(e) =>
                props.edit((d) => {
                  d.infrastructure[key] = e.target.checked;
                })
              }
            />
            {key === 'cacheAllowed'
              ? 'Cache infrastructure permitted'
              : 'Scheduling permitted'}
          </label>
        ))}
        <div className="fields">
          {(
            [
              ['cacheCapacity', 'Cache capacity (entries)'],
              ['memoryBytes', 'Cache memory (bytes)'],
              ['refreshConcurrency', 'Refresh concurrency'],
              [
                'foregroundReserveCallsPerMinute',
                'Foreground reserve (calls/min)',
              ],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min="0"
                step="1"
                value={input.infrastructure[key]}
                onChange={(e) =>
                  props.edit((d) => {
                    d.infrastructure[key] = Math.max(
                      0,
                      Number(e.target.value) || 0,
                    );
                  })
                }
              />
            </label>
          ))}
          {factField(
            'Scheduling allowance (ms)',
            input.infrastructure.schedulingAllowanceMs.value,
            (n) =>
              props.edit((d) => {
                d.infrastructure.schedulingAllowanceMs = declared(n);
              }),
          )}
          {factField(
            'Call budget / minute',
            input.infrastructure.callBudgetPerMinute,
            (n) =>
              props.edit((d) => {
                d.infrastructure.callBudgetPerMinute = n;
              }),
          )}
        </div>
      </div>
    </aside>
  );
}
function ConnectionInspector({
  input,
  edit,
  onRemove,
  local,
  id,
}: InspectorProps & { id: string }) {
  const conn = input.connections.find((c) => c.id === id)!;
  const editConnection = (fn: (c: Connection, d: DesignInput) => void) =>
    edit((d) =>
      fn(
        d.connections.find((c) => c.id === id)!,
        d,
      ),
    );
  const systemById = (sid: string) => input.systems.find((s) => s.id === sid)!;
  const priorities = conn.experience.priorities ?? defaultPriorities;
  const move = (i: number, j: number) =>
    editConnection((c) => {
      const next = [...priorities];
      [next[i], next[j]] = [next[j], next[i]];
      c.experience.priorities = next;
    });
  const needed = factsStillNeeded(input, conn);
  const draftKinds = [
    ...new Set(
      needed.flatMap((fact) => (fact.draftKind ? [fact.draftKind] : [])),
    ),
  ];
  const outputMeaning =
    downstreamOp(input, conn).semantics.outputMeaning ?? null;
  const usefulOutput = conn.experience.usefulOutput;
  const judgment = conn.semanticEquivalence ?? null;
  /** A judgment binds to its exact strings; edits void it. */
  const judgmentStale =
    judgment !== null &&
    (judgment.outputMeaning !== outputMeaning ||
      judgment.usefulOutput !== usefulOutput);
  const textsDiffer =
    !!usefulOutput && outputMeaning !== null && outputMeaning !== usefulOutput;
  const [judging, setJudging] = useState(false);
  const [judgeProblem, setJudgeProblem] = useState('');
  const judge = async () => {
    setJudging(true);
    setJudgeProblem('');
    try {
      const r = await fetch('/api/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputMeaning, usefulOutput }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        equivalent?: boolean | null;
        confidence?: number;
        rationale?: string;
        model?: string;
        at?: string;
        question?: string;
        questionVersion?: number;
      };
      if (!r.ok)
        throw new Error(data.error ?? `Judgment failed with HTTP ${r.status}.`);
      if (typeof data.equivalent !== 'boolean')
        throw new Error('The judgment returned no verdict.');
      editConnection((c) => {
        c.semanticEquivalence = {
          equivalent: data.equivalent!,
          outputMeaning: outputMeaning!,
          usefulOutput,
          evidence: {
            kind: 'judged',
            note: `${data.model}: ${data.rationale}`,
            ...(data.at ? { measuredAt: data.at } : {}),
            ...(typeof data.confidence === 'number'
              ? { confidence: data.confidence }
              : {}),
            source: {
              type: 'judgment',
              location: `${data.question}@v${data.questionVersion}`,
            },
          },
        };
      });
    } catch (e) {
      setJudgeProblem((e as Error).message);
    } finally {
      setJudging(false);
    }
  };
  return (
    <>
      <div className="inspector-heading">
        <span className="tag">Edge</span>
        <h3>{conn.id}</h3>
        <p className="small">
          {systemById(conn.callerSystemId).name} {conn.callerOperationId} →{' '}
          {systemById(conn.downstreamSystemId).name}{' '}
          {conn.downstreamOperationId}
        </p>
      </div>
      {needed.length > 0 && (
        <div className="facts-needed">
          <h3>Facts still needed</h3>
          <p className="small">
            Unknown facts stay unknown; these declarations are what the analysis
            is still waiting on for this edge.
          </p>
          <ul aria-label="Facts still needed">
            {needed.map((fact) => (
              <li key={fact.id}>{fact.label}</li>
            ))}
          </ul>
          <FactDrafting
            input={input}
            connection={conn}
            requested={draftKinds}
            local={local}
            editConnection={editConnection}
          />
        </div>
      )}
      <div className="fields connection-fields">
        {(['caller', 'downstream'] as const).map((end) => {
          const systemId =
            end === 'caller' ? conn.callerSystemId : conn.downstreamSystemId;
          const operationId =
            end === 'caller'
              ? conn.callerOperationId
              : conn.downstreamOperationId;
          const label = end === 'caller' ? 'Caller' : 'Downstream';
          const set = (sid: string, oid: string) =>
            editConnection((c, d) => {
              const pair =
                end === 'caller'
                  ? [sid, oid, c.downstreamSystemId, c.downstreamOperationId]
                  : [c.callerSystemId, c.callerOperationId, sid, oid];
              if (pair[0] === pair[2])
                throw new Error('A connection joins two different systems.');
              if (pairTaken(d, pair[0], pair[1], pair[2], pair[3], c.id))
                throw new Error('These operations are already connected.');
              if (end === 'caller') {
                c.callerSystemId = sid;
                c.callerOperationId = oid;
                c.inputMapping = [];
                c.outputMapping = [];
              } else retarget(c, sid, oid);
            });
          return (
            <React.Fragment key={end}>
              <label>
                {label} system
                <select
                  value={systemId}
                  onChange={(e) =>
                    set(
                      e.target.value,
                      systemById(e.target.value).operations[0].id,
                    )
                  }
                >
                  {input.systems
                    .filter((s) => s.id === systemId || s.operations.length)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {label} operation
                <select
                  value={operationId}
                  onChange={(e) => set(systemId, e.target.value)}
                >
                  {systemById(systemId).operations.map((op) => (
                    <option key={op.id}>{op.id}</option>
                  ))}
                </select>
              </label>
            </React.Fragment>
          );
        })}
      </div>
      <h3 id="inspector-experience" tabIndex={-1}>
        Required experience
      </h3>
      <div className="fields">
        <label>
          Useful initial output
          <input
            value={conn.experience.usefulOutput}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.usefulOutput = e.target.value;
              })
            }
          />
        </label>
        {(textsDiffer || judgment) && (
          <div className="judge-row">
            {judgment ? (
              <p className="small">
                Judged{' '}
                <strong>
                  {judgment.equivalent ? 'equivalent' : 'not equivalent'}
                </strong>{' '}
                · {judgment.evidence.note}
                {judgmentStale &&
                  ' — no longer applies: a compared text changed.'}{' '}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    editConnection((c) => {
                      delete c.semanticEquivalence;
                    })
                  }
                >
                  Clear judgment
                </button>
              </p>
            ) : local ? (
              <>
                <p className="small">
                  The required output and the downstream output meaning are
                  different texts, so the strict comparison fails. A recorded
                  judgment can qualify it.
                </p>
                <button
                  type="button"
                  disabled={judging}
                  onClick={() => void judge()}
                >
                  {judging ? 'Judging…' : 'Judge equivalence'}
                </button>
              </>
            ) : (
              <p className="small">
                The texts differ. Judgment runs in the local workbench: run{' '}
                <code>npx plug ui</code> in your project.
              </p>
            )}
            {judgeProblem && (
              <p className="small discovery-problem" role="alert">
                {judgeProblem}
              </p>
            )}
          </div>
        )}
        {factField(
          'Latency target (ms)',
          conn.experience.latencyTargetMs,
          (n) =>
            editConnection((c) => {
              c.experience.latencyTargetMs = n ?? 0;
            }),
        )}
        {factField('Maximum result age (ms)', conn.experience.maxAgeMs, (n) =>
          editConnection((c) => {
            c.experience.maxAgeMs = n;
          }),
        )}
        {factField(
          'First acknowledgement budget (ms)',
          conn.experience.firstAckMs ?? null,
          (n) =>
            editConnection((c) => {
              if (n === null) delete c.experience.firstAckMs;
              else c.experience.firstAckMs = n;
            }),
        )}
        {factField(
          'Availability target (0–1)',
          conn.experience.availabilityTarget?.value ?? null,
          (n) =>
            editConnection((c) => {
              if (n === null) delete c.experience.availabilityTarget;
              else c.experience.availabilityTarget = declared(n);
            }),
          0.001,
        )}
        {factField(
          'Final deadline (ms)',
          conn.experience.finalDeadlineMs,
          (n) =>
            editConnection((c) => {
              c.experience.finalDeadlineMs = n;
            }),
        )}
        <label>
          Lost requests
          <select
            value={tri(conn.experience.lostRequestAllowed ?? false)}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.lostRequestAllowed = fromTri(e.target.value);
              })
            }
          >
            <option value="false">Forbidden</option>
            <option value="true">Acceptable</option>
            <option value="null">Unknown</option>
          </select>
        </label>
        <label>
          Duplicate side effects
          <select
            value={String(conn.experience.duplicateEffectForbidden ?? true)}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.duplicateEffectForbidden =
                  e.target.value === 'true';
              })
            }
          >
            <option value="true">Forbidden</option>
            <option value="false">Acceptable</option>
          </select>
        </label>
        <label>
          Ordering requirement
          <select
            value={conn.experience.orderingRequired ?? 'none'}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.orderingRequired = e.target.value as 'perKey';
              })
            }
          >
            <option value="none">No ordering</option>
            <option value="perKey">Per key</option>
            <option value="global">Global</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Correctness
          <select
            value={conn.experience.correctness}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.correctness = e.target.value as 'live';
                c.experience.allowIndicative = e.target.value === 'indicative';
              })
            }
          >
            <option value="indicative">Indicative options are useful</option>
            <option value="live">Live source result required</option>
          </select>
        </label>
        <label>
          Latency scope
          <select
            value={conn.experience.scope}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.scope = e.target.value as 'warmHits';
              })
            }
          >
            <option value="trafficPercentile">Stated traffic percentile</option>
            <option value="warmHits">Eligible warm hits</option>
            <option value="everyRequest">Every request</option>
          </select>
        </label>
        {factField(
          'Target fraction (0–1)',
          conn.experience.targetPercentile,
          (n) =>
            editConnection((c) => {
              c.experience.targetPercentile = n ?? 0;
            }),
          0.01,
        )}
      </div>
      <div className="checks">
        <label>
          <input
            type="checkbox"
            checked={conn.experience.allowDeferred}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.allowDeferred = e.target.checked;
              })
            }
          />
          Later live updates permitted
        </label>
        <label>
          <input
            type="checkbox"
            checked={conn.experience.allowSlowMiss}
            onChange={(e) =>
              editConnection((c) => {
                c.experience.allowSlowMiss = e.target.checked;
              })
            }
          />
          Slow miss path permitted
        </label>
      </div>
      <div className="priorities">
        <h3>Priorities</h3>
        <p className="small">
          What this edge must favor. Ties among non-dominated architectures
          break in this order; Plug never trades away a security obligation.
        </p>
        <ol aria-label="Priority order">
          {priorities.map((p, i) => (
            <li key={p}>
              <span>{priorityLabels[p]}</span>
              <button
                className="text-button"
                aria-label={`Raise ${priorityLabels[p]}`}
                disabled={i === 0}
                onClick={() => move(i - 1, i)}
              >
                ↑
              </button>
              <button
                className="text-button"
                aria-label={`Lower ${priorityLabels[p]}`}
                disabled={i === priorities.length - 1}
                onClick={() => move(i + 1, i)}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      </div>
      <h3>Workload</h3>
      <div className="fields profile-fields">
        {factField(
          'Requests / minute',
          conn.workload.requestsPerMinute.value,
          (n) =>
            editConnection((c) => {
              c.workload.requestsPerMinute = declared(n);
            }),
        )}
        {factField(
          'Burst requests / minute',
          conn.workload.burstPerMinute?.value ?? null,
          (n) =>
            editConnection((c) => {
              c.workload.burstPerMinute = declared(n);
            }),
        )}
        {factField(
          'Hot-key coverage ceiling (0–1)',
          conn.workload.hotKeyShare.value,
          (n) =>
            editConnection((c) => {
              c.workload.hotKeyShare = declared(n);
            }),
          0.01,
        )}
        {factField('Distinct keys', conn.workload.keyCount.value, (n) =>
          editConnection((c) => {
            c.workload.keyCount = declared(n);
          }),
        )}
      </div>
      <h3>Downstream behavior</h3>
      <div className="fields profile-fields">
        {factField('Source latency (ms)', conn.profile.latencyMs.value, (n) =>
          editConnection((c) => {
            c.profile.latencyMs = declared(n);
          }),
        )}
        {factField('Hard timeout (ms)', conn.profile.timeoutMs.value, (n) =>
          editConnection((c) => {
            c.profile.timeoutMs = declared(n);
          }),
        )}
        {factField(
          'Typical change interval (ms)',
          conn.profile.changeIntervalMs.value,
          (n) =>
            editConnection((c) => {
              c.profile.changeIntervalMs = declared(n);
            }),
        )}
        {factField(
          'Upstream calls / minute',
          conn.profile.callsPerMinute.value,
          (n) =>
            editConnection((c) => {
              c.profile.callsPerMinute = declared(n);
            }),
        )}
        {factField('Concurrency limit', conn.profile.concurrency.value, (n) =>
          editConnection((c) => {
            c.profile.concurrency = declared(n);
          }),
        )}
        {factField(
          'Availability (0–1)',
          conn.profile.availability?.value ?? null,
          (n) =>
            editConnection((c) => {
              if (n === null) delete c.profile.availability;
              else c.profile.availability = declared(n);
            }),
          0.001,
        )}
        {factField(
          'Response size (bytes)',
          conn.profile.responseBytes.value,
          (n) =>
            editConnection((c) => {
              c.profile.responseBytes = declared(n);
            }),
        )}
        {factField(
          'Call cost (per call)',
          conn.profile.callCost.value,
          (n) =>
            editConnection((c) => {
              c.profile.callCost = declared(n);
            }),
          0.0001,
        )}
        {factField('Source lag (ms)', conn.profile.sourceLagMs.value, (n) =>
          editConnection((c) => {
            c.profile.sourceLagMs = declared(n);
          }),
        )}
        <label>
          Source timestamp
          <select
            value={conn.profile.sourceTimestamp}
            onChange={(e) =>
              editConnection((c) => {
                c.profile.sourceTimestamp = e.target.value as 'unknown';
              })
            }
          >
            <option value="requestStart">Request start</option>
            <option value="responseSnapshot">Response snapshot</option>
            <option value="observationOnly">Observation only</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Invalidation signal
          <select
            value={conn.profile.invalidation}
            onChange={(e) =>
              editConnection((c) => {
                c.profile.invalidation = e.target.value as 'unknown';
              })
            }
          >
            <option value="available">Available</option>
            <option value="none">None</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Source cache permission
          <select
            value={tri(downstreamOp(input, conn).semantics.cachePermission)}
            onChange={(e) =>
              editConnection((c, d) => {
                downstreamOp(d, c).semantics.cachePermission = fromTri(
                  e.target.value,
                );
              })
            }
          >
            <option value="true">Allowed</option>
            <option value="false">Disallowed</option>
            <option value="null">Unknown</option>
          </select>
        </label>
      </div>
      <h3>Caller path</h3>
      <p className="small">
        Everything on the caller&apos;s side of the live path; the deadline and
        first-response verdicts stay unknown until these are declared.
      </p>
      <div className="fields profile-fields">
        {factField(
          'Agent or model overhead (ms)',
          conn.remainingPath.agentMs.value,
          (n) =>
            editConnection((c) => {
              c.remainingPath.agentMs = declared(n);
            }),
        )}
        {factField('Network (ms)', conn.remainingPath.networkMs.value, (n) =>
          editConnection((c) => {
            c.remainingPath.networkMs = declared(n);
          }),
        )}
        {factField('Mapping (ms)', conn.remainingPath.mappingMs.value, (n) =>
          editConnection((c) => {
            c.remainingPath.mappingMs = declared(n);
          }),
        )}
        {factField(
          'Rendering (ms)',
          conn.remainingPath.renderingMs.value,
          (n) =>
            editConnection((c) => {
              c.remainingPath.renderingMs = declared(n);
            }),
        )}
        {factField(
          'Cache lookup (ms)',
          conn.remainingPath.cacheLookupMs.value,
          (n) =>
            editConnection((c) => {
              c.remainingPath.cacheLookupMs = declared(n);
            }),
        )}
        {factField(
          'Delivery allowance (ms)',
          conn.remainingPath.deliveryAllowanceMs.value,
          (n) =>
            editConnection((c) => {
              c.remainingPath.deliveryAllowanceMs = declared(n);
            }),
        )}
      </div>
      <MappingEditor
        input={input}
        conn={conn}
        editConnection={editConnection}
      />
      <button
        className="text-button"
        onClick={() => onRemove({ kind: 'connection', id })}
      >
        Remove {conn.id}
      </button>
    </>
  );
}
/** Property names of a structured contract, for mapping suggestions. */
const propertyNames = (schema: unknown): string[] =>
  schema &&
  typeof schema === 'object' &&
  !Array.isArray(schema) &&
  (schema as { properties?: unknown }).properties &&
  typeof (schema as { properties?: unknown }).properties === 'object' &&
  !Array.isArray((schema as { properties?: unknown }).properties)
    ? Object.keys((schema as { properties: object }).properties)
    : [];
function MappingEditor({
  input,
  conn,
  editConnection,
}: {
  input: DesignInput;
  conn: Connection;
  editConnection: (fn: (c: Connection, d: DesignInput) => void) => void;
}) {
  const callerOperation = input.systems
    .find((s) => s.id === conn.callerSystemId)!
    .operations.find((o) => o.id === conn.callerOperationId)!;
  const downstream = downstreamOp(input, conn);
  const sides = [
    {
      kind: 'inputMapping' as const,
      label: 'Input mapping · caller request → downstream request',
      from: propertyNames(callerOperation.inputSchema),
      to: propertyNames(downstream.inputSchema),
    },
    {
      kind: 'outputMapping' as const,
      label: 'Output mapping · downstream response → caller response',
      from: propertyNames(downstream.outputSchema),
      to: propertyNames(callerOperation.outputSchema),
    },
  ];
  return (
    <>
      <h3>Field mappings</h3>
      <p className="small">
        Explicit property mappings between the structured contracts. The
        contract verdict needs them to cover required fields in both directions.
      </p>
      {sides.map((side) => (
        <fieldset key={side.kind} className="mapping-editor">
          <legend>{side.label}</legend>
          {conn[side.kind].length === 0 && (
            <p className="small">No mappings declared.</p>
          )}
          <ul className="mapping-rows">
            {conn[side.kind].map((m, i) => (
              <li key={i}>
                <input
                  aria-label={`${side.kind === 'inputMapping' ? 'Input' : 'Output'} mapping ${i + 1} from`}
                  value={m.from}
                  placeholder="from property"
                  list={`${conn.id}-${side.kind}-from`}
                  onChange={(e) =>
                    editConnection((c) => {
                      c[side.kind][i] = {
                        ...c[side.kind][i],
                        from: e.target.value,
                      };
                    })
                  }
                />
                <span aria-hidden="true">→</span>
                <input
                  aria-label={`${side.kind === 'inputMapping' ? 'Input' : 'Output'} mapping ${i + 1} to`}
                  value={m.to}
                  placeholder="to property"
                  list={`${conn.id}-${side.kind}-to`}
                  onChange={(e) =>
                    editConnection((c) => {
                      c[side.kind][i] = {
                        ...c[side.kind][i],
                        to: e.target.value,
                      };
                    })
                  }
                />
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove ${side.kind === 'inputMapping' ? 'input' : 'output'} mapping ${i + 1}`}
                  onClick={() =>
                    editConnection((c) => {
                      c[side.kind].splice(i, 1);
                    })
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <datalist id={`${conn.id}-${side.kind}-from`}>
            {side.from.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <datalist id={`${conn.id}-${side.kind}-to`}>
            {side.to.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              editConnection((c) => {
                c[side.kind].push({ from: '', to: '' });
              })
            }
          >
            + Add {side.kind === 'inputMapping' ? 'input' : 'output'} mapping
          </button>
        </fieldset>
      ))}
    </>
  );
}
const asJsonObject = (value: JsonValue): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const credentialField = (name: string) =>
  /(authorization|api[-_. ]?key|access[-_. ]?token|refresh[-_. ]?token|client[-_. ]?secret|password|credential|cookie)/i.test(
    name,
  );
const environmentReference = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
function credentialValueProblem(value: JsonValue, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = credentialValueProblem(item, `${path}[${index}]`);
      if (issue) return issue;
    }
  } else if (asJsonObject(value))
    for (const [name, item] of Object.entries(value)) {
      const field = path ? `${path}.${name}` : name;
      if (
        credentialField(name) &&
        (typeof item !== 'string' || !environmentReference.test(item))
      )
        return `${field} may contain a credential; save an environment reference such as \${env:NAME}, never its value.`;
      const issue = credentialValueProblem(item, field);
      if (issue) return issue;
    }
  return null;
}
function JsonBindingField({
  label,
  value,
  validate,
  onCommit,
}: {
  label: string;
  value: JsonValue;
  validate: (value: JsonValue) => string | null;
  onCommit: (value: JsonValue) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [problem, setProblem] = useState('');
  useEffect(() => setDraft(serialized), [serialized]);
  const commit = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      guardDocument(parsed);
      if (
        parsed === undefined ||
        (typeof parsed === 'number' && !Number.isFinite(parsed))
      )
        throw new Error('Enter a JSON value.');
      const issue = validate(parsed as JsonValue);
      if (issue) throw new Error(issue);
      onCommit(parsed as JsonValue);
      setDraft(JSON.stringify(parsed, null, 2));
      setProblem('');
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <label>
      {label}
      <textarea
        rows={4}
        value={draft}
        maxLength={256 * 1024}
        spellCheck={false}
        aria-invalid={!!problem}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" className="text-button" onClick={commit}>
        Apply {label.toLowerCase()}
      </button>
      {problem && (
        <small className="discovery-problem" role="alert">
          {problem}
        </small>
      )}
    </label>
  );
}
function PointerField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const mode = value === null ? 'unknown' : value === '' ? 'root' : 'pointer';
  return (
    <>
      <label>
        {label}
        <select
          value={mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'unknown'
                ? null
                : e.target.value === 'root'
                  ? ''
                  : '/',
            )
          }
        >
          <option value="unknown">Unknown</option>
          <option value="root">Response root</option>
          <option value="pointer">JSON pointer</option>
        </select>
      </label>
      {mode === 'pointer' && (
        <label>
          {label} · RFC 6901
          <input
            value={value ?? ''}
            placeholder="/data"
            spellCheck={false}
            onChange={(e) => {
              if (!e.target.value || e.target.value.startsWith('/'))
                onChange(e.target.value);
            }}
          />
        </label>
      )}
    </>
  );
}
function BindingEditor({
  operation,
  protocol,
  editOperation,
}: {
  operation: Operation;
  protocol: 'http' | 'mcp' | 'a2a';
  editOperation: (fn: (operation: Operation) => void) => void;
}) {
  const binding = operation.binding;
  if (!binding)
    return (
      <>
        <h3>Request and response binding</h3>
        <p className="small">
          No bounded request recipe is declared. Add one to describe the
          operation without resolving credentials.
        </p>
        <button
          type="button"
          onClick={() =>
            editOperation((next) => {
              next.binding = blankBinding(protocol);
            })
          }
        >
          + Add binding
        </button>
      </>
    );
  const editBinding = (fn: (next: NonNullable<Operation['binding']>) => void) =>
    editOperation((next) => {
      fn(next.binding!);
    });
  const stringMap = (value: JsonValue) =>
    !asJsonObject(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
      ? 'Enter a JSON object whose values are strings.'
      : credentialValueProblem(value);
  const sampleList = (value: JsonValue) => {
    if (!Array.isArray(value) || value.some((sample) => !asJsonObject(sample)))
      return 'Enter a JSON array of request objects.';
    return credentialValueProblem(value);
  };
  return (
    <>
      <h3>Request binding</h3>
      <p className="small">
        Protocol <code>{binding.request.protocol}</code>. Environment references
        such as <code>{'${env:API_KEY}'}</code> are saved literally and resolved
        only by a local runner.
        {binding.request.protocol !== protocol &&
          ` This differs from the operation interface (${protocol}).`}
      </p>
      <div className="fields">
        <label>
          Method
          <input
            value={binding.request.method}
            maxLength={64}
            spellCheck={false}
            onChange={(e) =>
              editBinding((next) => {
                next.request.method = e.target.value;
              })
            }
          />
        </label>
        <label>
          Path template
          <input
            value={binding.request.pathTemplate}
            maxLength={2048}
            spellCheck={false}
            onChange={(e) =>
              editBinding((next) => {
                next.request.pathTemplate = e.target.value;
              })
            }
          />
        </label>
      </div>
      <JsonBindingField
        label="Query template JSON"
        value={binding.request.query}
        validate={stringMap}
        onCommit={(value) =>
          editBinding((next) => {
            next.request.query = value as Record<string, string>;
          })
        }
      />
      <JsonBindingField
        label="Header template JSON"
        value={binding.request.headers}
        validate={stringMap}
        onCommit={(value) =>
          editBinding((next) => {
            next.request.headers = value as Record<string, string>;
          })
        }
      />
      <JsonBindingField
        label="Body template JSON"
        value={binding.request.bodyTemplate}
        validate={credentialValueProblem}
        onCommit={(value) =>
          editBinding((next) => {
            next.request.bodyTemplate = value;
          })
        }
      />
      <JsonBindingField
        label="Sample JSON"
        value={binding.request.samples}
        validate={sampleList}
        onCommit={(value) =>
          editBinding((next) => {
            next.request.samples = value as JsonObject[];
            next.request.samplesEvidence = {
              kind: 'declared',
              note: 'Request samples entered by the author in the playground.',
            };
          })
        }
      />
      <h3>Response binding</h3>
      <div className="fields">
        <PointerField
          label="Response data pointer"
          value={binding.response.dataPointer}
          onChange={(value) =>
            editBinding((next) => {
              next.response.dataPointer = value;
            })
          }
        />
        <PointerField
          label="Snapshot pointer"
          value={binding.response.snapshotPointer}
          onChange={(value) =>
            editBinding((next) => {
              next.response.snapshotPointer = value;
            })
          }
        />
        <label>
          Snapshot header
          <input
            value={binding.response.snapshotHeader ?? ''}
            placeholder="Unknown"
            spellCheck={false}
            onChange={(e) =>
              editBinding((next) => {
                next.response.snapshotHeader = e.target.value || null;
              })
            }
          />
        </label>
        <label>
          Timestamp format
          <select
            value={binding.response.timestampFormat}
            onChange={(e) =>
              editBinding((next) => {
                next.response.timestampFormat = e.target.value as
                  | 'iso-8601'
                  | 'epoch-milliseconds'
                  | 'epoch-seconds'
                  | 'unknown';
              })
            }
          >
            <option value="unknown">Unknown</option>
            <option value="iso-8601">ISO 8601</option>
            <option value="epoch-milliseconds">Epoch milliseconds</option>
            <option value="epoch-seconds">Epoch seconds</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        className="text-button"
        onClick={() =>
          editOperation((next) => {
            delete next.binding;
          })
        }
      >
        Remove binding
      </button>
    </>
  );
}
function OperationInspector({
  input,
  edit,
  onFocus,
  onRemove,
  systemId,
  operationId,
}: InspectorProps & { systemId: string; operationId: string }) {
  const system = input.systems.find((s) => s.id === systemId)!;
  const op = system.operations.find((o) => o.id === operationId)!;
  const protocol =
    system.interfaces.find((face) => face.id === op.interfaceId)?.protocol ??
    system.interfaces[0].protocol;
  const editOp = (fn: (o: typeof op) => void) =>
    edit((d) =>
      fn(
        d.systems
          .find((s) => s.id === systemId)!
          .operations.find((o) => o.id === operationId)!,
      ),
    );
  const touching = input.connections.filter(
    (c) =>
      (c.callerSystemId === systemId && c.callerOperationId === operationId) ||
      (c.downstreamSystemId === systemId &&
        c.downstreamOperationId === operationId),
  );
  const [moveProblem, setMoveProblem] = useState('');
  const moveTo = (to: string | null) => {
    const from = { systemId, operationId };
    const why = moveBlocked(input, from, to);
    if (why) return setMoveProblem(why);
    let moved = null as Endpoint | null;
    edit((d) => {
      moved = moveOperation(d, from, to);
    });
    if (moved)
      onFocus(
        to === null
          ? { kind: 'system', systemId: moved.systemId }
          : { kind: 'operation', ...moved },
      );
  };
  return (
    <>
      <div className="inspector-heading">
        <span className="tag">Operation</span>
        <h3>{op.id}</h3>
        <p className="small">On {system.name}</p>
      </div>
      <div className="fields">
        <label>
          System
          <select
            value={systemId}
            aria-describedby={moveProblem ? 'inspector-move' : undefined}
            onChange={(e) => moveTo(e.target.value || null)}
          >
            {input.systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="">A new system</option>
          </select>
        </label>
        <label>
          Description
          <input
            value={op.description}
            onChange={(e) =>
              editOp((o) => {
                o.description = e.target.value;
              })
            }
          />
        </label>
        <label>
          Effect
          <select
            value={op.semantics.effect}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.effect = e.target.value as 'read';
              })
            }
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Idempotent
          <select
            value={tri(op.semantics.idempotent)}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.idempotent = fromTri(e.target.value);
              })
            }
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
            <option value="null">Unknown</option>
          </select>
        </label>
        <label>
          Cache permission
          <select
            value={tri(op.semantics.cachePermission)}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.cachePermission = fromTri(e.target.value);
              })
            }
          >
            <option value="true">Allowed</option>
            <option value="false">Disallowed</option>
            <option value="null">Unknown</option>
          </select>
        </label>
        <label>
          Accepts idempotency key
          <select
            value={tri(op.semantics.idempotencyKeySupported ?? null)}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.idempotencyKeySupported = fromTri(e.target.value);
              })
            }
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
            <option value="null">Unknown</option>
          </select>
        </label>
        <label>
          Output meaning
          <input
            value={op.semantics.outputMeaning ?? ''}
            placeholder="Unknown"
            onChange={(e) =>
              editOp((o) => {
                o.semantics.outputMeaning = e.target.value.trim()
                  ? e.target.value
                  : null;
              })
            }
          />
        </label>
        <label>
          Sharing scope
          <select
            value={op.semantics.scope}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.scope = e.target.value as 'public';
              })
            }
          >
            <option value="public">Public · same for every caller</option>
            <option value="user">Per user</option>
            <option value="tenant">Per tenant</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Key dimensions · comma separated
          <input
            value={op.semantics.keyDimensions.join(', ')}
            placeholder="None declared"
            onChange={(e) =>
              editOp((o) => {
                o.semantics.keyDimensions = e.target.value
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean);
              })
            }
          />
        </label>
        <label>
          Key dimensions complete
          <select
            value={tri(op.semantics.keysComplete)}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.keysComplete = fromTri(e.target.value);
              })
            }
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
            <option value="null">Unknown</option>
          </select>
        </label>
        <label>
          Requires live validation
          <select
            value={String(op.semantics.requiresLiveValidation)}
            onChange={(e) =>
              editOp((o) => {
                o.semantics.requiresLiveValidation = e.target.value === 'true';
              })
            }
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      </div>
      {moveProblem && (
        <p id="inspector-move" className="small" role="alert">
          {moveProblem}
        </p>
      )}
      <BindingEditor
        operation={op}
        protocol={protocol}
        editOperation={editOp}
      />
      <h3>Connections</h3>
      {touching.length ? (
        <ul className="link-list">
          {touching.map((c) => (
            <li key={c.id}>
              <button
                className="text-button"
                onClick={() => onFocus({ kind: 'connection', id: c.id })}
              >
                {c.id}
              </button>{' '}
              {c.callerSystemId === systemId ? 'calls' : 'serves'}{' '}
              {c.callerSystemId === systemId
                ? `${c.downstreamSystemId} ${c.downstreamOperationId}`
                : `${c.callerSystemId} ${c.callerOperationId}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">
          Not connected. Hover the operation and drag a + on its edge to an
          operation of another system, or click the + to choose one.
        </p>
      )}
      <button
        className="text-button"
        onClick={() => onRemove({ kind: 'operation', systemId, operationId })}
      >
        Remove {op.id}
        {touching.length ? ` and ${plural(touching.length, 'connection')}` : ''}
      </button>
    </>
  );
}
function SystemInspector({
  input,
  local,
  edit,
  onFocus,
  onHostAdded,
  onRemove,
  systemId,
}: InspectorProps & { systemId: string }) {
  const system = input.systems.find((s) => s.id === systemId)!;
  const editSystem = (fn: (s: typeof system) => void) =>
    edit((d) => fn(d.systems.find((s) => s.id === systemId)!));
  const face = system.interfaces[0];
  const links = input.connections.filter(
    (c) => c.callerSystemId === systemId || c.downstreamSystemId === systemId,
  ).length;
  return (
    <>
      <div className="inspector-heading">
        <span className="tag">System</span>
        <h3>{system.name}</h3>
      </div>
      <label>
        System name
        <input
          value={system.name}
          onChange={(e) =>
            editSystem((s) => {
              s.name = e.target.value;
            })
          }
        />
      </label>
      <div className="fields">
        <label>
          Protocol
          <select
            value={face.protocol}
            onChange={(e) =>
              editSystem((s) => {
                const protocol = e.target
                  .value as keyof typeof protocolDefaults;
                s.interfaces[0] = {
                  ...s.interfaces[0],
                  protocol,
                  ...protocolDefaults[protocol],
                };
              })
            }
          >
            <option value="http">HTTP</option>
            <option value="mcp">MCP</option>
            <option value="a2a">A2A</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={face.direction}
            onChange={(e) =>
              editSystem((s) => {
                s.interfaces[0].direction = e.target.value as 'calls';
              })
            }
          >
            <option value="calls">Can call</option>
            <option value="exposes">Exposes</option>
          </select>
        </label>
        <label>
          Trust domain
          <input
            value={system.trustDomain ?? ''}
            placeholder="Unknown"
            onChange={(e) =>
              editSystem((s) => {
                s.trustDomain = e.target.value.trim() ? e.target.value : null;
              })
            }
          />
        </label>
      </div>
      {face.direction === 'exposes' ? (
        <ServerDiscovery
          key={`${systemId}\0${face.protocol}`}
          input={input}
          system={system}
          local={local}
          edit={edit}
          onApplied={onHostAdded}
        />
      ) : (
        <p className="small">
          Set Direction to Exposes to enter this server&apos;s details and list
          its{' '}
          {face.protocol === 'mcp'
            ? 'tools'
            : face.protocol === 'a2a'
              ? 'skills'
              : 'operations'}
          .
        </p>
      )}
      <h3>Message channel</h3>
      <div className="fields">
        <label>
          Delivery
          <select
            value={system.messaging?.delivery ?? 'undeclared'}
            onChange={(e) =>
              editSystem((s) => {
                if (e.target.value === 'undeclared') delete s.messaging;
                else
                  s.messaging = {
                    ordering: 'unknown',
                    durable: null,
                    dlq: null,
                    ...s.messaging,
                    delivery: e.target.value as 'none',
                  };
              })
            }
          >
            <option value="undeclared">Not declared</option>
            <option value="none">None · synchronous request-reply</option>
            <option value="at-most-once">At most once</option>
            <option value="at-least-once">At least once</option>
            <option value="exactly-once-claimed">Exactly once (claimed)</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        {system.messaging && (
          <>
            <label>
              Channel ordering
              <select
                value={system.messaging.ordering}
                onChange={(e) =>
                  editSystem((s) => {
                    s.messaging!.ordering = e.target.value as 'none';
                  })
                }
              >
                <option value="none">None</option>
                <option value="key">Per key</option>
                <option value="global">Global</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label>
              Durable
              <select
                value={tri(system.messaging.durable)}
                onChange={(e) =>
                  editSystem((s) => {
                    s.messaging!.durable = fromTri(e.target.value);
                  })
                }
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
                <option value="null">Unknown</option>
              </select>
            </label>
            <label>
              Dead-letter queue
              <select
                value={tri(system.messaging.dlq)}
                onChange={(e) =>
                  editSystem((s) => {
                    s.messaging!.dlq = fromTri(e.target.value);
                  })
                }
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
                <option value="null">Unknown</option>
              </select>
            </label>
          </>
        )}
      </div>
      <h3>Operations</h3>
      {system.operations.length ? (
        <ul className="link-list">
          {system.operations.map((o) => (
            <li key={o.id}>
              <button
                className="text-button"
                onClick={() =>
                  onFocus({ kind: 'operation', systemId, operationId: o.id })
                }
              >
                {o.id}
              </button>{' '}
              {o.description}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">
          No operations yet.
          {face.direction === 'exposes'
            ? ` Add one, or list the server’s ${face.protocol === 'mcp' ? 'tools' : face.protocol === 'a2a' ? 'skills' : 'operations'} above.`
            : ''}
        </p>
      )}
      <button onClick={() => edit((d) => void addOperation(d, systemId))}>
        + Add operation
      </button>
      <button
        className="text-button"
        onClick={() => onRemove({ kind: 'system', systemId })}
      >
        Remove {system.name}
        {links ? ` and ${plural(links, 'connection')}` : ''}
      </button>
    </>
  );
}
