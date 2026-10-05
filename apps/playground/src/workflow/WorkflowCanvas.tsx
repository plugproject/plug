import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useConnection,
  useNodesState,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type {
  Connection as FlowConnection,
  Edge,
  EdgeChange,
  EdgeProps,
  Node,
  NodeChange,
  NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  Connection,
  DesignInput,
  Operation,
  Priority,
  SystemDescription,
} from '../../../../packages/plug/src/contracts/index';
import { defaultPriorities } from '../../../../packages/plug/src/contracts/index';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import {
  connectionEdgeId,
  edgeLabelId,
  edgeLabelSize,
  layoutWorkflow,
  operationNodeId,
  parseOperationNodeId,
  structureKey,
  systemNodeId,
} from './layout';
import type { Box } from './layout';
import {
  addOperation,
  connectBlocked,
  freePartnersFor,
  limits,
  moveBlocked,
  moveOperation,
  reconnectBlocked,
  renameOperation,
  uniqueId,
} from './model';
import type { Endpoint, Focus } from './model';
export interface ConnectionOutcome {
  label: string;
  status: string;
}
export interface WorkflowCanvasProps {
  input: DesignInput;
  /** Null when nothing is focused, such as after removing the last connection. */
  focus: Focus | null;
  /** Per connection ID, only for a fresh analysis of this exact input. */
  outcomes: Record<string, ConnectionOutcome> | null;
  /** The canvas grows in fullscreen; the view refits once it has. */
  fullscreen: boolean;
  /** Add connection mode: click the calling operation, then the one it calls. */
  linking: boolean;
  onLinkingChange: (linking: boolean) => void;
  /** Announced over the canvas, such as what a removal took with it. */
  note: { text: string; n: number } | null;
  onFocus: (focus: Focus) => void;
  /** Focuses an element and brings its inspector fields into view. */
  onInspect: (focus: Focus) => void;
  onConnect: (from: Endpoint, to: Endpoint) => void;
  onReconnect: (connectionId: string, from: Endpoint, to: Endpoint) => void;
  onDelete: (focus: Focus) => void;
  /** Adds a system connected to this operation; used when an edge drops on empty canvas. */
  onSpawn: (at: Endpoint, as: 'caller' | 'downstream') => void;
  onAddSystem: () => void;
  onToggleFullscreen: () => void;
  /** Applies a validated edit to the input. */
  onEdit: (fn: (next: DesignInput) => void) => void;
}
const short: Record<Priority, string> = {
  correctness: 'Correctness',
  latency: 'Latency',
  availability: 'Availability',
  simplicity: 'Simplicity',
  cost: 'Cost',
};
/** Applies an edit, or returns why it was rejected. */
type Commit = (value: string) => string | null;
/** An in-place edit that a menu can also open. */
type InlineEdit = { commit: Commit; requested: boolean; onOpened: () => void };
/** A graph action button; when blocked, it is disabled and the title says why. */
type Action = { blocked: string | null; run: (button: HTMLElement) => void };
/** The + connector on the calling (out) or called (in) side of an operation. */
type Side = 'in' | 'out';
/** How an operation shows while a connection is drawn or picked. */
type Mark = 'origin' | 'valid' | 'invalid' | 'pick';
/** The operation picked first while adding a connection, and the end it takes. */
type Pick = Endpoint & { as: 'caller' | 'downstream' };
type SystemData = {
  system: SystemDescription;
  role: string;
  focused: boolean;
  /** Whether the operation being dragged over this group may move into it. */
  drop: 'accept' | 'reject' | null;
  onFocus: () => void;
  rename: InlineEdit;
  addOperation: Action;
  remove: Action;
};
type OperationData = {
  operation: Operation;
  links: number;
  focused: boolean;
  mark: Mark | null;
  /** Focuses the operation, or picks it while adding a connection. */
  onClick: () => void;
  onConnector: (side: Side, at: HTMLElement) => void;
  rename: InlineEdit;
  remove: Action;
};
type EdgeData = {
  connection: Connection;
  outcome: ConnectionOutcome | null;
  focused: boolean;
  /** Laid-out label centre; null once either system group has been dragged. */
  anchor: { x: number; y: number } | null;
  onFocus: () => void;
  onMenu: (e: React.MouseEvent) => void;
  latency: InlineEdit;
  inspect: Action;
  remove: Action;
};
type SystemNode = Node<SystemData, 'system'>;
type OperationNode = Node<OperationData, 'operation'>;
type ConnectionEdge = Edge<EdgeData, 'connection'>;
type MenuTarget =
  | { kind: 'pane' }
  | { kind: 'system'; systemId: string }
  | ({ kind: 'operation'; connect?: 'calls' | 'serves' } & Endpoint)
  | { kind: 'connection'; id: string };
/** Where a dragged operation would go: into another system, or a new one when `to` is null. */
type Drop = {
  from: Endpoint;
  to: string | null;
  home: boolean;
  blocked: string | null;
};
type Rect = { x: number; y: number; width: number; height: number };
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const same = (a: Endpoint, b: Endpoint) =>
  a.systemId === b.systemId && a.operationId === b.operationId;
