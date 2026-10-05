import React, { useState } from 'react';
import type {
  Connection,
  DesignInput,
  Priority,
} from '../../../../packages/plug/src/contracts/index';
import { defaultPriorities } from '../../../../packages/plug/src/contracts/index';
import { ServerDiscovery } from './Discovery';
import {
  addOperation,
  declared,
  downstreamOp,
  limits,
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
    <ConnectionInspector {...props} id={focus.id} />
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
      </div>
    </aside>
  );
}
function ConnectionInspector({
  input,
  edit,
  onRemove,
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
        {factField(
          'Hot-key coverage ceiling (0–1)',
          conn.workload.hotKeyShare.value,
          (n) =>
            editConnection((c) => {
              c.workload.hotKeyShare = declared(n);
            }),
          0.01,
        )}
        {factField(
          'Burst requests / minute',
          conn.workload.burstPerMinute?.value ?? null,
          (n) =>
            editConnection((c) => {
              c.workload.burstPerMinute = declared(n);
            }),
        )}
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
      <button
        className="text-button"
        onClick={() => onRemove({ kind: 'connection', id })}
      >
        Remove {conn.id}
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
      </div>
      {moveProblem && (
        <p id="inspector-move" className="small" role="alert">
          {moveProblem}
        </p>
      )}
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
      </div>
      {face.protocol !== 'http' &&
        (face.direction === 'exposes' ? (
          <ServerDiscovery
            key={`${systemId}\0${face.protocol}`}
            input={input}
            system={system}
            local={local}
            edit={edit}
          />
        ) : (
          <p className="small">
            Set Direction to Exposes to enter this server&apos;s details and
            list its {face.protocol === 'mcp' ? 'tools' : 'skills'}.
          </p>
        ))}
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
          {face.protocol !== 'http' && face.direction === 'exposes'
            ? ` Add one, or list the server’s ${face.protocol === 'mcp' ? 'tools' : 'skills'} above.`
            : ''}
        </p>
      )}
      <button
        disabled={system.operations.length >= limits.operations}
        onClick={() => edit((d) => void addOperation(d, systemId))}
      >
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
