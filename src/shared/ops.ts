import { Canvas, CanvasEdge, CanvasNode, normalizeCanvas } from './canvas';

// Field-level patches. The webview sends them to the extension, which applies them
// to the freshest file on disk, so concurrent agent edits to other cards survive.
// A null field value removes the field.
export type NodePatch = Partial<Omit<CanvasNode, 'id'>> & { id: string };
export type EdgePatch = Partial<Omit<CanvasEdge, 'id'>> & { id: string };

export type Op =
  | { op: 'upsertNodes'; nodes: NodePatch[] }
  | { op: 'deleteNodes'; ids: string[] }
  | { op: 'upsertEdges'; edges: EdgePatch[] }
  | { op: 'deleteEdges'; ids: string[] }
  | { op: 'replace'; canvas: Canvas };

function merge<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function applyOps(c: Canvas, ops: Op[]): Canvas {
  let nodes = c.nodes.slice();
  let edges = c.edges.slice();
  for (const o of ops) {
    switch (o.op) {
      case 'replace':
        nodes = o.canvas.nodes.slice();
        edges = o.canvas.edges.slice();
        break;
      case 'upsertNodes':
        for (const p of o.nodes) {
          const i = nodes.findIndex((n) => n.id === p.id);
          if (i >= 0) nodes[i] = merge(nodes[i], p);
          else if (p.type) nodes.push(merge({} as CanvasNode, p));
        }
        break;
      case 'deleteNodes': {
        const ids = new Set(o.ids);
        nodes = nodes.filter((n) => !ids.has(n.id));
        edges = edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode));
        break;
      }
      case 'upsertEdges':
        for (const p of o.edges) {
          const i = edges.findIndex((e) => e.id === p.id);
          if (i >= 0) edges[i] = merge(edges[i], p);
          else if (p.fromNode && p.toNode) edges.push(merge({} as CanvasEdge, p));
        }
        break;
      case 'deleteEdges': {
        const ids = new Set(o.ids);
        edges = edges.filter((e) => !ids.has(e.id));
        break;
      }
    }
  }
  return normalizeCanvas({ nodes, edges });
}

function patchBetween<T extends { id: string }>(a: T, b: T): (Partial<T> & { id: string }) | null {
  const p: Record<string, unknown> = { id: b.id };
  let changed = false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of Object.keys(rb)) {
    if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) {
      p[k] = rb[k];
      changed = true;
    }
  }
  for (const k of Object.keys(ra)) {
    if (!(k in rb)) {
      p[k] = null;
      changed = true;
    }
  }
  return changed ? (p as Partial<T> & { id: string }) : null;
}

/** Minimal ops that turn `a` into `b`. */
export function diffOps(a: Canvas, b: Canvas): Op[] {
  const ops: Op[] = [];
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Set(b.nodes.map((n) => n.id));
  const nodePatches: NodePatch[] = [];
  for (const n of b.nodes) {
    const old = an.get(n.id);
    if (!old) nodePatches.push(n);
    else {
      const p = patchBetween(old, n);
      if (p) nodePatches.push(p);
    }
  }
  const removedNodes = a.nodes.filter((n) => !bn.has(n.id)).map((n) => n.id);
  if (removedNodes.length) ops.push({ op: 'deleteNodes', ids: removedNodes });
  if (nodePatches.length) ops.push({ op: 'upsertNodes', nodes: nodePatches });

  const ae = new Map(a.edges.map((e) => [e.id, e]));
  const be = new Set(b.edges.map((e) => e.id));
  const edgePatches: EdgePatch[] = [];
  for (const e of b.edges) {
    const old = ae.get(e.id);
    if (!old) edgePatches.push(e);
    else {
      const p = patchBetween(old, e);
      if (p) edgePatches.push(p);
    }
  }
  const removedEdges = a.edges.filter((e) => !be.has(e.id)).map((e) => e.id);
  if (removedEdges.length) ops.push({ op: 'deleteEdges', ids: removedEdges });
  if (edgePatches.length) ops.push({ op: 'upsertEdges', edges: edgePatches });
  return ops;
}
