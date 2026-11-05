import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  BOARD_DIR,
  BOARD_FILE,
  Canvas,
  CanvasEdge,
  CanvasNode,
  colorName,
  newId,
  normalizeColor,
  parseCanvas,
  serializeCanvas,
} from '../shared/canvas';
import {
  BLOCK_GAP,
  CARD_W,
  GAP,
  GROUP_W,
  HEADER,
  PAD,
  Placement,
  StackMode,
  appendToGroup,
  applyHeightChange,
  bbox,
  closeGap,
  descendants,
  estimateTextHeight,
  layered,
  parentMap,
  placeBlock,
  stack,
  translate,
} from '../shared/layout';

const VERSION = '0.1.0';

// ---------- board file ----------

function findBoard(): string {
  if (process.env.DESK_BOARD) return path.resolve(process.env.DESK_BOARD);
  const start = path.resolve(process.env.DESK_ROOT || process.cwd());
  const home = os.homedir();
  const up = (test: (dir: string) => boolean): string | undefined => {
    let dir = start;
    for (;;) {
      if (test(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir || parent === home || dir === home) return undefined;
      dir = parent;
    }
  };
  const root =
    up((d) => fs.existsSync(path.join(d, BOARD_DIR, BOARD_FILE))) ??
    up((d) => fs.existsSync(path.join(d, '.git'))) ??
    start;
  return path.join(root, BOARD_DIR, BOARD_FILE);
}

function load(file: string): Canvas {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  try {
    return parseCanvas(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}. The board was not changed; fix the file first.`);
  }
}

function save(file: string, c: Canvas): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, serializeCanvas(c));
  fs.renameSync(tmp, file);
}

// ---------- input helpers ----------

interface ItemIn {
  id?: string;
  type?: string;
  text?: string;
  label?: string;
  file?: string;
  url?: string;
  color?: string | null;
  pinned?: boolean;
  parent?: string | null;
  children?: ItemIn[];
  layout?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ArrowIn {
  id?: string;
  from?: string;
  to?: string;
  label?: string | null;
  color?: string | null;
  ends?: string;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function inferType(it: ItemIn): CanvasNode['type'] {
  if (it.type === 'text' || it.type === 'group' || it.type === 'file' || it.type === 'link') return it.type;
  if (it.children || (it.label !== undefined && it.text === undefined)) return 'group';
  if (it.file) return 'file';
  if (it.url && it.text === undefined) return 'link';
  return 'text';
}

function makeNode(it: ItemIn, taken: Set<string>): CanvasNode {
  const type = inferType(it);
  let id = str(it.id)?.trim();
  if (id && !taken.has(id)) taken.add(id);
  else id = newId(taken);
  const n: CanvasNode = { id, type, x: 0, y: 0, width: 0, height: 0 };
  const color = normalizeColor(it.color);
  if (color) n.color = color;
  if (it.pinned) n.pinned = true;
  const w = num(it.width);
  const h = num(it.height);
  if (type === 'text') {
    n.text = str(it.text) ?? '';
    n.width = w ?? CARD_W;
    if (h) n.height = h;
    else {
      n.height = estimateTextHeight(n.text, n.width);
      n.autoHeight = true;
    }
  } else if (type === 'file') {
    n.file = str(it.file) ?? '';
    n.width = w ?? CARD_W;
    n.height = h ?? 64;
  } else if (type === 'link') {
    n.url = str(it.url) ?? '';
    n.width = w ?? CARD_W;
    n.height = h ?? 64;
  } else {
    n.label = str(it.label) ?? '';
    n.width = w ?? GROUP_W;
    if (h) n.height = h;
    else {
      n.height = HEADER + PAD + 40;
      n.autoHeight = true;
    }
  }
  return n;
}

const STACK_MODES = new Set(['column', 'row', 'grid']);

/** A group and its children, laid out relative to the group at (0,0). */
function buildGroup(it: ItemIn, taken: Set<string>): CanvasNode[] {
  const g = makeNode({ ...it, type: 'group' }, taken);
  const kids = arr<ItemIn>(it.children).map((ch) => makeNode({ ...ch, children: undefined, parent: undefined }, taken));
  if (!kids.length) return [g];
  const mode = (STACK_MODES.has(it.layout ?? '') ? it.layout : 'column') as StackMode;
  if (mode === 'column') {
    const w = num(it.width) ? Math.max(120, num(it.width)! - 2 * PAD) : Math.max(CARD_W, ...kids.map((k) => k.width));
    for (const k of kids) {
      if (k.width === w) continue;
      k.width = w;
      if (k.type === 'text' && k.autoHeight) k.height = estimateTextHeight(k.text ?? '', w);
    }
  }
  stack(kids, mode, GAP);
  const bb = bbox(kids)!;
  translate(kids, PAD, HEADER);
  g.width = Math.max(num(it.width) ?? 0, bb.width + 2 * PAD);
  g.height = Math.max(num(it.height) ?? 0, HEADER + bb.height + PAD);
  return [g, ...kids];
}

function moveNode(c: Canvas, n: CanvasNode, x: number, y: number): void {
  const dx = x - n.x;
  const dy = y - n.y;
  if (!dx && !dy) return;
  const ids = new Set([n.id, ...(n.type === 'group' ? descendants(c, parentMap(c), n.id) : [])]);
  for (const m of c.nodes) {
    if (!ids.has(m.id)) continue;
    m.x += dx;
    m.y += dy;
  }
}

function updateNode(c: Canvas, u: ItemIn, warnings: string[]): boolean {
  const n = c.nodes.find((x) => x.id === u.id);
  if (!n) {
    warnings.push(`no card "${u.id}"`);
    return false;
  }
  let reflow = false;
  if (u.text !== undefined) {
    n.text = String(u.text);
    reflow = true;
  }
  if (u.label !== undefined) n.label = String(u.label);
  if (u.file !== undefined) n.file = String(u.file);
  if (u.url !== undefined) n.url = String(u.url);
  const color = normalizeColor(u.color);
  if (color === null) delete n.color;
  else if (color) n.color = color;
  if (u.pinned !== undefined) {
    if (u.pinned) n.pinned = true;
    else delete n.pinned;
  }
  const w = num(u.width);
  if (w !== undefined) {
    n.width = Math.max(40, w);
    reflow = true;
  }
  const h = num(u.height);
  if (h !== undefined) {
    applyHeightChange(c, n.id, h);
    delete n.autoHeight;
  } else if (reflow && n.type === 'text' && n.autoHeight) {
    applyHeightChange(c, n.id, estimateTextHeight(n.text ?? '', n.width));
  }
  const x = num(u.x);
  const y = num(u.y);
  if (x !== undefined || y !== undefined) moveNode(c, n, x ?? n.x, y ?? n.y);
  if (u.parent !== undefined) {
    closeGap(c, n.id);
    if (u.parent) {
      appendToGroup(c, u.parent, n, w !== undefined);
    } else {
      c.nodes.splice(c.nodes.indexOf(n), 1);
      const at = placeBlock(c, n);
      n.x = at.x;
      n.y = at.y;
      c.nodes.push(n);
    }
  }
  return true;
}

function endsOf(a: ArrowIn): Partial<CanvasEdge> {
  if (a.ends === 'both') return { fromEnd: 'arrow', toEnd: 'arrow' };
  if (a.ends === 'none') return { fromEnd: 'none', toEnd: 'none' };
  return {};
}

// ---------- tools ----------

function readBoard(): string {
  const file = findBoard();
  const c = load(file);
  const pm = parentMap(c);
  const byPos = (a: CanvasNode, b: CanvasNode) => a.y - b.y || a.x - b.x;
  const view = (n: CanvasNode): Record<string, unknown> => {
    const o: Record<string, unknown> = { id: n.id };
    if (n.type !== 'text') o.type = n.type;
    if (n.type === 'text') o.text = n.text ?? '';
    if (n.type === 'group') o.label = n.label ?? '';
    if (n.type === 'file') o.file = n.file;
    if (n.type === 'link') o.url = n.url;
    const cn = colorName(n.color);
    if (cn) o.color = cn;
    if (!n.pinned) o.box = [n.x, n.y, n.width, n.height];
    if (n.type === 'group') {
      const kids = c.nodes.filter((k) => pm.get(k.id) === n.id).sort(byPos);
      if (kids.length) o.children = kids.map(view);
    }
    return o;
  };
  const lines = (items: Record<string, unknown>[], depth: number): string =>
    items
      .map((it) => {
        const { children, ...rest } = it;
        const pad = '  '.repeat(depth);
        let s = JSON.stringify(rest);
        if (Array.isArray(children)) s = s.slice(0, -1) + ',"children":[\n' + lines(children, depth + 1) + '\n' + pad + ']}';
        return pad + s;
      })
      .join(',\n');
  const pinned = c.nodes.filter((n) => n.pinned).map(view);
  const top = c.nodes.filter((n) => !n.pinned && !pm.get(n.id)).sort(byPos).map(view);
  const arrows = c.edges.map((e) => {
    const o: Record<string, unknown> = { id: e.id, from: e.fromNode, to: e.toNode };
    if (e.label) o.label = e.label;
    const cn = colorName(e.color);
    if (cn) o.color = cn;
    if (e.fromEnd === 'arrow') o.ends = 'both';
    else if (e.toEnd === 'none') o.ends = 'none';
    return o;
  });
  const cards = c.nodes.filter((n) => n.type !== 'group').length;
  const groups = c.nodes.length - cards;
  const head = c.nodes.length
    ? `Board ${file}: ${cards} cards, ${groups} groups, ${c.edges.length} arrows. box = [x, y, width, height].`
    : `Board ${file} is empty.`;
  const block = (name: string, items: Record<string, unknown>[]) =>
    `"${name}":[` + (items.length ? '\n' + lines(items, 1) + '\n' : '') + ']';
  return `${head}\n{${block('pinned', pinned)},\n${block('items', top)},\n${block('arrows', arrows)}}`;
}

function addToBoard(args: Record<string, unknown>): string {
  const items = arr<ItemIn>(args.items);
  if (!items.length) throw new Error('"items" must be a non-empty array');
  const file = findBoard();
  const c = load(file);
  const existing = new Set(c.nodes.map((n) => n.id));
  const taken = new Set(existing);
  const added: string[] = [];
  const updated: string[] = [];
  const warnings: string[] = [];
  const units: CanvasNode[][] = [];
  const deferred: ItemIn[] = [];
  const pinned: CanvasNode[] = [];

  for (const it of items) {
    if (it.id && existing.has(it.id)) {
      if (updateNode(c, it, warnings)) updated.push(it.id);
      continue;
    }
    if (it.parent) {
      deferred.push(it);
      continue;
    }
    const members = inferType(it) === 'group' ? buildGroup(it, taken) : [makeNode(it, taken)];
    const label = members.length > 1 ? `${members[0].id} [${members.slice(1).map((m) => m.id).join(', ')}]` : members[0].id;
    added.push(label);
    if (members[0].pinned) {
      pinned.push(...members);
      continue;
    }
    const x = num(it.x);
    const y = num(it.y);
    if (x !== undefined && y !== undefined) {
      translate(members, x, y);
      c.nodes.push(...members);
      continue;
    }
    units.push(members);
  }

  const arrows = arr<ArrowIn>(args.arrows);
  if (units.length) {
    const owner = new Map<string, string>();
    for (const u of units) for (const m of u) owner.set(m.id, u[0].id);
    const unitEdges = arrows
      .map((a) => ({ from: owner.get(String(a.from)) ?? '', to: owner.get(String(a.to)) ?? '', label: str(a.label) }))
      .filter((e) => e.from && e.to && e.from !== e.to);
    let mode = str(args.layout);
    if (!mode || !['column', 'row', 'grid', 'flow-down', 'flow-right'].includes(mode)) {
      mode = unitEdges.length
        ? 'flow-down'
        : units.length > 1 && units.every((u) => u[0].type === 'group')
          ? 'row'
          : 'column';
    }
    const proxies = units.map((u) => ({ id: u[0].id, x: 0, y: 0, width: u[0].width, height: u[0].height }));
    if (mode === 'flow-down' || mode === 'flow-right') layered(proxies, unitEdges, mode === 'flow-down' ? 'down' : 'right');
    else stack(proxies, mode as StackMode, mode === 'row' ? 24 : 16);
    units.forEach((u, i) => translate(u, proxies[i].x, proxies[i].y));
    const all = units.flat();
    const bb = bbox(all)!;
    const at = placeBlock(c, bb, args.position as Placement | undefined);
    translate(all, at.x - bb.x, at.y - bb.y);
    c.nodes.push(...all);
  }

  if (pinned.length) {
    const content = bbox(c.nodes.filter((n) => !n.pinned));
    let y = (content?.y ?? 0) - BLOCK_GAP;
    for (const p of pinned) {
      y -= p.height;
      p.x = content?.x ?? 0;
      p.y = y;
      c.nodes.push(p);
    }
  }

  for (const it of deferred) {
    const n = makeNode({ ...it, children: undefined }, taken);
    try {
      appendToGroup(c, String(it.parent), n, num(it.width) !== undefined);
      added.push(n.id);
    } catch (e) {
      taken.delete(n.id);
      warnings.push((e as Error).message);
    }
  }

  const ids = new Set(c.nodes.map((n) => n.id));
  const edgeIds = new Set(c.edges.map((e) => e.id));
  const newEdges: string[] = [];
  for (const a of arrows) {
    const from = String(a.from ?? '');
    const to = String(a.to ?? '');
    if (!ids.has(from) || !ids.has(to)) {
      warnings.push(`arrow ${from} -> ${to}: unknown card id`);
      continue;
    }
    let id = str(a.id);
    if (id && !edgeIds.has(id)) edgeIds.add(id);
    else id = newId(edgeIds);
    const e: CanvasEdge = { id, fromNode: from, toNode: to, ...endsOf(a) };
    const color = normalizeColor(a.color);
    if (color) e.color = color;
    if (a.label) e.label = String(a.label);
    c.edges.push(e);
    newEdges.push(id);
  }

  save(file, c);
  const parts: string[] = [];
  if (added.length) parts.push(`Added: ${added.join(', ')}`);
  if (updated.length) parts.push(`Updated in place: ${updated.join(', ')}`);
  if (newEdges.length) parts.push(`Arrows: ${newEdges.join(', ')}`);
  if (warnings.length) parts.push(`Warnings: ${warnings.join('; ')}`);
  return parts.join('\n') || 'Nothing changed';
}

function updateBoard(args: Record<string, unknown>): string {
  const items = arr<ItemIn>(args.items);
  const arrows = arr<ArrowIn>(args.arrows);
  if (!items.length && !arrows.length) throw new Error('pass "items" and/or "arrows" to update');
  const file = findBoard();
  const c = load(file);
  const warnings: string[] = [];
  const done: string[] = [];
  for (const u of items) {
    if (!u?.id) {
      warnings.push('item without id');
      continue;
    }
    try {
      if (updateNode(c, u, warnings)) done.push(u.id);
    } catch (e) {
      warnings.push(`${u.id}: ${(e as Error).message}`);
    }
  }
  const ids = new Set(c.nodes.map((n) => n.id));
  for (const a of arrows) {
    const e = c.edges.find((x) => x.id === a.id);
    if (!e) {
      warnings.push(`no arrow "${a.id}"`);
      continue;
    }
    if (a.label !== undefined) {
      if (a.label) e.label = String(a.label);
      else delete e.label;
    }
    const color = normalizeColor(a.color);
    if (color === null) delete e.color;
    else if (color) e.color = color;
    if (a.from !== undefined) {
      if (ids.has(a.from)) e.fromNode = a.from;
      else warnings.push(`arrow ${a.id}: unknown card "${a.from}"`);
    }
    if (a.to !== undefined) {
      if (ids.has(a.to)) e.toNode = a.to;
      else warnings.push(`arrow ${a.id}: unknown card "${a.to}"`);
    }
    if (a.ends) {
      delete e.fromEnd;
      delete e.toEnd;
      Object.assign(e, endsOf(a));
    }
    if (a.from !== undefined || a.to !== undefined) {
      delete e.fromSide;
      delete e.toSide;
    }
    done.push(String(a.id));
  }
  save(file, c);
  return [done.length ? `Updated: ${done.join(', ')}` : 'Nothing updated', warnings.length ? `Warnings: ${warnings.join('; ')}` : '']
    .filter(Boolean)
    .join('\n');
}

function deleteFromBoard(args: Record<string, unknown>): string {
  const file = findBoard();
  const c = load(file);
  if (args.all === true) {
    const count = c.nodes.length;
    c.nodes = [];
    c.edges = [];
    save(file, c);
    return `Board cleared (${count} items removed)`;
  }
  const ids = arr<string>(args.ids).map(String);
  if (!ids.length) throw new Error('pass "ids" (or all: true)');
  const keep = args.keep_children === true;
  const pm = parentMap(c);
  const warnings: string[] = [];
  const roots: CanvasNode[] = [];
  const edgeIds = new Set<string>();
  for (const id of ids) {
    const n = c.nodes.find((x) => x.id === id);
    if (n) roots.push(n);
    else if (c.edges.some((e) => e.id === id)) edgeIds.add(id);
    else warnings.push(`no card or arrow "${id}"`);
  }
  const rootIds = new Set(roots.map((n) => n.id));
  const isUnderDeleted = (n: CanvasNode) => {
    for (let p = pm.get(n.id); p; p = pm.get(p)) if (rootIds.has(p) && !keep) return true;
    return false;
  };
  let removed = 0;
  for (const n of roots.filter((r) => !isUnderDeleted(r)).sort((a, b) => b.y - a.y)) {
    const sub = n.type === 'group' && !keep ? descendants(c, parentMap(c), n.id) : [];
    if (!(n.type === 'group' && keep)) closeGap(c, n.id);
    const gone = new Set([n.id, ...sub]);
    removed += gone.size;
    c.nodes = c.nodes.filter((x) => !gone.has(x.id));
  }
  const alive = new Set(c.nodes.map((n) => n.id));
  const before = c.edges.length;
  c.edges = c.edges.filter((e) => !edgeIds.has(e.id) && alive.has(e.fromNode) && alive.has(e.toNode));
  save(file, c);
  return [`Deleted ${removed} items and ${before - c.edges.length} arrows`, warnings.length ? `Warnings: ${warnings.join('; ')}` : '']
    .filter(Boolean)
    .join('\n');
}

function setFocus(args: Record<string, unknown>): string {
  const text = String(args.text ?? '').trim();
  const file = findBoard();
  const c = load(file);
  const n = c.nodes.find((x) => x.id === 'focus');
  if (!text) {
    if (!n) return 'No focus to clear';
    c.nodes = c.nodes.filter((x) => x.id !== 'focus');
    c.edges = c.edges.filter((e) => e.fromNode !== 'focus' && e.toNode !== 'focus');
    save(file, c);
    return 'Focus cleared';
  }
  const color = normalizeColor(args.color);
  if (n) {
    n.type = 'text';
    n.text = text;
    n.pinned = true;
    n.autoHeight = true;
    n.height = estimateTextHeight(text, n.width);
    if (color === null) delete n.color;
    else if (color) n.color = color;
  } else {
    const content = bbox(c.nodes.filter((x) => !x.pinned));
    const width = 420;
    const height = estimateTextHeight(text, width);
    const node: CanvasNode = {
      id: 'focus',
      type: 'text',
      text,
      x: content?.x ?? 0,
      y: (content?.y ?? 0) - BLOCK_GAP - height,
      width,
      height,
      pinned: true,
      autoHeight: true,
    };
    if (color) node.color = color;
    c.nodes.push(node);
  }
  save(file, c);
  return 'Focus set (pinned at the top of the board)';
}

// ---------- MCP wiring ----------

const INSTRUCTIONS = `Desk is the user's whiteboard: a JSON Canvas file (.desk/board.canvas in the project) that the user keeps open in a VS Code tab next to this chat. It keeps in front of them what matters now: goal, current focus, plan, tasks, decisions, small diagrams.

Use it when the user asks to put/show/draw something on the board ("на доску", "выведи на доску", "board"), or to update their goal, focus, plan or tasks. Do not mirror routine chat answers onto the board.

- Call board_read before changing the board: the user edits it too (moves cards, ticks tasks, rewrites text). Update existing cards instead of adding duplicates.
- One idea per card. Cards are short markdown: a bold title or heading, then a few bullets or "- [ ] task" checklists. No long prose.
- Sections are groups: board_add with {"label": "...", "children": [cards]}. Several groups in one call are placed side by side (e.g. Now / Next / Done).
- Flows and architecture: cards with short ids plus arrows (from/to) and layout "flow-down" or "flow-right". Coordinates are computed for you; don't pass x/y unless asked.
- The current goal/focus goes to board_focus: it stays pinned at the top.
- Write in the user's language. Use color for meaning (green done/ok, red blocker/risk, yellow attention), not decoration.
- In cards, file paths in backticks (\`src/app.ts:42\`) and links are clickable for the user.`;

const COLOR = { type: 'string', description: 'red | orange | yellow | green | cyan | blue | purple | gray | #rrggbb' };
const CARD_PROPS = {
  id: { type: 'string', description: 'Optional short stable id ("goal", "api") to reference later; auto-generated if omitted' },
  type: { type: 'string', enum: ['text', 'group', 'file', 'link'], description: 'Default "text" ("group" when label/children are given)' },
  text: { type: 'string', description: 'Markdown for a text card. Short: a title line, a few bullets, "- [ ] task" checklists' },
  label: { type: 'string', description: 'Group title' },
  file: { type: 'string', description: 'Workspace-relative path for a file card (opens on click)' },
  url: { type: 'string', description: 'URL for a link card' },
  color: COLOR,
  pinned: { type: 'boolean', description: 'Show in the always-visible bar at the top of the board' },
  width: { type: 'number', description: 'Default 280 for cards' },
  height: { type: 'number', description: 'Omit: cards fit their text automatically' },
};

const TOOLS = [
  {
    name: 'board_read',
    description:
      "Read the user's board: pinned focus, groups with their cards, loose cards and arrows, with ids and boxes ([x, y, width, height]). Call it before changing the board — the user edits it too.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Read board', readOnlyHint: true },
    run: () => readBoard(),
  },
  {
    name: 'board_add',
    description:
      'Add cards, groups (sections with cards inside) and arrows to the board. Layout is automatic: children stack inside their group; the items of one call are arranged together (column, row, grid, or a flow along the arrows) in free space, or next to an existing card via "position". Use "parent" to append a card to an existing group. An item whose id already exists is updated in place. Returns the new ids.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              ...CARD_PROPS,
              parent: { type: 'string', description: 'Id of an existing group: append this card at the end of it' },
              children: {
                type: 'array',
                description: 'For a group: its cards, in order',
                items: { type: 'object', properties: CARD_PROPS },
              },
              layout: { type: 'string', enum: ['column', 'row', 'grid'], description: 'For a group: how its children are arranged (default column)' },
              x: { type: 'number', description: 'Explicit position; normally omit and let the layout decide' },
              y: { type: 'number' },
            },
          },
        },
        arrows: {
          type: 'array',
          description: 'Arrows between cards or groups (new or existing ids)',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
              color: COLOR,
              ends: { type: 'string', enum: ['arrow', 'both', 'none'], description: 'Default "arrow" (pointing at "to")' },
              id: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
        layout: {
          type: 'string',
          enum: ['column', 'row', 'grid', 'flow-down', 'flow-right'],
          description: 'How the top-level items of this call are arranged. Default: flow-down if arrows connect them, row for several groups, else column',
        },
        position: {
          type: 'object',
          description: 'Where to put this block. Default: free space to the right of the existing content',
          properties: {
            below: { type: 'string', description: 'Card or group id' },
            right_of: { type: 'string' },
            above: { type: 'string' },
            left_of: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      },
      required: ['items'],
    },
    annotations: { title: 'Add to board' },
    run: (a: Record<string, unknown>) => addToBoard(a),
  },
  {
    name: 'board_update',
    description:
      'Change existing cards, groups or arrows by id: text, label, color (null clears), pinned, size, position, or move a card into a group ("parent": id) or out of it ("parent": null). Cards re-fit their new text and the cards below them move accordingly. Moving a group moves its cards.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              label: { type: 'string' },
              file: { type: 'string' },
              url: { type: 'string' },
              color: { type: ['string', 'null'], description: COLOR.description + ' | null' },
              pinned: { type: 'boolean' },
              parent: { type: ['string', 'null'], description: 'Group id to move the card into, or null to take it out' },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['id'],
          },
        },
        arrows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: ['string', 'null'] },
              color: { type: ['string', 'null'] },
              from: { type: 'string' },
              to: { type: 'string' },
              ends: { type: 'string', enum: ['arrow', 'both', 'none'] },
            },
            required: ['id'],
          },
        },
      },
    },
    annotations: { title: 'Update board', idempotentHint: true },
    run: (a: Record<string, unknown>) => updateBoard(a),
  },
  {
    name: 'board_delete',
    description:
      'Delete cards, groups or arrows by id. Deleting a group deletes its cards unless keep_children is true; arrows attached to deleted cards go too; cards below a deleted one in a group move up. all: true clears the whole board.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        keep_children: { type: 'boolean' },
        all: { type: 'boolean' },
      },
    },
    annotations: { title: 'Delete from board', destructiveHint: true },
    run: (a: Record<string, unknown>) => deleteFromBoard(a),
  },
  {
    name: 'board_focus',
    description:
      "Set the user's current goal / focus: one card pinned at the top of the board, always visible. 1-3 short lines of markdown. Empty text removes it.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, color: COLOR },
      required: ['text'],
    },
    annotations: { title: 'Set focus', idempotentHint: true },
    run: (a: Record<string, unknown>) => setFocus(a),
  },
];

async function main() {
  if (process.argv.includes('--where')) {
    process.stdout.write(findBoard() + '\n');
    return;
  }
  const server = new Server({ name: 'desk', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ run: _run, ...t }) => t),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
    try {
      const text = tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`desk mcp: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
