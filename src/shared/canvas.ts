// Board model: JSON Canvas 1.0 (https://jsoncanvas.org) + a few optional extension fields
// (pinned, autoHeight). Files stay readable by Obsidian and other JSON Canvas tools.

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type NodeType = 'text' | 'file' | 'link' | 'group';
export type End = 'none' | 'arrow';

export interface CanvasNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  pinned?: boolean;
  autoHeight?: boolean;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: End;
  toEnd?: End;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export const BOARD_DIR = '.desk';
export const BOARD_FILE = 'board.canvas';

export const emptyCanvas = (): Canvas => ({ nodes: [], edges: [] });

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export class BoardParseError extends Error {}

export function parseCanvas(text: string): Canvas {
  if (!text || !text.trim()) return emptyCanvas();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BoardParseError(`invalid JSON (${(e as Error).message})`);
  }
  return normalizeCanvas(raw);
}

export function normalizeCanvas(raw: any): Canvas {
  const out = emptyCanvas();
  const ids = new Set<string>();
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || ids.has(n.id)) continue;
    ids.add(n.id);
    out.nodes.push({
      ...n,
      type: NODE_TYPES.has(n.type) ? n.type : 'text',
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: Math.max(20, num(n.width, 280)),
      height: Math.max(20, num(n.height, 60)),
    });
  }
  const edgeIds = new Set<string>();
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || edgeIds.has(e.id)) continue;
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    edgeIds.add(e.id);
    const edge: CanvasEdge = { ...e };
    if (edge.fromSide && !SIDES.has(edge.fromSide)) delete edge.fromSide;
    if (edge.toSide && !SIDES.has(edge.toSide)) delete edge.toSide;
    if (edge.fromEnd && !ENDS.has(edge.fromEnd)) delete edge.fromEnd;
    if (edge.toEnd && !ENDS.has(edge.toEnd)) delete edge.toEnd;
    out.edges.push(edge);
  }
  return out;
}

const NODE_KEYS = ['id', 'type', 'text', 'file', 'subpath', 'url', 'label', 'x', 'y', 'width', 'height', 'color', 'pinned', 'autoHeight'];
const EDGE_KEYS = ['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'];

function ordered(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in r) && o[k] !== undefined && o[k] !== null) r[k] = o[k];
  return r;
}

// Same layout Obsidian writes: one node / edge per line, so git diffs stay readable.
export function serializeCanvas(c: Canvas): string {
  const block = (items: Record<string, unknown>[], keys: string[]) =>
    items.length ? '[\n' + items.map((i) => '\t\t' + JSON.stringify(ordered(i, keys))).join(',\n') + '\n\t]' : '[]';
  return `{\n\t"nodes":${block(c.nodes, NODE_KEYS)},\n\t"edges":${block(c.edges, EDGE_KEYS)}\n}\n`;
}

// JSON Canvas preset colors "1".."6"; names are accepted from agents and mapped.
const PRESETS: Record<string, string> = { '1': 'red', '2': 'orange', '3': 'yellow', '4': 'green', '5': 'cyan', '6': 'purple' };
const NAMED: Record<string, string> = {
  red: '1',
  orange: '2',
  yellow: '3',
  green: '4',
  cyan: '5',
  teal: '5',
  purple: '6',
  violet: '6',
  blue: '#3e7bfa',
  gray: '#8b8d98',
  grey: '#8b8d98',
};
const NAMED_HEX: Record<string, string> = { '#3e7bfa': 'blue', '#8b8d98': 'gray' };

/** undefined = leave as is, null = clear, string = canvas color */
export function normalizeColor(c: unknown): string | null | undefined {
  if (c === undefined) return undefined;
  if (c === null || c === '' || c === 'none' || c === 'default') return null;
  if (typeof c !== 'string') return undefined;
  const s = c.trim().toLowerCase();
  if (/^[1-6]$/.test(s)) return s;
  if (NAMED[s]) return NAMED[s];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
  return undefined;
}

export function colorName(c?: string): string | undefined {
  if (!c) return undefined;
  return PRESETS[c] ?? NAMED_HEX[c.toLowerCase()] ?? c;
}

export function newId(taken: Set<string>): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (id.length === 6 && !taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

export function cloneCanvas(c: Canvas): Canvas {
  return JSON.parse(JSON.stringify(c));
}

export function sameCanvas(a: Canvas, b: Canvas): boolean {
  return serializeCanvas(a) === serializeCanvas(b);
}
