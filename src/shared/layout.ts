import { Canvas, CanvasNode } from './canvas';

// Geometry constants shared by the MCP server (auto-layout) and the webview (CSS mirrors them).
export const CARD_W = 280;
export const GAP = 12;
export const PAD = 16;
export const HEADER = 44;
export const BLOCK_GAP = 64;
export const GROUP_W = CARD_W + PAD * 2;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const rightOf = (r: Rect) => r.x + r.width;
export const bottomOf = (r: Rect) => r.y + r.height;
const overlapX = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width;

export function bbox(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rs) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function centerIn(inner: Rect, outer: Rect): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx > outer.x && cx < outer.x + outer.width && cy > outer.y && cy < outer.y + outer.height;
}

export type ParentMap = Map<string, string | undefined>;

/** JSON Canvas groups are geometric: a node belongs to the smallest group that contains its center. */
export function parentMap(c: Canvas): ParentMap {
  const groups = c.nodes
    .filter((n) => n.type === 'group' && !n.pinned)
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const m: ParentMap = new Map();
  for (const n of c.nodes) {
    if (n.pinned) {
      m.set(n.id, undefined);
      continue;
    }
    const area = n.width * n.height;
    const g = groups.find((g) => g.id !== n.id && g.width * g.height > area && centerIn(n, g));
    m.set(n.id, g?.id);
  }
  return m;
}

export function descendants(c: Canvas, pm: ParentMap, id: string): string[] {
  const out: string[] = [];
  const walk = (gid: string) => {
    for (const n of c.nodes) {
      if (pm.get(n.id) === gid) {
        out.push(n.id);
        if (n.type === 'group') walk(n.id);
      }
    }
  };
  walk(id);
  return out;
}

function plain(s: string): string {
  return s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '');
}

/** Rough height of a markdown card as the webview renders it; the webview later fits it exactly. */
export function estimateTextHeight(text: string, width: number): number {
  const inner = Math.max(60, width - 26);
  const CW = 7.5;
  const LH = 20.3;
  const wrap = (chars: number, w: number, cw = CW) => Math.max(1, Math.ceil((chars * cw) / Math.max(40, w)));
  let h = 22;
  let inCode = false;
  let prevBlank = true;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      if (inCode) h += 22;
      prevBlank = false;
      continue;
    }
    if (inCode) {
      h += 18;
      continue;
    }
    if (!line.trim()) {
      if (!prevBlank) h += 6;
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      const fs = [17, 15.5, 14, 14, 14, 14][hd[1].length - 1];
      h += wrap(plain(hd[2]).length, inner, fs * 0.56) * fs * 1.3 + 6;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      h += 17;
      continue;
    }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
      const indent = 18 * (depth + 1) + (li[2] ? 20 : 0);
      h += wrap(plain(li[3]).length, inner - indent) * LH + 2;
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      h += wrap(plain(q[1]).length, inner - 12) * LH;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!/^\s*\|?\s*:?-{2,}/.test(line)) h += 27;
      continue;
    }
    h += wrap(plain(line).length, inner) * LH;
  }
  return Math.max(44, Math.round(h));
}

export type StackMode = 'column' | 'row' | 'grid';

/** Lays items out from (0,0). */
export function stack(items: Rect[], mode: StackMode, gap = GAP, cols?: number): void {
  if (mode === 'column') {
    let y = 0;
    for (const it of items) {
      it.x = 0;
      it.y = y;
      y += it.height + gap;
    }
    return;
  }
  if (mode === 'row') {
    let x = 0;
    for (const it of items) {
      it.x = x;
      it.y = 0;
      x += it.width + gap;
    }
    return;
  }
  const k = Math.max(1, cols ?? Math.ceil(Math.sqrt(items.length)));
  const colW: number[] = [];
  const rowH: number[] = [];
  items.forEach((it, i) => {
    const c = i % k;
    const r = Math.floor(i / k);
    colW[c] = Math.max(colW[c] ?? 0, it.width);
    rowH[r] = Math.max(rowH[r] ?? 0, it.height);
  });
  items.forEach((it, i) => {
    const c = i % k;
    const r = Math.floor(i / k);
    it.x = colW.slice(0, c).reduce((s, w) => s + w + gap, 0);
    it.y = rowH.slice(0, r).reduce((s, h) => s + h + gap, 0);
  });
}

