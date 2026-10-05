import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { DesignInput } from '../../../../packages/plug/src/contracts/index';
export const operationSize = { width: 210, height: 64 };
/** Room reserved between layers for the priority badge; matches .wf-edge-label. */
export const edgeLabelSize = { width: 200, height: 60 };
export const systemNodeId = (systemId: string) => `s:${systemId}`;
export const operationNodeId = (systemId: string, operationId: string) =>
  `o:${systemId}\u0000${operationId}`;
export const connectionEdgeId = (connectionId: string) => `c:${connectionId}`;
export const edgeLabelId = (connectionId: string) => `l:${connectionId}`;
export const parseOperationNodeId = (id: string) => {
  const [systemId, operationId] = id.slice(2).split('\u0000');
  return { systemId, operationId };
};
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const elk = new ELK();
/** Structure that changes the layout; names and facts do not. */
export const structureKey = (d: DesignInput) =>
  JSON.stringify([
    d.systems.map((s) => [s.id, s.operations.map((o) => o.id)]),
    d.connections.map((c) => [
      c.callerSystemId,
      c.callerOperationId,
      c.downstreamSystemId,
      c.downstreamOperationId,
    ]),
  ]);
const group = { top: 56, side: 16, gap: 16 };
/** A system without operations keeps one slot for its placeholder. */
const groupSize = (operations: number) => {
  const slots = Math.max(1, operations);
  return {
    width: operationSize.width + 2 * group.side,
    height:
      group.top +
      slots * operationSize.height +
      (slots - 1) * group.gap +
      group.side,
  };
};
/**
 * Deterministic layered layout of system groups, with label room on every edge;
 * operations stack inside their group, and their boxes are relative to it.
 */
export async function layoutWorkflow(
  d: DesignInput,
): Promise<Map<string, Box>> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.spacing.nodeNode': '48',
      'elk.spacing.edgeLabel': '8',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.randomSeed': '1',
    },
    children: d.systems.map((s) => ({
      id: systemNodeId(s.id),
      ...groupSize(s.operations.length),
    })),
    edges: d.connections.map((c) => ({
      id: connectionEdgeId(c.id),
      sources: [systemNodeId(c.callerSystemId)],
      targets: [systemNodeId(c.downstreamSystemId)],
      labels: [{ id: edgeLabelId(c.id), text: c.id, ...edgeLabelSize }],
    })),
  };
  const laid = await elk.layout(graph);
  const boxes = new Map<string, Box>();
  const put = (
    id: string,
    n: { x?: number; y?: number; width?: number; height?: number },
  ) =>
    boxes.set(id, {
      x: n.x ?? 0,
      y: n.y ?? 0,
      width: n.width ?? 0,
      height: n.height ?? 0,
    });
  for (const n of laid.children ?? []) put(n.id, n);
  for (const e of laid.edges ?? [])
    for (const l of e.labels ?? []) put(l.id!, l);
  for (const s of d.systems)
    s.operations.forEach((o, i) =>
      boxes.set(operationNodeId(s.id, o.id), {
        x: group.side,
        y: group.top + i * (operationSize.height + group.gap),
        ...operationSize,
      }),
    );
  return boxes;
}