const endpoint = ({ systemId, operationId }: Endpoint): Endpoint => ({
  systemId,
  operationId,
});
/** Double-click, F2 or a menu opens it; Enter or leaving commits, Escape cancels. */
function useInlineEdit({ commit, requested, onOpened }: InlineEdit) {
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState('');
  const open = () => {
    setProblem('');
    setEditing(true);
  };
  useEffect(() => {
    if (!requested) return;
    open();
    onOpened();
  }, [requested]);
  const triggers = {
    onDoubleClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        open();
      }
    },
  };
  const field = (value: string, label: string, type = 'text') =>
    editing ? (
      <InlineField
        value={value}
        label={label}
        type={type}
        problem={problem}
        onDone={(next) => {
          if (next === null || next === value) return setEditing(false);
          const why = commit(next);
          if (why) setProblem(why);
          else setEditing(false);
        }}
      />
    ) : null;
  return { editing, triggers, field };
}
function InlineField(props: {
  value: string;
  label: string;
  type: string;
  problem: string;
  onDone: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = value === null || value === props.value;
    props.onDone(value);
  };
  useEffect(() => {
    done.current = false;
  }, [props.problem]);
  return (
    <span className="wf-inline nodrag nopan">
      <input
        aria-label={props.label}
        aria-invalid={!!props.problem}
        type={props.type}
        min={props.type === 'number' ? 1 : undefined}
        autoFocus
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(draft.trim());
          if (e.key === 'Escape') finish(null);
        }}
        onBlur={() => finish(draft.trim())}
      />
      {props.problem && <small role="alert">{props.problem}</small>}
    </span>
  );
}
function IconButton(props: {
  glyph: string;
  label: string;
  hint: string;
  action: Action;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.action.blocked ?? props.hint}
      disabled={!!props.action.blocked}
      onClick={(e) => {
        // Selecting the node as well would move focus away from the result.
        e.stopPropagation();
        props.action.run(e.currentTarget);
      }}
    >
      {props.glyph}
    </button>
  );
}
function SystemGroup({ data }: NodeProps<SystemNode>) {
  const { system } = data;
  const edit = useInlineEdit(data.rename);
  const className = [
    'wf-system',
    data.focused && 'focused',
    data.drop && `drop-${data.drop}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <div className="wf-system-head">
        {edit.field(system.name, `Rename system ${system.name}`) ?? (
          <button
            className="wf-system-title"
            onClick={data.onFocus}
            {...edit.triggers}
            aria-label={`System ${system.name}`}
            title="Double-click or F2 to rename; right-click for more"
          >
            <strong>{system.name}</strong>
            <small>
              {system.interfaces[0]?.protocol.toUpperCase()} · {data.role}
            </small>
          </button>
        )}
        <span className="wf-node-actions nodrag nopan">
          <IconButton
            glyph="+"
            label={`Add operation to ${system.name}`}
            hint="Add an operation"
            action={data.addOperation}
          />
          <IconButton
            glyph="×"
            label={`Remove system ${system.name}`}
            hint="Remove this system with its operations and their connections"
            action={data.remove}
          />
        </span>
      </div>
      {!system.operations.length && (
        <p className="wf-system-empty">
          No operations yet. Double-click here or use + to add one.
        </p>
      )}
    </div>
  );
}
/** Drag it to an operation of another system, or click it to choose one. */
function Connector({ side, data }: { side: Side; data: OperationData }) {
  const out = side === 'out',
    id = data.operation.id;
  const open = (e: React.SyntheticEvent<HTMLDivElement>) => {
    // Selecting the node would move focus away from the list it opens.
    e.stopPropagation();
    data.onConnector(side, e.currentTarget);
  };
  return (
    <Handle
      id={`plus-${side}`}
      type={out ? 'source' : 'target'}
      position={out ? Position.Right : Position.Left}
      className="wf-plus"
      role="button"
      tabIndex={0}
      aria-label={out ? `Connect ${id}` : `Connect a caller to ${id}`}
      title={
        out
          ? 'Drag to the operation this one calls, or click to choose it'
          : 'Drag to the operation that calls this one, or click to choose it'
      }
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open(e);
      }}
    >
      <span aria-hidden="true">+</span>
    </Handle>
  );
}
function OperationCard({ data }: NodeProps<OperationNode>) {
  const o = data.operation,
    s = o.semantics;
  const edit = useInlineEdit(data.rename);
  const className = [
    'wf-operation',
    data.focused && 'focused',
    data.mark && `mark-${data.mark}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="wf-port"
      />
      <Connector side="in" data={data} />
      {edit.field(o.id, `Rename operation ${o.id}`) ?? (
        <button
          onClick={data.onClick}
          {...edit.triggers}
          aria-label={`Operation ${o.id}`}
          title="Double-click or F2 to rename; drag onto another system or empty canvas to move it"
        >
          <strong>{o.id}</strong>
          <small>
            {s.effect} · cache{' '}
            {s.cachePermission === null
              ? 'unknown'
              : s.cachePermission
                ? 'allowed'
                : 'disallowed'}{' '}
            · {data.links} {data.links === 1 ? 'link' : 'links'}
          </small>
        </button>
      )}
      <span className="wf-node-actions nodrag nopan">
        <IconButton
          glyph="×"
          label={`Remove operation ${o.id}`}
          hint="Remove this operation and its connections"
          action={data.remove}
        />
      </span>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="wf-port"
      />
      <Connector side="out" data={data} />
      {/* The whole card accepts a dropped connection; inactive until one is drawn. */}
      <Handle
        id="drop-in"
        type="target"
        position={Position.Left}
        isConnectableStart={false}
        className="wf-drop"
      />
      <Handle
        id="drop-out"
        type="source"
        position={Position.Right}
        isConnectableStart={false}
        className="wf-drop"
      />
    </div>
  );
}
function ConnectionLine(props: EdgeProps<ConnectionEdge>) {
  const { connection: c, outcome, focused, anchor, onFocus } = props.data!;
  const edit = useInlineEdit(props.data!.latency);
  const [direct, midX, midY] = getBezierPath(props);
  const labelX = anchor?.x ?? midX,
    labelY = anchor?.y ?? midY;
  let path = direct;
  if (anchor) {
    const forward = props.sourceX <= labelX,
      half = edgeLabelSize.width / 2;
    const [into] = getBezierPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: Position.Right,
      targetX: forward ? labelX - half : labelX + half,
      targetY: labelY,
      targetPosition: forward ? Position.Left : Position.Right,
    });
    const [out] = getBezierPath({
      sourceX: forward ? labelX + half : labelX - half,
      sourceY: labelY,
      sourcePosition: forward ? Position.Right : Position.Left,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: Position.Left,
    });
    path = `${into} ${out}`;
  }
  const priorities = c.experience.priorities ?? defaultPriorities;
  const className = `wf-edge-label nodrag nopan${focused ? ' focused' : ''}${outcome ? ` ${outcome.status}` : ''}`;
  const style = {
    transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
  };
  const summary = (
    <>
      <strong>{c.id}</strong>
      <span>
        {priorities
          .slice(0, 3)
          .map((p) => short[p])
          .join(' › ')}
      </span>
    </>
  );
  const latency = edit.field(
    String(c.experience.latencyTargetMs),
    `Latency target for ${c.id} (ms)`,
    'number',
  );
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} />
      <EdgeLabelRenderer>
        {latency ? (
          <div className={className} style={style}>
            {summary}
            <small>Latency target (ms)</small>
            {latency}
          </div>
        ) : (
          <div
            className={className}
            style={style}
            onContextMenu={props.data!.onMenu}
          >
            <button
              className="wf-edge-main"
              aria-pressed={focused}
              onClick={onFocus}
              {...edit.triggers}
              aria-label={`Connection ${c.id}`}
              title="Double-click or F2 to set the latency target; right-click for more"
            >
              {summary}
              <small>
                ≤ {c.experience.latencyTargetMs.toLocaleString()} ms ·{' '}
                {outcome ? outcome.label : 'not analyzed'}
              </small>
            </button>
            <span className="wf-node-actions nodrag nopan">
              <IconButton
                glyph="✎"
                label={`Edit requirements of ${c.id}`}
                hint="Edit this connection's required experience and priorities"
                action={props.data!.inspect}
              />
              <IconButton
                glyph="×"
                label={`Remove connection ${c.id}`}
                hint="Remove this connection"
                action={props.data!.remove}
              />
            </span>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
/** The line from the picked operation to the pointer, or to a valid operation under it. */
function LinkPreview(props: {
  from: string;
  side: Side;
  to: string | null;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const { from, side, to, container } = props;
  const flow = useReactFlow();
  const [path, setPath] = useState('');
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const track = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      pointer.current = { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const centre = (box: DOMRect, nodeId: string, handle: Side) => {
      const n = flow.getInternalNode(nodeId);
      const h = n?.internals.handleBounds?.[
        handle === 'out' ? 'source' : 'target'
      ]?.find((x) => x.id === handle);
      if (!n || !h) return null;
      const p = flow.flowToScreenPosition({
        x: n.internals.positionAbsolute.x + h.x + h.width / 2,
        y: n.internals.positionAbsolute.y + h.y + h.height / 2,
      });
      return { x: p.x - box.left, y: p.y - box.top };
    };
    let frame = requestAnimationFrame(function draw() {
      const box = el.getBoundingClientRect();
      const start = centre(box, from, side);
      const end =
        (to && centre(box, to, side === 'out' ? 'in' : 'out')) ??
        pointer.current;
      setPath(
        start && end
          ? getBezierPath({
              sourceX: start.x,
              sourceY: start.y,
              sourcePosition: side === 'out' ? Position.Right : Position.Left,
              targetX: end.x,
              targetY: end.y,
              targetPosition: side === 'out' ? Position.Left : Position.Right,
            })[0]
          : '',
      );
      frame = requestAnimationFrame(draw);
    });
    el.addEventListener('pointermove', track);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', track);
    };
  }, [container, flow, from, side, to]);
  return path ? (
    <svg className="wf-link-preview" aria-hidden="true">
      <path d={path} />
    </svg>
  ) : null;
}
const nodeTypes = { system: SystemGroup, operation: OperationCard };
const edgeTypes = { connection: ConnectionLine };
function Canvas({
  input,
  focus,
  outcomes,
  fullscreen,
  linking,
  onLinkingChange,
  note,
  onFocus,
  onInspect,
  onConnect,
  onReconnect,
  onDelete,
  onSpawn,
  onAddSystem,
  onToggleFullscreen,
  onEdit,
}: WorkflowCanvasProps) {
  const flow = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const reconnecting = useRef<string | null>(null);
  const attempt = useCallback(
    (fn: (next: DesignInput) => void): string | null => {
      try {
        fn(structuredClone(input));
      } catch (e) {
        return (e as Error).message;
      }
      onEdit(fn);
      return null;
    },
    [input, onEdit],
  );
  const [boxes, setBoxes] = useState<Map<string, Box> | null>(null);
  const [tick, setTick] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<
    SystemNode | OperationNode
  >([]);
  const [menu, setMenu] = useState<{
    n: number;
    at: { x: number; y: number };
    target: MenuTarget;
  } | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  /** Node or edge ID whose in-place edit a menu asked to open. */
  const [request, setRequest] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drop | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    n: number;
    tone: 'info' | 'blocked';
  } | null>(null);
  const notices = useRef(0);
  const [linkFrom, setLinkFrom] = useState<Pick | null>(null);
  /** The operation node under the pointer while adding a connection. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Origin node and handle type while a connection or reconnection is dragged. */
  const connectFrom = useConnection((c) =>
    c.inProgress ? `${c.fromNode.id}\u0001${c.fromHandle.type}` : null,
  );
  const connectTo = useConnection((c) =>
    c.inProgress ? (c.toNode?.id ?? '') : null,
  );
  const key = structureKey(input);
  useEffect(() => {
    let live = true;
    void layoutWorkflow(input).then((laid) => {
      if (live) setBoxes(laid);
    });
    return () => {
      live = false;
    };
    // Layout depends only on structure, so renames keep positions.
  }, [key, tick]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const announce = (text: string, tone: 'info' | 'blocked') =>
    setNotice({ text, tone, n: ++notices.current });
  const say = (text: string) => announce(text, 'blocked');
  useEffect(() => {
    if (note) announce(note.text, 'info');
  }, [note]);
  const exists = (e: Endpoint) =>
    input.systems.some(
      (s) =>
        s.id === e.systemId && s.operations.some((o) => o.id === e.operationId),
    );
  useEffect(() => {
    if (!linking || (linkFrom && !exists(linkFrom))) {
      setLinkFrom(null);
      setHovered(null);
    }
  }, [linking, input]);
  useEffect(() => {
    // An open menu handles its own Escape first.
    if (!linking || menu) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onLinkingChange(false);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [linking, menu, onLinkingChange]);
  const systemLabel = (id: string) => {
    const s = input.systems.find((x) => x.id === id)!;
    return input.systems.some((x) => x.id !== id && x.name === s.name)
      ? `${s.name} (${s.id})`
      : s.name;
  };
  const connectionLimit = () =>
    input.connections.length >= limits.connections
      ? 'Twelve connections is the alpha limit.'
      : null;
  const addOperationBlocked = (s: SystemDescription) =>
    s.operations.length >= limits.operations
      ? 'Four operations per system is the alpha limit.'
      : null;
  const addOperationTo = (systemId: string) => {
    const s = input.systems.find((x) => x.id === systemId)!;
    const id = uniqueId(
      'operation',
      s.operations.map((o) => o.id),
    );
    const why = attempt((d) => void addOperation(d, systemId));
    if (why) say(why);
    else onFocus({ kind: 'operation', systemId, operationId: id });
  };
  const move = (from: Endpoint, to: string | null) => {
    let moved = null as Endpoint | null;
    const why = attempt((d) => {
      moved = moveOperation(d, from, to);
    });
    if (why) return say(why);
    if (!moved) return;
    onFocus(
      to === null
        ? { kind: 'system', systemId: moved.systemId }
        : { kind: 'operation', ...moved },
    );
  };
  /** Why the picked operation and `at` cannot be connected in the picked direction. */
  const pickBlocked = (at: Endpoint) => {
    if (!linkFrom) return null;
    return linkFrom.as === 'caller'
      ? connectBlocked(input, linkFrom, at)
      : connectBlocked(input, at, linkFrom);
  };
  const pick = (at: Endpoint, as: Pick['as']) => {
    setNotice(null);
    if (!linkFrom) return setLinkFrom({ ...at, as });
    if (same(linkFrom, at)) return setLinkFrom(null);
    const why = pickBlocked(at);
    if (why) return say(why);
    onLinkingChange(false);
    if (linkFrom.as === 'caller') onConnect(endpoint(linkFrom), at);
    else onConnect(at, endpoint(linkFrom));
  };
  /** Why the dragged connection cannot join its origin and `at`. */
  const dragBlocked = (origin: string, type: string, at: Endpoint) => {
    const o = parseOperationNodeId(origin);
    const [from, to] = type === 'source' ? [o, at] : [at, o];
    return reconnecting.current
      ? reconnectBlocked(input, reconnecting.current, from, to)
      : connectBlocked(input, from, to);
  };
  const rectOf = (id: string): Rect | null => {
    const n = flow.getInternalNode(id);
    return n
      ? {
          ...n.internals.positionAbsolute,
          width: n.measured.width ?? 0,
          height: n.measured.height ?? 0,
        }
      : null;
  };
  /** The system group most covered by the dragged operation; none means empty canvas. */
  const dropFor = (node: Node): Drop => {
    const from = parseOperationNodeId(node.id);
    const parent = rectOf(node.parentId!);
    const at = {
      x: (parent?.x ?? 0) + node.position.x,
      y: (parent?.y ?? 0) + node.position.y,
      width: node.measured?.width ?? 0,
      height: node.measured?.height ?? 0,
    };
    let best: { systemId: string; area: number } | null = null;
    for (const n of flow.getIntersectingNodes(at)) {
      const rect = n.type === 'system' ? rectOf(n.id) : null;
      const area = rect ? overlap(at, rect) : 0;
      if (area > (best?.area ?? 0))
        best = { systemId: (n.data as SystemData).system.id, area };
    }
    const to = best?.systemId ?? null,
      home = to === from.systemId;
    return {
      from,
      to,
      home,
      blocked: home ? null : moveBlocked(input, from, to),
    };
  };
  const snapBack = (id: string) => {
    const box = boxes?.get(id);
    if (box)
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, position: { x: box.x, y: box.y } } : n,
        ),
      );
  };
  const show = (target: MenuTarget, at: { x: number; y: number }) => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setMenu((old) => ({ n: (old?.n ?? 0) + 1, at, target }));
  };
  /** Opens a menu at the pointer, or under the focused element for the keyboard. */
  const showAt = (e: React.MouseEvent | MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    const box = container.current!.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    const r = keyboard ? (e.target as Element).getBoundingClientRect() : null;
    show(
      target,
      r
        ? { x: r.left - box.left, y: r.bottom - box.top + 4 }
        : { x: e.clientX - box.left, y: e.clientY - box.top },
    );
  };
  const closeMenu = useCallback((restore: boolean) => {
    const was = restoreFocus.current;
    restoreFocus.current = null;
    setMenu(null);
    if (restore && was?.isConnected) was.focus({ preventScroll: true });
  }, []);
  /** A + connector: picks while adding a connection, otherwise lists what it can join. */
  const connector = (at: Endpoint, side: Side, el: HTMLElement) => {
    if (linking) return pick(at, side === 'out' ? 'caller' : 'downstream');
    const box = container.current!.getBoundingClientRect(),
      r = el.getBoundingClientRect();
    show(
      {
        kind: 'operation',
        ...at,
        connect: side === 'out' ? 'calls' : 'serves',
      },
      { x: r.left - box.left, y: r.bottom - box.top + 4 },
    );
  };
  const connectItems = (e: Endpoint, only?: 'calls' | 'serves'): MenuItem[] => {
    const { calls, serves } = freePartnersFor(input, e.systemId, e.operationId);
    const full = connectionLimit();
    const spawn =
      full ??
      (input.systems.length >= limits.systems
        ? 'Eight systems is the alpha limit.'
        : null);
    const name = (p: Endpoint) =>
      `${systemLabel(p.systemId)} · ${p.operationId}`;
    const items: MenuItem[] = [];
    if (only !== 'serves')
      items.push({
        group: 'Calls',
        items: [
          ...calls.map((p) => ({
            label: `→ ${name(p)}`,
            blocked: full,
            run: () => onConnect(e, p),
          })),
          {
            label: '→ A new system',
            blocked: spawn,
            run: () => onSpawn(e, 'downstream'),
          },
        ],
      });
    if (only !== 'calls')
      items.push({
        group: 'Serves',
        items: [
          ...serves.map((p) => ({
            label: `← ${name(p)}`,
            blocked: full,
            run: () => onConnect(p, e),
          })),
          {
            label: '← A new system',
            blocked: spawn,
            run: () => onSpawn(e, 'caller'),
          },
        ],
      });
    return items;
  };
  const itemsFor = (t: MenuTarget): MenuItem[] | null => {
    if (t.kind === 'pane')
      return [
        {
          label: 'Add system',
          blocked:
            input.systems.length >= limits.systems
              ? 'Eight systems is the alpha limit.'
              : null,
          run: onAddSystem,
        },
        linking
          ? {
              label: 'Stop adding a connection',
              run: () => onLinkingChange(false),
            }
          : {
              label: 'Add connection',
              blocked: connectionLimit(),
              run: () => onLinkingChange(true),
            },
        { label: 'Re-layout', run: () => setTick((n) => n + 1) },
        {
          label: fullscreen ? 'Exit fullscreen' : 'Fullscreen',
          run: onToggleFullscreen,
        },
      ];
    if (t.kind === 'connection')
      return input.connections.some((c) => c.id === t.id)
        ? [
            {
              label: 'Edit requirements',
              run: () => onInspect({ kind: 'connection', id: t.id }),
            },
            {
              label: 'Set latency target',
              run: () => setRequest(connectionEdgeId(t.id)),
            },
            {
              label: 'Remove connection',
              run: () => onDelete({ kind: 'connection', id: t.id }),
            },
          ]
        : null;
    const s = input.systems.find((x) => x.id === t.systemId);
    if (!s) return null;
    if (t.kind === 'system')
      return [
        {
          label: 'Add operation',
          blocked: addOperationBlocked(s),
          run: () => addOperationTo(s.id),
        },
        { label: 'Rename', run: () => setRequest(systemNodeId(s.id)) },
        {
          label: 'Edit in inspector',
          run: () => onInspect({ kind: 'system', systemId: s.id }),
        },
        {
          label: 'Remove system',
          run: () => onDelete({ kind: 'system', systemId: s.id }),
        },
      ];
    if (!s.operations.some((o) => o.id === t.operationId)) return null;
    if (t.connect) return connectItems(t, t.connect);
    return [
      { label: 'Connect to…', items: connectItems(t) },
      {
        label: 'Move to…',
        items: [
          ...input.systems
            .filter((x) => x.id !== s.id)
            .map((x) => ({
              label: systemLabel(x.id),
              blocked: moveBlocked(input, t, x.id),
              run: () => move(t, x.id),
            })),
          {
            label: 'A new system',
            blocked: moveBlocked(input, t, null),
            run: () => move(t, null),
          },
        ],
      },
      {
        label: 'Rename',
        run: () => setRequest(operationNodeId(s.id, t.operationId)),
      },
      {
        label: 'Edit in inspector',
        run: () =>
          onInspect({
            kind: 'operation',
            systemId: s.id,
            operationId: t.operationId,
          }),
      },
      {
        label: 'Remove operation',
        run: () =>
          onDelete({
            kind: 'operation',
            systemId: s.id,
            operationId: t.operationId,
          }),
      },
    ];
  };
  const menuItems = menu && itemsFor(menu.target);
  useEffect(() => {
    if (menu && !menuItems) closeMenu(false);
  });
  // Node and edge callbacks run after commit, when this holds the latest handlers.
  const handlers = {
    addOperationTo,
    connector,
    pick,
    linking,
    showAt,
    onFocus,
    onInspect,
    onDelete,
    attempt,
  };
  const live = useRef(handlers);
  useLayoutEffect(() => {
    live.current = handlers;
  });
  const opened = useCallback(() => setRequest(null), []);
  const built = useMemo(() => {
    if (!boxes) return [];
    const act = () => live.current;
    const links = (systemId: string, operationId: string) =>
      input.connections.filter(
        (c) =>
          (c.callerSystemId === systemId &&
            c.callerOperationId === operationId) ||
          (c.downstreamSystemId === systemId &&
            c.downstreamOperationId === operationId),
      ).length;
    const role = (id: string) => {
      const calls = input.connections.some((c) => c.callerSystemId === id),
        serves = input.connections.some((c) => c.downstreamSystemId === id);
      return calls && serves
        ? 'caller and downstream'
        : calls
          ? 'caller'
          : serves
            ? 'downstream'
            : 'unconnected';
    };
    const [origin, originType] = connectFrom?.split('\u0001') ?? [];
    const markFor = (at: Endpoint): Mark | null => {
      if (origin?.startsWith('o:'))
        return origin === operationNodeId(at.systemId, at.operationId)
          ? 'origin'
          : dragBlocked(origin, originType, at)
            ? 'invalid'
            : 'valid';
      if (!linking) return null;
      if (!linkFrom) return 'pick';
      if (same(linkFrom, at)) return 'origin';
      return pickBlocked(at) ? 'invalid' : 'valid';
    };
    return input.systems.flatMap((s) => {
      const group = boxes.get(systemNodeId(s.id));
      if (!group) return [];
      const focused = focus?.kind === 'system' && focus.systemId === s.id;
      const systemNode: SystemNode = {
        id: systemNodeId(s.id),
        type: 'system',
        position: { x: group.x, y: group.y },
        style: { width: group.width, height: group.height },
        selected: focused,
        data: {
          system: s,
          role: role(s.id),
          focused,
          drop:
            drag && !drag.home && drag.to === s.id
              ? drag.blocked
                ? 'reject'
                : 'accept'
              : null,
          onFocus: () => act().onFocus({ kind: 'system', systemId: s.id }),
          rename: {
            commit: (name) =>
              name
                ? act().attempt((d) => {
                    d.systems.find((x) => x.id === s.id)!.name = name;
                  })
                : 'A system needs a name.',
            requested: request === systemNodeId(s.id),
            onOpened: opened,
          },
          addOperation: {
            blocked: addOperationBlocked(s),
            run: () => act().addOperationTo(s.id),
          },
          remove: {
            blocked: null,
            run: () => act().onDelete({ kind: 'system', systemId: s.id }),
          },
        },
      };
      const operations: OperationNode[] = s.operations.flatMap((o) => {
        const box = boxes.get(operationNodeId(s.id, o.id));
        const at = { systemId: s.id, operationId: o.id };
        const focused =
          focus?.kind === 'operation' &&
          focus.systemId === s.id &&
          focus.operationId === o.id;
        return box
          ? [
              {
                id: operationNodeId(s.id, o.id),
                type: 'operation' as const,
                parentId: systemNode.id,
                position: { x: box.x, y: box.y },
                style: { width: box.width, height: box.height },
                selected: focused,
                data: {
                  operation: o,
                  links: links(s.id, o.id),
                  focused,
                  mark: markFor(at),
                  onClick: () =>
                    act().linking
                      ? act().pick(at, 'caller')
                      : act().onFocus({ kind: 'operation', ...at }),
                  onConnector: (side, el) => act().connector(at, side, el),
                  rename: {
                    commit: (id) => {
                      const why = act().attempt((d) =>
                        renameOperation(d, s.id, o.id, id),
                      );
                      if (!why)
                        act().onFocus({
                          kind: 'operation',
                          systemId: s.id,
                          operationId: id,
                        });
                      return why;
                    },
                    requested: request === operationNodeId(s.id, o.id),
                    onOpened: opened,
                  },
                  remove: {
                    blocked: null,
                    run: () => act().onDelete({ kind: 'operation', ...at }),
                  },
                },
              },
            ]
          : [];
      });
      return [systemNode, ...operations];
    });
  }, [
    boxes,
    input,
    focus,
    drag,
    request,
    opened,
    linking,
    linkFrom,
    connectFrom,
  ]);
  useEffect(() => {
    // Keep dragged positions and measured sizes; unmeasured nodes render hidden.
    setNodes((previous) => {
      const shown = new Map(previous.map((n) => [n.id, n]));
      return built.map((n) => {
        const old = shown.get(n.id);
        return old
          ? { ...old, data: n.data, style: n.style, selected: n.selected }
          : n;
      }) as (SystemNode | OperationNode)[];
    });
  }, [built, setNodes]);
  useEffect(() => {
    setNodes(built);
    const frame = requestAnimationFrame(
      () => void flow.fitView({ padding: 0.12, duration: 0 }),
    );
    return () => cancelAnimationFrame(frame);
    // Dragged positions reset and the view refits only when a new layout arrives.
  }, [boxes]);
  const size = useStore((s) => `${s.width}x${s.height}`);
  const wasFull = useRef(fullscreen);
  const refitUntil = useRef(0);
  useLayoutEffect(() => {
    if (wasFull.current === fullscreen) return;
    wasFull.current = fullscreen;
    // Native fullscreen can resize the canvas twice: once for the overlay, once for the screen.
    refitUntil.current = performance.now() + 1000;
  }, [fullscreen]);
  useEffect(() => {
    if (performance.now() < refitUntil.current)
      void flow.fitView({ padding: 0.12, duration: 0 });
  }, [size]);
  const edges: ConnectionEdge[] = useMemo(() => {
    const act = () => live.current;
    const placed = new Map(nodes.map((n) => [n.id, n.position]));
    const unmoved = (id: string) => {
      const box = boxes?.get(id),
        at = placed.get(id);
      return !!box && !!at && box.x === at.x && box.y === at.y;
    };
    const anchor = (c: Connection) => {
      const label = boxes?.get(edgeLabelId(c.id));
      return label &&
        unmoved(systemNodeId(c.callerSystemId)) &&
        unmoved(systemNodeId(c.downstreamSystemId))
        ? { x: label.x + label.width / 2, y: label.y + label.height / 2 }
        : null;
    };
    return input.connections.map((c) => {
      const focused = focus?.kind === 'connection' && focus.id === c.id;
      return {
        id: connectionEdgeId(c.id),
        type: 'connection',
        source: operationNodeId(c.callerSystemId, c.callerOperationId),
        sourceHandle: 'out',
        target: operationNodeId(c.downstreamSystemId, c.downstreamOperationId),
        targetHandle: 'in',
        markerEnd: { type: MarkerType.ArrowClosed },
        className: focused ? 'wf-edge focused' : 'wf-edge',
        selected: focused,
        // React Flow adds the operations' depth, so edges sit above system groups
        // and below operations, whose + connectors overlap the edge ends.
        zIndex: 0,
        data: {
          connection: c,
          outcome: outcomes?.[c.id] ?? null,
          focused,
          anchor: anchor(c),
          onFocus: () => act().onFocus({ kind: 'connection', id: c.id }),
          onMenu: (e) => {
            e.stopPropagation();
            act().onFocus({ kind: 'connection', id: c.id });
            act().showAt(e, { kind: 'connection', id: c.id });
          },
          latency: {
            commit: (value) => {
              const ms = Number(value);
              return Number.isInteger(ms) && ms > 0
                ? act().attempt((d) => {
                    d.connections.find(
                      (x) => x.id === c.id,
                    )!.experience.latencyTargetMs = ms;
                  })
                : 'Enter a whole number of milliseconds above zero.';
            },
            requested: request === connectionEdgeId(c.id),
            onOpened: opened,
          },
          inspect: {
            blocked: null,
            run: () => act().onInspect({ kind: 'connection', id: c.id }),
          },
          remove: {
            blocked: null,
            run: () => act().onDelete({ kind: 'connection', id: c.id }),
          },
        },
      };
    });
  }, [input, focus, outcomes, nodes, boxes, request, opened]);
  const ends = (link: FlowConnection | Edge) =>
    link.source?.startsWith('o:') && link.target?.startsWith('o:')
      ? {
          from: parseOperationNodeId(link.source),
          to: parseOperationNodeId(link.target),
        }
      : null;
  const isValidConnection = useCallback(
    (link: FlowConnection | Edge) => {
      const e = ends(link);
      if (!e) return false;
      return reconnecting.current
        ? reconnectBlocked(input, reconnecting.current, e.from, e.to) === null
        : connectBlocked(input, e.from, e.to) === null;
    },
    [input],
  );
  const focusNode = (id: string) => {
    if (id.startsWith('o:'))
      onFocus({ kind: 'operation', ...parseOperationNodeId(id) });
    else onFocus({ kind: 'system', systemId: id.slice(2) });
  };
  let hint: { text: string; blocked: boolean } | null = null;
  if (drag) {
    const dragged = drag.from.operationId;
    hint = {
      blocked: !!drag.blocked,
      text: drag.home
        ? `Drop ${dragged} on another system to move it, or on empty canvas to give it a new system.`
        : (drag.blocked ??
          (drag.to === null
            ? `Release to give ${dragged} a new system.`
            : `Release to move ${dragged} into ${systemLabel(drag.to)}.`)),
    };
  } else if (connectFrom) {
    const [origin, type] = connectFrom.split('\u0001');
    const over =
      origin.startsWith('o:') &&
      connectTo?.startsWith('o:') &&
      connectTo !== origin
        ? parseOperationNodeId(connectTo)
        : null;
    const why = over && dragBlocked(origin, type, over);
    hint = why
      ? { text: why, blocked: true }
      : {
          blocked: false,
          text: over
            ? 'Release to connect these operations.'
            : reconnecting.current
              ? 'Release on an operation to move the connection there.'
              : type === 'source'
                ? 'Release on the operation this one calls, or on empty canvas to add a system it calls.'
                : 'Release on the operation that calls this one, or on empty canvas to add a system that calls it.',
        };
  } else if (linking) {
    const over = hovered ? parseOperationNodeId(hovered) : null;
    const why =
      over && linkFrom && !same(over, linkFrom) ? pickBlocked(over) : null;
    hint = why
      ? { text: why, blocked: true }
      : {
          blocked: false,
          text: !linkFrom
            ? 'Click the operation that makes the call, or the + on either side of an operation. Esc cancels.'
            : linkFrom.as === 'caller'
              ? `Click the operation ${linkFrom.operationId} calls. Click ${linkFrom.operationId} again to start over; Esc cancels.`
              : `Click the operation that calls ${linkFrom.operationId}. Click ${linkFrom.operationId} again to start over; Esc cancels.`,
        };
  }
  // Drags always explain themselves; otherwise a fresh notice wins over the step hint.
  const showHint = hint && (drag || connectFrom || !notice);
  const previewTo =
    linkFrom &&
    hovered &&
    !same(parseOperationNodeId(hovered), linkFrom) &&
    !pickBlocked(parseOperationNodeId(hovered))
      ? hovered
      : null;
  const className = [
    'wf-canvas',
    linking && 'wf-linking',
    connectFrom && 'wf-connecting',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      ref={container}
      className={className}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
        ) {
          e.preventDefault();
          if (focus) onDelete(focus);
        }
      }}
    >
      {!boxes && (
        <p role="status" className="wf-loading">
          Laying out the workflow…
        </p>
      )}
      {boxes && !input.systems.length && (
        <p className="wf-empty">
          The graph is empty. Double-click anywhere to add a system.
        </p>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes: NodeChange<SystemNode | OperationNode>[]) => {
          // Selection follows focus, which only a newly selected element changes.
          onNodesChange(changes.filter((c) => c.type !== 'select'));
          const picked = changes.find((c) => c.type === 'select' && c.selected);
          if (picked?.type === 'select' && !linking) focusNode(picked.id);
        }}
        onEdgesChange={(changes: EdgeChange<ConnectionEdge>[]) => {
          const picked = changes.find((c) => c.type === 'select' && c.selected);
          if (picked?.type === 'select' && !linking)
            onFocus({ kind: 'connection', id: picked.id.slice(2) });
        }}
        onConnectStart={() => {
          closeMenu(false);
          if (linking) onLinkingChange(false);
        }}
        onConnect={(link) => {
          const e = ends(link);
          if (e) onConnect(e.from, e.to);
        }}
        onReconnectStart={(_, edge) => {
          reconnecting.current = (edge as ConnectionEdge).data!.connection.id;
        }}
        onReconnect={(edge, link) => {
          const e = ends(link);
          if (e)
            onReconnect(
              (edge as ConnectionEdge).data!.connection.id,
              e.from,
              e.to,
            );
        }}
        onReconnectEnd={() => {
          reconnecting.current = null;
        }}
        onConnectEnd={(event, state) => {
          // A drag that ends on empty canvas adds a system wired to its origin.
          // During reconnects this fires first, while the ref is still set.
          const pane = (event.target as Element | null)?.classList?.contains(
            'react-flow__pane',
          );
          const from = state.fromNode?.id;
          if (
            reconnecting.current ||
            state.isValid ||
            !pane ||
            !from?.startsWith('o:') ||
            !state.fromHandle
          )
            return;
          onSpawn(
            parseOperationNodeId(from),
            state.fromHandle.type === 'source' ? 'downstream' : 'caller',
          );
        }}
        onNodeDrag={(_, node) => {
          if (node.type !== 'operation') return;
          const next = dropFor(node);
          setDrag((old) =>
            old && old.to === next.to && old.blocked === next.blocked
              ? old
              : next,
          );
        }}
        onNodeDragStop={(_, node) => {
          setDrag(null);
          if (node.type !== 'operation') return;
          const drop = dropFor(node);
          if (drop.home || drop.blocked) snapBack(node.id);
          if (drop.blocked) say(drop.blocked);
          else if (!drop.home) move(drop.from, drop.to);
        }}
        onNodeMouseEnter={(_, node) => {
          if (linking && node.type === 'operation') setHovered(node.id);
        }}
        onNodeMouseLeave={(_, node) =>
          setHovered((h) => (h === node.id ? null : h))
        }
        onNodeContextMenu={(e, node) => {
          if (node.type === 'operation') {
            const at = parseOperationNodeId(node.id);
            onFocus({ kind: 'operation', ...at });
            showAt(e, { kind: 'operation', ...at });
          } else {
            const systemId = node.id.slice(2);
            onFocus({ kind: 'system', systemId });
            showAt(e, { kind: 'system', systemId });
          }
        }}
        onEdgeContextMenu={(e, edge) => {
          const id = edge.id.slice(2);
          onFocus({ kind: 'connection', id });
          showAt(e, { kind: 'connection', id });
        }}
        onPaneContextMenu={(e) => showAt(e, { kind: 'pane' })}
        onDoubleClick={(e) => {
          if ((e.target as Element).classList.contains('react-flow__pane'))
            onAddSystem();
        }}
        onNodeDoubleClick={(e, node) => {
          // The title and buttons have their own double-click: renaming.
          if (
            node.type !== 'system' ||
            (e.target as Element).closest('.wf-system-head')
          )
            return;
          const s = (node.data as SystemData).system;
          const why = addOperationBlocked(s);
          if (why) say(why);
          else addOperationTo(s.id);
        }}
        onPaneClick={() => {
          closeMenu(false);
          if (linking) onLinkingChange(false);
        }}
        onMoveStart={(e) => {
          if (e) closeMenu(false);
        }}
        connectionRadius={36}
        // A + is also clicked; a few pixels of travel still count as a click.
        connectionDragThreshold={4}
        connectOnClick={false}
        isValidConnection={isValidConnection}
        nodesDraggable={!linking}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        elevateNodesOnSelect={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        aria-label="Workflow graph"
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ width: 132, height: 92 }} />
      </ReactFlow>
      {linkFrom && (
        <LinkPreview
          from={operationNodeId(linkFrom.systemId, linkFrom.operationId)}
          side={linkFrom.as === 'caller' ? 'out' : 'in'}
          to={previewTo}
          container={container}
        />
      )}
      {showHint ? (
        <p
          className={hint!.blocked ? 'wf-hint blocked' : 'wf-hint'}
          role="status"
        >
          {hint!.text}
        </p>
      ) : (
        notice && (
          <p
            key={`notice-${notice.n}`}
            className={notice.tone === 'info' ? 'wf-hint' : 'wf-hint blocked'}
            role={notice.tone === 'info' ? 'status' : 'alert'}
          >
            {notice.text}
          </p>
        )
      )}
      {menu && menuItems && (
        <ContextMenu
          key={`menu-${menu.n}`}
          label={menuLabel(input, menu.target)}
          at={menu.at}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      <span className="wf-canvas-tools">
        <button className="text-button" onClick={() => setTick((t) => t + 1)}>
          ↺ Re-layout
        </button>
        <button
          className="text-button"
          aria-pressed={fullscreen}
          title={
            fullscreen
              ? 'Exit fullscreen (Escape)'
              : 'Edit the workflow on the whole screen'
          }
          onClick={onToggleFullscreen}
        >
          {fullscreen ? '✕ Exit fullscreen' : '⤢ Fullscreen'}
        </button>
      </span>
    </div>
  );
}
function menuLabel(input: DesignInput, t: MenuTarget) {
  if (t.kind === 'pane') return 'Workflow';
  if (t.kind === 'connection') return `Connection ${t.id}`;
  if (t.kind === 'system')
    return `System ${input.systems.find((s) => s.id === t.systemId)?.name}`;
  if (t.connect === 'calls') return `Connect ${t.operationId} to`;
  if (t.connect === 'serves') return `Connect a caller to ${t.operationId}`;
  return `Operation ${t.operationId}`;
}
export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