/** Layered (Sugiyama-style) layout for small diagrams. Lays items out from (0,0). */
export function layered(
  items: (Rect & { id: string })[],
  edges: { from: string; to: string; label?: string }[],
  dir: 'down' | 'right',
): void {
  const n = items.length;
  if (!n) return;
  const idx = new Map(items.map((it, i) => [it.id, i]));
  const adj: number[][] = items.map(() => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) adj[a].push(b);
  }
  // Drop back edges so the graph is acyclic.
  const state = new Array(n).fill(0);
  const out: number[][] = items.map(() => []);
  const inn: number[][] = items.map(() => []);
  const visit = (u: number) => {
    state[u] = 1;
    for (const v of adj[u]) {
      if (state[v] === 1) continue;
      out[u].push(v);
      inn[v].push(u);
      if (state[v] === 0) visit(v);
    }
    state[u] = 2;
  };
  for (let i = 0; i < n; i++) if (state[i] === 0) visit(i);

  // Longest-path layering.
  const layer = new Array(n).fill(0);
  const indeg = inn.map((l) => l.length);
  const queue = items.map((_, i) => i).filter((i) => indeg[i] === 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of out[u]) {
      layer[v] = Math.max(layer[v], layer[u] + 1);
      if (--indeg[v] === 0) queue.push(v);
    }
  }
  const L = Math.max(...layer) + 1;
  const layers: number[][] = Array.from({ length: L }, () => []);
  for (let i = 0; i < n; i++) layers[layer[i]].push(i);

  // Barycenter ordering, a few sweeps down and up.
  const pos = new Array(n).fill(0);
  layers.forEach((l) => l.forEach((v, i) => (pos[v] = i)));
  for (let it = 0; it < 6; it++) {
    const down = it % 2 === 0;
    const order = [...Array(L).keys()];
    const ks = down ? order.slice(1) : order.reverse().slice(1);
    for (const k of ks) {
      const nb = down ? inn : out;
      const bc = new Map<number, number>();
      for (const v of layers[k]) {
        const ns = nb[v];
        bc.set(v, ns.length ? ns.reduce((s, u) => s + pos[u], 0) / ns.length : pos[v]);
      }
      layers[k].sort((a, b) => bc.get(a)! - bc.get(b)!);
      layers[k].forEach((v, i) => (pos[v] = i));
    }
  }

  // In a left-to-right flow the label sits between two layers, so the gap must fit it.
  const gapAfter = new Array(L).fill(dir === 'down' ? 64 : 88);
  if (dir === 'right') {
    for (const e of edges) {
      const a = idx.get(e.from);
      if (a === undefined || !e.label) continue;
      gapAfter[layer[a]] = Math.max(gapAfter[layer[a]], Math.round(e.label.length * 7 + 40));
    }
  }
  const gapCross = 32;
  const main = (r: Rect) => (dir === 'down' ? r.height : r.width);
  const cross = (r: Rect) => (dir === 'down' ? r.width : r.height);
  const layerMain = layers.map((l) => Math.max(...l.map((v) => main(items[v]))));
  const layerCross = layers.map((l) => l.reduce((s, v) => s + cross(items[v]), 0) + gapCross * (l.length - 1));
  const maxCross = Math.max(...layerCross);
  let offset = 0;
  layers.forEach((l, k) => {
    let c = (maxCross - layerCross[k]) / 2;
    for (const v of l) {
      const it = items[v];
      const m = offset + (layerMain[k] - main(it)) / 2;
      if (dir === 'down') {
        it.x = Math.round(c);
        it.y = Math.round(m);
      } else {
        it.x = Math.round(m);
        it.y = Math.round(c);
      }
      c += cross(it) + gapCross;
    }
    offset += layerMain[k] + gapAfter[k];
  });
}

export function translate(items: Rect[], dx: number, dy: number): void {
  for (const it of items) {
    it.x = Math.round(it.x + dx);
    it.y = Math.round(it.y + dy);
  }
}

export interface Placement {
  x?: number;
  y?: number;
  below?: string;
  right_of?: string;
  above?: string;
  left_of?: string;
}

/** Top-left corner for a new block of the given size that does not overlap existing content. */
export function placeBlock(c: Canvas, size: { width: number; height: number }, p?: Placement): { x: number; y: number } {
  if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: Math.round(p.x), y: Math.round(p.y) };
  const obstacles = c.nodes.filter((n) => !n.pinned);
  const content = bbox(obstacles);
  const ref = (id?: string) => (id ? obstacles.find((n) => n.id === id) : undefined);
  const g = BLOCK_GAP / 2;
  let x: number;
  let y: number;
  let dir: 'down' | 'right' | 'up' | 'left';
  let r: CanvasNode | undefined;
  if ((r = ref(p?.below))) {
    x = r.x;
    y = bottomOf(r) + g;
    dir = 'down';
  } else if ((r = ref(p?.right_of))) {
    x = rightOf(r) + g;
    y = r.y;
    dir = 'right';
  } else if ((r = ref(p?.above))) {
    x = r.x;
    y = r.y - g - size.height;
    dir = 'up';
  } else if ((r = ref(p?.left_of))) {
    x = r.x - g - size.width;
    y = r.y;
    dir = 'left';
  } else if (!content) {
    return { x: 0, y: 0 };
  } else if (content.width > 2400) {
    x = content.x;
    y = bottomOf(content) + BLOCK_GAP;
    dir = 'right';
  } else {
    x = rightOf(content) + BLOCK_GAP;
    y = content.y;
    dir = 'right';
  }
  for (let i = 0; i < 500; i++) {
    const box = { x, y, width: size.width, height: size.height };
    const hit = obstacles.find((o) => intersects(box, o, g - 1));
    if (!hit) break;
    if (dir === 'down') y = bottomOf(hit) + g;
    else if (dir === 'right') x = rightOf(hit) + g;
    else if (dir === 'up') y = hit.y - g - size.height;
    else x = hit.x - g - size.width;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

const byId = (c: Canvas, id: string) => c.nodes.find((n) => n.id === id);

function moveWithContents(c: Canvas, pm: ParentMap, nodes: CanvasNode[], dy: number): void {
  const ids = new Set<string>();
  for (const s of nodes) {
    ids.add(s.id);
    if (s.type === 'group') for (const d of descendants(c, pm, s.id)) ids.add(d);
  }
  for (const m of c.nodes) if (ids.has(m.id)) m.y += dy;
}

/** Grow a group to contain its children (and shrink auto-sized groups). */
function fitParent(c: Canvas, pm: ParentMap, groupId: string, exclude?: string): void {
  const g = byId(c, groupId);
  if (!g) return;
  const kids = c.nodes.filter((k) => k.id !== exclude && pm.get(k.id) === groupId);
  const contentRight = kids.length ? Math.max(...kids.map(rightOf)) : g.x;
  if (contentRight + PAD > rightOf(g)) g.width = contentRight + PAD - g.x;
  const contentBottom = kids.length ? Math.max(...kids.map(bottomOf)) : g.y + HEADER;
  const want = Math.max(HEADER + PAD, contentBottom + PAD - g.y);
  if (want > g.height || (g.autoHeight && want < g.height)) applyHeightChange(c, g.id, want, pm);
}

export function fitGroup(c: Canvas, groupId: string): void {
  fitParent(c, parentMap(c), groupId);
}

/**
 * A top-level node grew: push down what is below it. The push zone widens with every
 * node it moves, and nodes joined by arrows move together, so diagrams stay intact.
 */
function pushBelow(c: Canvas, pm: ParentMap, n: CanvasNode, oldBottom: number, delta: number): void {
  const below = c.nodes.filter((s) => s.id !== n.id && !s.pinned && pm.get(s.id) === undefined && s.y >= oldBottom - 1);
  if (!below.length) return;
  const topOf = (id: string) => {
    let cur = id;
    for (let p = pm.get(cur); p; p = pm.get(cur)) cur = p;
    return cur;
  };
  const links = new Map<string, string[]>();
  for (const e of c.edges) {
    const a = topOf(e.fromNode);
    const b = topOf(e.toNode);
    if (a === b) continue;
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const zone: [number, number][] = [[n.x, n.x + n.width]];
  const moved = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of below) {
      if (moved.has(s.id)) continue;
      const inZone = zone.some(([x1, x2]) => s.x < x2 && x1 < s.x + s.width);
      const linked = (links.get(s.id) ?? []).some((id) => moved.has(id));
      if (!inZone && !linked) continue;
      moved.add(s.id);
      zone.push([s.x, s.x + s.width]);
      changed = true;
    }
  }
  moveWithContents(c, pm, below.filter((s) => moved.has(s.id)), delta);
}

/**
 * Change a node's height and reflow. Inside a group the stack stays tight: cards below
 * move by the same delta and the group grows or shrinks. At the top level, growth pushes
 * the content below down; shrinking leaves it in place.
 */
export function applyHeightChange(c: Canvas, id: string, newHeight: number, pm: ParentMap = parentMap(c)): void {
  const n = byId(c, id);
  if (!n) return;
  const h = Math.max(20, Math.round(newHeight));
  const delta = h - n.height;
  if (!delta) return;
  const parent = pm.get(id);
  const oldBottom = bottomOf(n);
  n.height = h;
  if (parent) {
    const below = c.nodes.filter(
      (s) => s.id !== id && !s.pinned && pm.get(s.id) === parent && s.y >= oldBottom - 1 && overlapX(s, n),
    );
    moveWithContents(c, pm, below, delta);
    fitParent(c, pm, parent);
  } else if (delta > 0) {
    pushBelow(c, pm, n, oldBottom, delta);
  }
}

/** Pull up the cards below `id` in its group, as if it was taken out of the stack. */
export function closeGap(c: Canvas, id: string): void {
  const pm = parentMap(c);
  const n = byId(c, id);
  const parent = pm.get(id);
  if (!n || !parent) return;
  const below = c.nodes.filter(
    (s) => s.id !== id && pm.get(s.id) === parent && s.y >= bottomOf(n) - 1 && overlapX(s, n),
  );
  if (below.length) {
    const shift = Math.min(...below.map((s) => s.y)) - n.y;
    if (shift > 0) moveWithContents(c, pm, below, -shift);
  }
  fitParent(c, pm, parent, id);
}

/** True when the group's cards form one column (agent-made stacks), so cards can be slotted in. */
export function isColumnGroup(c: Canvas, groupId: string, exclude: Set<string> = new Set()): boolean {
  const pm = parentMap(c);
  const xs = c.nodes.filter((n) => pm.get(n.id) === groupId && !exclude.has(n.id)).map((n) => n.x);
  return !xs.length || Math.max(...xs) - Math.min(...xs) <= 8;
}

/**
 * Slot cards into a group's column at world y `atY` (kanban-style): the cards below move
 * down, the group grows. Cards must not be in `c.nodes` yet.
 */
export function insertIntoColumn(c: Canvas, groupId: string, cards: CanvasNode[], atY: number): void {
  const g = byId(c, groupId);
  if (!g) return;
  const pm = parentMap(c);
  const kids = c.nodes.filter((n) => pm.get(n.id) === groupId).sort((a, b) => a.y - b.y);
  const after = kids.filter((k) => k.y + k.height / 2 > atY);
  const above = kids.filter((k) => !after.includes(k));
  let y = after.length ? after[0].y : above.length ? Math.max(...above.map(bottomOf)) + GAP : g.y + HEADER;
  const x = kids.length ? kids[0].x : g.x + PAD;
  const w = kids.length ? kids[0].width : Math.max(120, g.width - 2 * PAD);
  for (const n of cards) {
    if (n.width === w) continue;
    if (n.type === 'text' && n.autoHeight) n.height = estimateTextHeight(n.text ?? '', w);
    n.width = w;
  }
  moveWithContents(c, pm, after, cards.reduce((s, n) => s + n.height + GAP, 0));
  for (const n of cards) {
    n.x = x;
    n.y = y;
    y += n.height + GAP;
  }
  const want = Math.max(HEADER + PAD, Math.max(...kids.map(bottomOf), ...cards.map(bottomOf)) + PAD - g.y);
  if (want > g.height || (g.autoHeight && want < g.height)) applyHeightChange(c, g.id, want, pm);
  c.nodes.push(...cards);
}

/** Put `node` at the end of a group's stack, growing the group (and reflowing around it) if needed. */
export function appendToGroup(c: Canvas, groupId: string, node: CanvasNode, keepWidth = false): void {
  const g = byId(c, groupId);
  if (!g || g.type !== 'group') throw new Error(`group "${groupId}" not found`);
  const at = c.nodes.indexOf(node);
  if (at >= 0) c.nodes.splice(at, 1);
  const pm = parentMap(c);
  const kids = c.nodes.filter((n) => pm.get(n.id) === groupId);
  let x = g.x + PAD;
  let y = g.y + HEADER;
  if (kids.length) {
    x = Math.min(...kids.map((k) => k.x));
    y = Math.max(...kids.map(bottomOf)) + GAP;
  }
  if (!keepWidth) {
    const w = Math.max(120, g.width - 2 * PAD);
    if (node.type === 'text' && node.autoHeight && w !== node.width) node.height = estimateTextHeight(node.text ?? '', w);
    node.width = w;
  }
  const needRight = x + node.width + PAD;
  if (needRight > rightOf(g)) g.width = needRight - g.x;
  const needBottom = y + node.height + PAD;
  if (needBottom > bottomOf(g)) applyHeightChange(c, g.id, needBottom - g.y, pm);
  node.x = Math.round(x);
  node.y = Math.round(y);
  c.nodes.push(node);
}
