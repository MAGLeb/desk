import { Canvas, CanvasNode, Side, cloneCanvas, newId, sameCanvas } from '../shared/canvas';
import {
  CARD_W,
  GROUP_W,
  HEADER,
  Rect,
  applyHeightChange,
  bbox,
  closeGap,
  descendants,
  fitGroup,
  insertIntoColumn,
  isColumnGroup,
  parentMap,
} from '../shared/layout';
import { Op, applyOps, diffOps } from '../shared/ops';
import { icons } from './icons';
import { setLang, t } from './i18n';
import { renderMarkdown, toggleTask } from './markdown';

declare function acquireVsCodeApi(): {
  postMessage(m: unknown): void;
  getState(): any;
  setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();

// ---------------- state ----------------

let board: Canvas = { nodes: [], edges: [] };
let brokenFile: string | undefined;
const history: Canvas[] = [];
let future: Canvas[] = [];
const view = { x: 0, y: 0, z: 1 };
let sel = new Set<string>();
let selEdge: string | null = null;
let seq = 0;
let ready = false;
let spaceDown = false;

type Editing = {
  kind: 'node' | 'label' | 'edge';
  id: string;
  isNew?: boolean;
  histLen?: number;
  el: HTMLTextAreaElement | HTMLInputElement;
  wrap?: HTMLElement;
};
let editing: Editing | null = null;

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | {
      kind: 'move';
      sx: number;
      sy: number;
      ids: string[];
      start: Map<string, { x: number; y: number }>;
      moved: boolean;
      clickId: string;
      shift: boolean;
      drop?: string;
      dropY: number;
    }
  | { kind: 'resize'; id: string; sx: number; sy: number; w: number; h: number; autoText: boolean; autoOff: boolean }
  | { kind: 'band'; sx: number; sy: number; base: Set<string> }
  | { kind: 'connect'; from: string; side: Side; sx: number; sy: number; target?: HTMLElement };
let drag: Drag | null = null;
const preview = new Map<string, Partial<Rect>>();

const MIN_W = 80;
const MIN_H = 36;
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

const byId = (id: string) => board.nodes.find((n) => n.id === id);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---------------- DOM ----------------

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="broken" hidden></div>
<div class="pinbar" hidden></div>
<div class="viewport">
  <div class="world">
    <div class="layer groups"></div>
    <svg class="edges"><g class="edge-shift"><g class="edge-paths"></g><path class="edge-temp" d=""/></g></svg>
    <div class="layer cards"></div>
  </div>
  <div class="band" hidden></div>
  <div class="empty" hidden><div class="empty-title"></div><div class="empty-hint"></div></div>
  <div class="selbar" hidden></div>
  <div class="toolbar">
    <button data-action="add-card">${icons.card}</button>
    <button data-action="add-group">${icons.group}</button>
    <span class="sep"></span>
    <button data-action="zoom-out">${icons.minus}</button>
    <button data-action="zoom-reset" class="zoom">100%</button>
    <button data-action="zoom-in">${icons.plus}</button>
    <button data-action="fit">${icons.fit}</button>
    <span class="sep"></span>
    <button data-action="undo">${icons.undo}</button>
    <button data-action="redo">${icons.redo}</button>
  </div>
</div>`;

const $ = <T extends Element = HTMLElement>(s: string) => app.querySelector(s) as unknown as T;
const brokenEl = $('.broken');
const pinbar = $('.pinbar');
const viewport = $('.viewport');
const world = $('.world');
const groupsLayer = $('.layer.groups');
const cardsLayer = $('.layer.cards');
const edgesSvg = $<SVGSVGElement>('svg.edges');
const edgeShift = $<SVGGElement>('.edge-shift');
const edgePaths = $<SVGGElement>('.edge-paths');
const edgeTemp = $<SVGPathElement>('.edge-temp');
const band = $('.band');
const emptyEl = $('.empty');
const selbar = $('.selbar');
const toolbar = $('.toolbar');
const zoomBtn = $('[data-action="zoom-reset"]');

function applyStaticTexts(): void {
  const titles: Record<string, string> = {
    'add-card': t.addCard,
    'add-group': t.addGroup,
    'zoom-out': t.zoomOut,
    'zoom-reset': t.zoomReset,
    'zoom-in': t.zoomIn,
    fit: t.fit,
    undo: t.undo,
    redo: t.redo,
  };
  toolbar.querySelectorAll<HTMLElement>('button').forEach((b) => (b.title = titles[b.dataset.action!] ?? ''));
  $('.empty-title').textContent = t.emptyTitle;
  $('.empty-hint').textContent = t.emptyHint;
}

// ---------------- history / sync ----------------

function post(m: unknown): void {
  vscode.postMessage(m);
}

function pushHistory(prev: Canvas): void {
  history.push(prev);
  if (history.length > 300) history.shift();
  future = [];
}

function commit(ops: Op[], opts: { silent?: boolean } = {}): void {
  if (!ops.length) return;
  const prev = board;
  board = applyOps(board, ops);
  if (!opts.silent) pushHistory(prev);
  seq++;
  post({ type: 'ops', ops, seq });
  render();
}

function replaceBoard(next: Canvas): void {
  board = next;
  seq++;
  post({ type: 'ops', ops: [{ op: 'replace', canvas: next }], seq });
  pruneSelection();
  render();
}

function undo(): void {
  const prev = history.pop();
  if (!prev) return;
  future.push(board);
  replaceBoard(prev);
}

function redo(): void {
  const next = future.pop();
  if (!next) return;
  history.push(board);
  replaceBoard(next);
}

function pruneSelection(): void {
  const ids = new Set(board.nodes.map((n) => n.id));
  sel = new Set([...sel].filter((id) => ids.has(id)));
  if (selEdge && !board.edges.some((e) => e.id === selEdge)) selEdge = null;
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    setLang(msg.lang);
    applyStaticTexts();
    board = msg.board;
    brokenFile = msg.error;
    ready = true;
    render();
    requestAnimationFrame(initialView);
  } else if (msg.type === 'state') {
    onState(msg);
  }
});

function onState(msg: { board: Canvas; source: 'local' | 'external'; error?: string; ack?: number }): void {
  if (msg.error) {
    brokenFile = msg.error;
    renderBroken();
    return;
  }
  brokenFile = undefined;
  if (msg.source === 'local') {
    if (typeof msg.ack === 'number' && msg.ack < seq) return;
    if (!sameCanvas(board, msg.board)) {
      board = msg.board;
      pruneSelection();
    }
    render();
    return;
  }
  if (sameCanvas(board, msg.board)) {
    renderBroken();
    return;
  }
  const prev = board;
  pushHistory(prev);
  board = msg.board;
  pruneSelection();
  render();
  const changed = changedIds(prev, board);
  flash(changed);
  if (!drag && !editing) revealIfHidden(changed, prev);
}

function changedIds(a: Canvas, b: Canvas): string[] {
  const before = new Map(a.nodes.map((n) => [n.id, n]));
  const keys = ['type', 'text', 'label', 'file', 'url', 'color', 'x', 'y', 'width', 'pinned'];
  return b.nodes
    .filter((n) => {
      const o = before.get(n.id);
      return !o || keys.some((k) => (o as Record<string, unknown>)[k] !== (n as Record<string, unknown>)[k]);
    })
    .map((n) => n.id);
}

function flash(ids: string[]): void {
  for (const id of ids) {
    const el = els.get(id) ?? (pinbar.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null);
    if (!el) continue;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1700);
  }
}

// ---------------- view ----------------

let saveTimer: number | undefined;

function applyView(): void {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  world.style.setProperty('--z', String(view.z));
  const step = 24 * view.z;
  viewport.style.backgroundSize = `${step}px ${step}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  viewport.classList.toggle('far', view.z < 0.45);
  zoomBtn.textContent = `${Math.round(view.z * 100)}%`;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => vscode.setState({ view }), 250);
}

let anim = 0;
function setView(target: { x: number; y: number; z: number }, animate = false): void {
  cancelAnimationFrame(anim);
  if (!animate) {
    Object.assign(view, target);
    applyView();
    return;
  }
  const from = { ...view };
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 280);
    const e = 1 - Math.pow(1 - k, 3);
    view.x = from.x + (target.x - from.x) * e;
    view.y = from.y + (target.y - from.y) * e;
    view.z = from.z + (target.z - from.z) * e;
    applyView();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

function toWorld(cx: number, cy: number): [number, number] {
  const r = viewport.getBoundingClientRect();
  return [(cx - r.left - view.x) / view.z, (cy - r.top - view.y) / view.z];
}

function visibleWorld(): Rect {
  const [x1, y1] = toWorld(viewport.getBoundingClientRect().left, viewport.getBoundingClientRect().top);
  return { x: x1, y: y1, width: viewport.clientWidth / view.z, height: viewport.clientHeight / view.z };
}

function zoomAt(cx: number, cy: number, factor: number): void {
  cancelAnimationFrame(anim);
  const r = viewport.getBoundingClientRect();
  const px = cx - r.left;
  const py = cy - r.top;
  const z = clamp(view.z * factor, 0.1, 3);
  const k = z / view.z;
  view.x = px - (px - view.x) * k;
  view.y = py - (py - view.y) * k;
  view.z = z;
  applyView();
}

function zoomCenter(factor: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

function contentRect(): Rect | null {
  return bbox(board.nodes.filter((n) => !n.pinned).map((n) => nodeRect(n.id)!));
}

function fitTo(r: Rect | null, opts: { animate?: boolean; maxZoom?: number } = {}): void {
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  if (!vw || !vh) return;
  if (!r) {
    setView({ x: vw / 2 - CARD_W / 2, y: vh / 3, z: 1 }, opts.animate);
    return;
  }
  const pad = 48;
  const z = clamp(Math.min((vw - pad * 2) / r.width, (vh - pad * 2) / r.height), 0.1, opts.maxZoom ?? 1);
  const x = (vw - r.width * z) / 2 - r.x * z;
  const y = r.height * z > vh - pad * 2 ? pad - r.y * z : (vh - r.height * z) / 2 - r.y * z;
  setView({ x, y, z }, opts.animate);
}

function initialView(): void {
  const st = vscode.getState();
  const content = contentRect();
  if (st?.view && typeof st.view.z === 'number') {
    setView(st.view);
    const vis = visibleWorld();
    const anyVisible = board.nodes.some((n) => !n.pinned && intersectsRect(nodeRect(n.id)!, vis));
    if (anyVisible || !content) return;
  }
  fitTo(content);
}

function intersectsRect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function revealIfHidden(ids: string[], prev: Canvas): void {
  const rects = ids.map(nodeRect).filter((r): r is Rect => !!r);
  const changed = bbox(rects);
  if (!changed) return;
  const vis = visibleWorld();
  const inside =
    changed.x >= vis.x && changed.y >= vis.y && changed.x + changed.width <= vis.x + vis.width && changed.y + changed.height <= vis.y + vis.height;
  if (inside && prev.nodes.some((n) => !n.pinned)) return;
  const all = contentRect();
  if (!all) return;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const zAll = Math.min((vw - 96) / all.width, (vh - 96) / all.height);
  fitTo(zAll >= 0.5 ? all : changed, { animate: true });
}

// ---------------- rendering ----------------

const els = new Map<string, HTMLElement>();
const lastMd = new Map<string, string>();

function cssColor(c?: string): string | null {
  if (!c) return null;
  return /^[1-6]$/.test(c) ? `var(--c${c})` : c;
}

function setColor(el: HTMLElement, c?: string): void {
  const v = cssColor(c);
  if (v) el.style.setProperty('--c', v);
  else el.style.removeProperty('--c');
  el.classList.toggle('colored', !!v);
}

function setMd(host: HTMLElement, key: string, text: string): void {
  const box = host.querySelector('.md') as HTMLElement | null;
  if (!box || lastMd.get(key) === text) return;
  box.innerHTML = text.trim() ? renderMarkdown(text) : '';
  lastMd.set(key, text);
}

function nodeEl(n: CanvasNode): HTMLElement {
  let el = els.get(n.id);
  if (el && el.dataset.type === n.type) return el;
  el?.remove();
  el = document.createElement('div');
  el.className = `node ${n.type}`;
  el.dataset.id = n.id;
  el.dataset.type = n.type;
  if (n.type === 'group') el.innerHTML = '<div class="glabel"></div>';
  else if (n.type === 'text') el.innerHTML = '<div class="md"></div>';
  else
    el.innerHTML = `<div class="ref"><span class="ref-icon">${n.type === 'file' ? icons.file : icons.link}</span><div class="ref-text"><a class="ref-name"></a><div class="ref-sub"></div></div></div>`;
  el.insertAdjacentHTML('beforeend', '<div class="handle"></div>' + SIDES.map((s) => `<div class="conn ${s}" data-side="${s}"></div>`).join(''));
  els.set(n.id, el);
  lastMd.delete(n.id);
  return el;
}

function updateNodeEl(el: HTMLElement, n: CanvasNode): void {
  const p = preview.get(n.id);
  el.style.left = `${p?.x ?? n.x}px`;
  el.style.top = `${p?.y ?? n.y}px`;
  el.style.width = `${p?.width ?? n.width}px`;
  const auto = n.type === 'text' && !!n.autoHeight && p?.height === undefined;
  const isEditing = editing?.kind === 'node' && editing.id === n.id;
  el.style.height = auto || isEditing ? '' : `${p?.height ?? n.height}px`;
  el.classList.toggle('auto', auto);
  setColor(el, n.color);
  el.classList.toggle('selected', sel.has(n.id));
  el.classList.toggle('solo', sel.size === 1 && sel.has(n.id));
  if (n.type === 'text') {
    if (!(editing?.kind === 'node' && editing.id === n.id)) setMd(el, n.id, n.text ?? '');
  } else if (n.type === 'group') {
    if (!(editing?.kind === 'label' && editing.id === n.id)) {
      const label = el.querySelector('.glabel')!;
      if (label.textContent !== (n.label ?? '')) label.textContent = n.label ?? '';
    }
  } else {
    const raw = n.type === 'file' ? n.file ?? '' : n.url ?? '';
    let name = raw;
    let sub = '';
    if (n.type === 'file') {
      const i = raw.lastIndexOf('/');
      name = raw.slice(i + 1) || raw;
      sub = (i > 0 ? raw.slice(0, i) : '') + (n.subpath ? ` ${n.subpath}` : '');
    } else {
      try {
        const u = new URL(raw);
        name = u.hostname.replace(/^www\./, '');
        sub = (u.pathname + u.search).replace(/^\/$/, '');
      } catch {
        /* not a URL */
      }
    }
    el.querySelector('.ref-name')!.textContent = name || '—';
    el.querySelector('.ref-sub')!.textContent = sub;
  }
}

function syncLayer(layer: HTMLElement, nodes: CanvasNode[]): void {
  let prev: ChildNode | null = null;
  for (const n of nodes) {
    const el = nodeEl(n);
    updateNodeEl(el, n);
    const expected: ChildNode | null = prev ? prev.nextSibling : layer.firstChild;
    if (el.parentNode !== layer || expected !== el) layer.insertBefore(el, expected);
    prev = el;
  }
}

function renderNodes(): void {
  const groups: CanvasNode[] = [];
  const cards: CanvasNode[] = [];
  const alive = new Set<string>();
  for (const n of board.nodes) {
    if (n.pinned) continue;
    alive.add(n.id);
    (n.type === 'group' ? groups : cards).push(n);
  }
  for (const [id, el] of els) {
    if (alive.has(id)) continue;
    el.remove();
    els.delete(id);
    lastMd.delete(id);
  }
  groups.sort((a, b) => b.width * b.height - a.width * a.height);
  syncLayer(groupsLayer, groups);
  syncLayer(cardsLayer, cards);
}

function pinText(n: CanvasNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'group') return `**${n.label ?? ''}**`;
  return n.type === 'file' ? `\`${n.file ?? ''}\`` : n.url ?? '';
}

function renderPinbar(): void {
  const pins = board.nodes.filter((n) => n.pinned);
  pinbar.hidden = !pins.length;
  const alive = new Set(pins.map((p) => p.id));
  for (const el of Array.from(pinbar.children) as HTMLElement[]) {
    if (alive.has(el.dataset.id!)) continue;
    el.remove();
    lastMd.delete(`pin:${el.dataset.id}`);
  }
  let prev: ChildNode | null = null;
  for (const n of pins) {
    let el = pinbar.querySelector(`.pin[data-id="${CSS.escape(n.id)}"]`) as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'pin';
      el.dataset.id = n.id;
      el.innerHTML = `<span class="pin-icon">${icons.pin}</span><div class="md"></div><button class="pin-off" data-action="unpin">${icons.close}</button>`;
    }
    (el.querySelector('.pin-off') as HTMLElement).title = t.unpin;
    const expected: ChildNode | null = prev ? prev.nextSibling : pinbar.firstChild;
    if (el.parentNode !== pinbar || expected !== el) pinbar.insertBefore(el, expected);
    prev = el;
    setColor(el, n.color);
    el.classList.toggle('selected', sel.has(n.id));
    if (!(editing?.kind === 'node' && editing.id === n.id)) setMd(el, `pin:${n.id}`, pinText(n));
  }
}

function nodeRect(id: string): Rect | undefined {
  const n = byId(id);
  if (!n || n.pinned) return undefined;
  const p = preview.get(id);
  let h = p?.height ?? n.height;
  if (n.type === 'text' && n.autoHeight && p?.height === undefined) {
    const el = els.get(id);
    if (el?.offsetHeight) h = el.offsetHeight;
  }
  return { x: p?.x ?? n.x, y: p?.y ?? n.y, width: p?.width ?? n.width, height: h };
}

type Pt = [number, number];
const NORMALS: Record<Side, Pt> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function sidePoint(r: Rect, s: Side): Pt {
  if (s === 'top') return [r.x + r.width / 2, r.y];
  if (s === 'bottom') return [r.x + r.width / 2, r.y + r.height];
  if (s === 'left') return [r.x, r.y + r.height / 2];
  return [r.x + r.width, r.y + r.height / 2];
}

function autoSides(a: Rect, b: Rect): [Side, Side] {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (gapX > gapY) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function nearestSide(r: Rect, x: number, y: number): Side {
  const d: Record<Side, number> = {
    top: Math.abs(y - r.y),
    bottom: Math.abs(y - (r.y + r.height)),
    left: Math.abs(x - r.x),
    right: Math.abs(x - (r.x + r.width)),
  };
  return SIDES.reduce((best, s) => (d[s] < d[best] ? s : best), 'top' as Side);
}

const AH = 9;
const f = (n: number) => Math.round(n * 10) / 10;

function curve(p1: Pt, n1: Pt, p2: Pt, n2: Pt, headStart: boolean, headEnd: boolean) {
  const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const k = clamp(dist * 0.45, 24, 160);
  const c1: Pt = [p1[0] + n1[0] * k, p1[1] + n1[1] * k];
  const c2: Pt = [p2[0] + n2[0] * k, p2[1] + n2[1] * k];
  const s: Pt = headStart ? [p1[0] + n1[0] * (AH - 1), p1[1] + n1[1] * (AH - 1)] : p1;
  const e: Pt = headEnd ? [p2[0] + n2[0] * (AH - 1), p2[1] + n2[1] * (AH - 1)] : p2;
  const d = `M${f(s[0])},${f(s[1])} C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(e[0])},${f(e[1])}`;
  const mid: Pt = [
    0.125 * p1[0] + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * p2[0],
    0.125 * p1[1] + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * p2[1],
  ];
  return { d, mid };
}

function head(tip: Pt, n: Pt): string {
  // n points out of the node; the arrow points into it.
  const bx = tip[0] + n[0] * AH;
  const by = tip[1] + n[1] * AH;
  const px = -n[1] * 4.5;
  const py = n[0] * 4.5;
  return `M${f(tip[0])},${f(tip[1])} L${f(bx + px)},${f(by + py)} L${f(bx - px)},${f(by - py)} Z`;
}

function renderEdges(): void {
  const rects = new Map<string, Rect>();
  for (const n of board.nodes) {
    const r = nodeRect(n.id);
    if (r) rects.set(n.id, r);
  }
  const all = bbox([...rects.values()]) ?? { x: 0, y: 0, width: 0, height: 0 };
  const ox = Math.floor(all.x - 2000);
  const oy = Math.floor(all.y - 2000);
  edgesSvg.style.left = `${ox}px`;
  edgesSvg.style.top = `${oy}px`;
  edgesSvg.setAttribute('width', String(Math.ceil(all.width + 4000)));
  edgesSvg.setAttribute('height', String(Math.ceil(all.height + 4000)));
  edgeShift.setAttribute('transform', `translate(${-ox},${-oy})`);
  let html = '';
  for (const e of board.edges) {
    const a = rects.get(e.fromNode);
    const b = rects.get(e.toNode);
    if (!a || !b) continue;
    const auto = autoSides(a, b);
    const s1 = e.fromSide ?? auto[0];
    const s2 = e.toSide ?? auto[1];
    const p1 = sidePoint(a, s1);
    const p2 = sidePoint(b, s2);
    const endHead = e.toEnd !== 'none';
    const startHead = e.fromEnd === 'arrow';
    const { d, mid } = curve(p1, NORMALS[s1], p2, NORMALS[s2], startHead, endHead);
    const color = cssColor(e.color) ?? 'var(--edge)';
    html +=
      `<g class="edge${selEdge === e.id ? ' selected' : ''}" data-eid="${esc(e.id)}" style="--ec:${color}">` +
      `<path class="ehit" d="${d}"/><path class="eline" d="${d}"/>` +
      (endHead ? `<path class="ehead" d="${head(p2, NORMALS[s2])}"/>` : '') +
      (startHead ? `<path class="ehead" d="${head(p1, NORMALS[s1])}"/>` : '') +
      (e.label ? `<text class="elabel" x="${f(mid[0])}" y="${f(mid[1])}">${esc(e.label)}</text>` : '') +
      '</g>';
  }
  edgePaths.innerHTML = html;
}

let lastSelbar = '';
function renderSelbar(): void {
  const nodes = [...sel].map(byId).filter((n): n is CanvasNode => !!n);
  const edge = selEdge ? board.edges.find((e) => e.id === selEdge) : undefined;
  if (!nodes.length && !edge) {
    selbar.hidden = true;
    lastSelbar = '';
    return;
  }
  const colors = edge ? [edge.color ?? ''] : nodes.map((n) => n.color ?? '');
  const current = colors.every((c) => c === colors[0]) ? colors[0] : '?';
  let html = ['', '1', '2', '3', '4', '5', '6']
    .map((c) => {
      const title = c ? t.colors[Number(c) - 1] : t.noColor;
      const style = c ? ` style="--c: var(--c${c})"` : '';
      return `<button class="swatch${c ? '' : ' none'}${current === c ? ' on' : ''}" data-color="${c}" title="${title}"${style}></button>`;
    })
    .join('');
  html += '<span class="sep"></span>';
  if (nodes.length === 1 && !edge) {
    html += `<button class="tb${nodes[0].pinned ? ' on' : ''}" data-action="pin" title="${nodes[0].pinned ? t.unpin : t.pin}">${icons.pin}</button>`;
  }
  if (nodes.length) html += `<button class="tb" data-action="duplicate" title="${t.duplicate}">${icons.copy}</button>`;
  html += `<button class="tb danger" data-action="delete" title="${t.delete}">${icons.trash}</button>`;
  selbar.hidden = false;
  if (html !== lastSelbar) {
    selbar.innerHTML = html;
    lastSelbar = html;
  }
}

function renderBroken(): void {
  brokenEl.hidden = !brokenFile;
  if (brokenFile) brokenEl.innerHTML = `<b>${esc(t.broken)}</b> ${esc(brokenFile)}. ${esc(t.brokenHint)}`;
}

function render(): void {
  if (!ready) return;
  renderBroken();
  renderPinbar();
  renderNodes();
  renderEdges();
  renderSelbar();
  emptyEl.hidden = board.nodes.some((n) => !n.pinned);
  (toolbar.querySelector('[data-action="undo"]') as HTMLButtonElement).disabled = !history.length;
  (toolbar.querySelector('[data-action="redo"]') as HTMLButtonElement).disabled = !future.length;
  scheduleFit();
}

/** Selection changes only toggle classes: rebuilding elements between two clicks breaks dblclick. */
function renderSelection(): void {
  for (const [id, el] of els) {
    el.classList.toggle('selected', sel.has(id));
    el.classList.toggle('solo', sel.size === 1 && sel.has(id));
  }
  pinbar.querySelectorAll<HTMLElement>('.pin').forEach((p) => p.classList.toggle('selected', sel.has(p.dataset.id!)));
  edgePaths.querySelectorAll<SVGGElement>('.edge').forEach((g) => g.classList.toggle('selected', g.dataset.eid === selEdge));
  renderSelbar();
}

function renderMoving(ids: Iterable<string>): void {
  for (const id of ids) {
    const n = byId(id);
    const el = els.get(id);
    if (n && el) updateNodeEl(el, n);
  }
  renderEdges();
}

// Text cards with autoHeight are laid out by the browser; write their real height back
// (and move the cards below them) so the file and the agent see true geometry.
let fitQueued = false;
function scheduleFit(): void {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitHeights();
  });
}

function fitHeights(): void {
  if (drag || editing || !ready || document.hidden || !viewport.clientWidth) return;
  const changes: [CanvasNode, number][] = [];
  for (const n of board.nodes) {
    if (n.type !== 'text' || !n.autoHeight || n.pinned) continue;
    const h = els.get(n.id)?.offsetHeight;
    if (h && Math.abs(h - n.height) > 1) changes.push([n, h]);
  }
  if (!changes.length) return;
  const next = cloneCanvas(board);
  changes.sort((a, b) => a[0].y - b[0].y);
  for (const [n, h] of changes) applyHeightChange(next, n.id, h);
  commit(diffOps(board, next), { silent: true });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderEdges();
    scheduleFit();
  }
});

// ---------------- editing ----------------

function startEdit(id: string, opts: { isNew?: boolean } = {}): void {
  const n = byId(id);
  if (!n || n.type !== 'text') return;
  if (editing) finishEditing();
  const host = n.pinned ? (pinbar.querySelector(`.pin[data-id="${CSS.escape(id)}"]`) as HTMLElement | null) : els.get(id);
  if (!host) return;
  const box = host.querySelector('.md') as HTMLElement;
  const ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.value = n.text ?? '';
  ta.spellcheck = false;
  box.hidden = true;
  box.after(ta);
  host.classList.add('editing');
  if (!n.pinned && !n.autoHeight) host.style.minHeight = `${n.height}px`;
  if (!n.pinned) host.style.height = '';
  editing = { kind: 'node', id, isNew: opts.isNew, histLen: history.length, el: ta };
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    if (!n.pinned) renderEdges();
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) {
      ev.preventDefault();
      finishEditing();
    }
  });
  ta.addEventListener('blur', () => {
    if (editing?.el === ta) finishEditing();
  });
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function startLabelEdit(id: string, selectAll = false): void {
  const n = byId(id);
  const host = els.get(id);
  if (!n || n.type !== 'group' || !host) return;
  if (editing) finishEditing();
  const input = document.createElement('input');
  input.className = 'label-editor';
  input.value = n.label ?? '';
  input.spellcheck = false;
  host.appendChild(input);
  host.classList.add('editing-label');
  editing = { kind: 'label', id, el: input };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      finishEditing();
    }
  });
  input.addEventListener('blur', () => {
    if (editing?.el === input) finishEditing();
  });
  input.focus();
  if (selectAll) input.select();
}

function startEdgeEdit(id: string): void {
  const e = board.edges.find((x) => x.id === id);
  if (!e) return;
  const label = edgePaths.querySelector(`[data-eid="${CSS.escape(id)}"] .eline`) as SVGPathElement | null;
  if (!label) return;
  if (editing) finishEditing();
  // Path coordinates are world coordinates (the SVG offset is undone by .edge-shift).
  const p = label.getPointAtLength(label.getTotalLength() / 2);
  const wrap = document.createElement('div');
  wrap.className = 'edge-editor';
  wrap.style.left = `${p.x}px`;
  wrap.style.top = `${p.y}px`;
  const input = document.createElement('input');
  input.value = e.label ?? '';
  input.spellcheck = false;
  wrap.appendChild(input);
  cardsLayer.appendChild(wrap);
  editing = { kind: 'edge', id, el: input, wrap };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      finishEditing();
    }
  });
  input.addEventListener('blur', () => {
    if (editing?.el === input) finishEditing();
  });
  input.focus();
  input.select();
}

function finishEditing(): void {
  const ed = editing;
  if (!ed) return;
  editing = null;
  const value = ed.el.value;
  if (ed.kind === 'node') {
    const host = ed.el.parentElement;
    ed.el.remove();
    if (host) {
      host.classList.remove('editing');
      host.style.minHeight = '';
      (host.querySelector('.md') as HTMLElement).hidden = false;
    }
    const n = byId(ed.id);
    if (!n) return render();
    if (ed.isNew && !value.trim()) {
      commit([{ op: 'deleteNodes', ids: [ed.id] }], { silent: true });
      if (history.length === ed.histLen) history.pop();
      sel.delete(ed.id);
      return render();
    }
    lastMd.delete(n.id);
    lastMd.delete(`pin:${n.id}`);
    if (value !== (n.text ?? '')) commit([{ op: 'upsertNodes', nodes: [{ id: n.id, text: value }] }], { silent: ed.isNew });
    else render();
  } else if (ed.kind === 'label') {
    const host = ed.el.parentElement;
    ed.el.remove();
    host?.classList.remove('editing-label');
    const n = byId(ed.id);
    if (n && value.trim() !== (n.label ?? '')) commit([{ op: 'upsertNodes', nodes: [{ id: n.id, label: value.trim() }] }]);
    else render();
  } else {
    ed.wrap?.remove();
    const e = board.edges.find((x) => x.id === ed.id);
    const v = value.trim();
    if (e && v !== (e.label ?? '')) commit([{ op: 'upsertEdges', edges: [{ id: e.id, label: v || null }] }]);
    else render();
  }
}

// ---------------- actions ----------------

function takenIds(): Set<string> {
  return new Set(board.nodes.map((n) => n.id));
}

function createCard(wx: number, wy: number): void {
  const id = newId(takenIds());
  const node: CanvasNode = { id, type: 'text', text: '', x: Math.round(wx - CARD_W / 2), y: Math.round(wy - 22), width: CARD_W, height: 44, autoHeight: true };
  commit([{ op: 'upsertNodes', nodes: [node] }]);
  sel = new Set([id]);
  selEdge = null;
  render();
  startEdit(id, { isNew: true });
}

function freeSpotNear(wx: number, wy: number, w: number, h: number): [number, number] {
  let x = Math.round(wx - w / 2);
  let y = Math.round(wy - h / 2);
  for (let i = 0; i < 30; i++) {
    const box = { x, y, width: w, height: h };
    if (!board.nodes.some((n) => !n.pinned && n.type !== 'group' && intersectsRect(nodeRect(n.id)!, box))) break;
    x += 24;
    y += 24;
  }
  return [x, y];
}

function createCardAtCenter(): void {
  const r = viewport.getBoundingClientRect();
  const [wx, wy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const [x, y] = freeSpotNear(wx, wy, CARD_W, 44);
  createCard(x + CARD_W / 2, y + 22);
}

function createGroupAtCenter(): void {
  const r = viewport.getBoundingClientRect();
  const [wx, wy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const id = newId(takenIds());
  const [x, y] = freeSpotNear(wx, wy, GROUP_W, 200);
  commit([{ op: 'upsertNodes', nodes: [{ id, type: 'group', label: t.groupDefault, x, y, width: GROUP_W, height: 200 }] }]);
  sel = new Set([id]);
  render();
  startLabelEdit(id, true);
}

function withDescendants(ids: Iterable<string>): Set<string> {
  const pm = parentMap(board);
  const out = new Set<string>();
  for (const id of ids) {
    const n = byId(id);
    if (!n) continue;
    out.add(id);
    if (n.type === 'group' && !n.pinned) descendants(board, pm, id).forEach((d) => out.add(d));
  }
  return out;
}

function deleteSelection(): void {
  if (selEdge) {
    const id = selEdge;
    selEdge = null;
    commit([{ op: 'deleteEdges', ids: [id] }]);
    return;
  }
  if (!sel.size) return;
  const ids = withDescendants(sel);
  sel.clear();
  commit([{ op: 'deleteNodes', ids: [...ids] }]);
}

function duplicate(): void {
  if (!sel.size) return;
  const ids = withDescendants(sel);
  const taken = takenIds();
  const map = new Map<string, string>();
  const nodes: CanvasNode[] = [];
  for (const id of ids) {
    const n = byId(id)!;
    const copy: CanvasNode = { ...n, id: newId(taken), x: n.x + 24, y: n.y + 24 };
    delete copy.pinned;
    map.set(id, copy.id);
    nodes.push(copy);
  }
  const edgeTaken = new Set(board.edges.map((e) => e.id));
  const edges = board.edges
    .filter((e) => map.has(e.fromNode) && map.has(e.toNode))
    .map((e) => ({ ...e, id: newId(edgeTaken), fromNode: map.get(e.fromNode)!, toNode: map.get(e.toNode)! }));
  const ops: Op[] = [{ op: 'upsertNodes', nodes }];
  if (edges.length) ops.push({ op: 'upsertEdges', edges });
  sel = new Set([...sel].map((id) => map.get(id)!).filter(Boolean));
  commit(ops);
}

function nudge(dx: number, dy: number): void {
  const ids = withDescendants([...sel].filter((id) => !byId(id)?.pinned));
  if (!ids.size) return;
  commit([{ op: 'upsertNodes', nodes: [...ids].map((id) => ({ id, x: byId(id)!.x + dx, y: byId(id)!.y + dy })) }]);
}

function togglePin(id: string): void {
  const n = byId(id);
  if (!n) return;
  if (!n.pinned) {
    commit([{ op: 'upsertNodes', nodes: [{ id, pinned: true }] }]);
    return;
  }
  // Unpinned cards land where the user is looking.
  const vis = visibleWorld();
  const h = n.type === 'text' && n.autoHeight ? 60 : n.height;
  const [x, y] = freeSpotNear(vis.x + vis.width / 2, vis.y + vis.height / 2, n.width, h);
  commit([{ op: 'upsertNodes', nodes: [{ id, pinned: null, x, y }] }]);
}

function setColorOfSelection(c: string): void {
  const color = c || null;
  if (selEdge) commit([{ op: 'upsertEdges', edges: [{ id: selEdge, color }] }]);
  else if (sel.size) commit([{ op: 'upsertNodes', nodes: [...sel].map((id) => ({ id, color })) }]);
}

function openNode(n: CanvasNode): void {
  const target = n.type === 'file' ? n.file : n.type === 'link' ? n.url : undefined;
  if (target) post({ type: 'open', target });
}

// ---------------- pointer input ----------------

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && !(el as HTMLInputElement).classList.contains('task');
}

const UI = '.toolbar, .selbar';

viewport.addEventListener('pointerdown', (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest(`${UI}, .editor, .label-editor, .edge-editor`)) return;
  if (editing) finishEditing();
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  if (tgt.closest('input.task, a, code.path')) return;
  const conn = tgt.closest('.conn') as HTMLElement | null;
  if (conn) {
    const id = (conn.closest('.node') as HTMLElement).dataset.id!;
    drag = { kind: 'connect', from: id, side: conn.dataset.side as Side, sx: e.clientX, sy: e.clientY };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('connecting');
    return;
  }
  const handle = tgt.closest('.handle');
  if (handle) {
    const id = (handle.closest('.node') as HTMLElement).dataset.id!;
    const n = byId(id)!;
    drag = {
      kind: 'resize',
      id,
      sx: e.clientX,
      sy: e.clientY,
      w: n.width,
      h: els.get(id)?.offsetHeight ?? n.height,
      autoText: n.type === 'text' && !!n.autoHeight,
      autoOff: false,
    };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('dragging');
    return;
  }
  const edgeEl = tgt.closest('.edge') as SVGGElement | null;
  if (edgeEl) {
    sel.clear();
    selEdge = edgeEl.dataset.eid ?? null;
    renderSelection();
    return;
  }
  const nodeEl = tgt.closest('.node') as HTMLElement | null;
  if (nodeEl) {
    const id = nodeEl.dataset.id!;
    if (e.shiftKey) {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
    } else if (!sel.has(id)) sel = new Set([id]);
    selEdge = null;
    const ids = withDescendants(sel);
    drag = {
      kind: 'move',
      sx: e.clientX,
      sy: e.clientY,
      ids: [...ids],
      start: new Map([...ids].map((i) => [i, { x: byId(i)!.x, y: byId(i)!.y }])),
      moved: false,
      clickId: id,
      shift: e.shiftKey,
      dropY: 0,
    };
    viewport.setPointerCapture(e.pointerId);
    renderSelection();
    return;
  }
  if (e.shiftKey) {
    drag = { kind: 'band', sx: e.clientX, sy: e.clientY, base: new Set(sel) };
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  if (sel.size || selEdge) {
    sel.clear();
    selEdge = null;
    renderSelection();
  }
  startPan(e);
});

function startPan(e: PointerEvent): void {
  cancelAnimationFrame(anim);
  drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');
}

viewport.addEventListener('pointermove', (e) => {
  const d = drag;
  if (!d) return;
  if (d.kind === 'pan') {
    view.x = d.vx + (e.clientX - d.sx);
    view.y = d.vy + (e.clientY - d.sy);
    applyView();
  } else if (d.kind === 'move') {
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    d.moved = true;
    viewport.classList.add('dragging');
    const dx = (e.clientX - d.sx) / view.z;
    const dy = (e.clientY - d.sy) / view.z;
    for (const id of d.ids) {
      const s = d.start.get(id)!;
      preview.set(id, { x: Math.round(s.x + dx), y: Math.round(s.y + dy) });
    }
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const drop = dropGroupAt(wx, wy, new Set(d.ids));
    if (drop !== d.drop) {
      if (d.drop) els.get(d.drop)?.classList.remove('drop');
      if (drop) els.get(drop)?.classList.add('drop');
      d.drop = drop;
    }
    d.dropY = wy;
    renderMoving(d.ids);
  } else if (d.kind === 'resize') {
    const n = byId(d.id);
    if (!n) return;
    const dw = (e.clientX - d.sx) / view.z;
    const dh = (e.clientY - d.sy) / view.z;
    if (d.autoText && !d.autoOff && Math.abs(dh) > 8) d.autoOff = true;
    const p: Partial<Rect> = { width: Math.max(MIN_W, Math.round(d.w + dw)) };
    if (!d.autoText || d.autoOff) p.height = Math.max(MIN_H, Math.round(d.h + dh));
    preview.set(d.id, p);
    renderMoving([d.id]);
  } else if (d.kind === 'band') {
    const r = viewport.getBoundingClientRect();
    const x1 = Math.min(d.sx, e.clientX);
    const y1 = Math.min(d.sy, e.clientY);
    const x2 = Math.max(d.sx, e.clientX);
    const y2 = Math.max(d.sy, e.clientY);
    band.hidden = false;
    Object.assign(band.style, { left: `${x1 - r.left}px`, top: `${y1 - r.top}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    const [wx1, wy1] = toWorld(x1, y1);
    const [wx2, wy2] = toWorld(x2, y2);
    const box = { x: wx1, y: wy1, width: wx2 - wx1, height: wy2 - wy1 };
    sel = new Set(d.base);
    for (const n of board.nodes) {
      if (n.pinned) continue;
      const nr = nodeRect(n.id)!;
      const hit =
        n.type === 'group'
          ? nr.x >= box.x && nr.y >= box.y && nr.x + nr.width <= box.x + box.width && nr.y + nr.height <= box.y + box.height
          : intersectsRect(nr, box);
      if (hit) sel.add(n.id);
    }
    for (const [id, el] of els) el.classList.toggle('selected', sel.has(id));
  } else if (d.kind === 'connect') {
    const a = nodeRect(d.from);
    if (!a) return;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const p1 = sidePoint(a, d.side);
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node') as HTMLElement | null;
    const target = under && under.dataset.id !== d.from ? under : undefined;
    if (d.target !== target) {
      d.target?.classList.remove('target');
      target?.classList.add('target');
      d.target = target;
    }
    const n1 = NORMALS[d.side];
    const k = clamp(Math.hypot(wx - p1[0], wy - p1[1]) * 0.45, 20, 140);
    edgeTemp.setAttribute('d', `M${f(p1[0])},${f(p1[1])} C${f(p1[0] + n1[0] * k)},${f(p1[1] + n1[1] * k)} ${f(wx)},${f(wy)} ${f(wx)},${f(wy)}`);
  }
});

function endDrag(e: PointerEvent): void {
  const d = drag;
  if (!d) return;
  drag = null;
  viewport.classList.remove('panning', 'dragging', 'connecting');
  if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
  if (d.kind === 'move') {
    if (d.drop) els.get(d.drop)?.classList.remove('drop');
    if (d.moved) {
      const next = settleMove(d.ids, d.drop, d.dropY);
      preview.clear();
      commit(diffOps(board, next));
    } else {
      preview.clear();
      if (!d.shift && sel.size > 1) {
        sel = new Set([d.clickId]);
        renderSelection();
      }
    }
  } else if (d.kind === 'resize') {
    const p = preview.get(d.id);
    preview.clear();
    const n = byId(d.id);
    if (!p || !n) return render();
    const patch: Record<string, unknown> = { id: d.id, width: p.width };
    if (p.height !== undefined) {
      patch.height = p.height;
      if (n.autoHeight) patch.autoHeight = null;
    }
    commit([{ op: 'upsertNodes', nodes: [patch as { id: string }] }]);
  } else if (d.kind === 'band') {
    band.hidden = true;
    renderSelection();
  } else if (d.kind === 'connect') {
    edgeTemp.setAttribute('d', '');
    d.target?.classList.remove('target');
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const edgeTaken = new Set(board.edges.map((x) => x.id));
    if (d.target) {
      const to = d.target.dataset.id!;
      const r = nodeRect(to);
      const toSide = r ? nearestSide(r, wx, wy) : undefined;
      commit([{ op: 'upsertEdges', edges: [{ id: newId(edgeTaken), fromNode: d.from, fromSide: d.side, toNode: to, toSide }] }]);
    } else if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 24) {
      const id = newId(takenIds());
      const w = CARD_W;
      const pos: Record<Side, Pt> = {
        right: [wx, wy - 22],
        left: [wx - w, wy - 22],
        bottom: [wx - w / 2, wy],
        top: [wx - w / 2, wy - 44],
      };
      const [x, y] = pos[d.side];
      commit([
        { op: 'upsertNodes', nodes: [{ id, type: 'text', text: '', x: Math.round(x), y: Math.round(y), width: w, height: 44, autoHeight: true }] },
        { op: 'upsertEdges', edges: [{ id: newId(edgeTaken), fromNode: d.from, fromSide: d.side, toNode: id, toSide: OPPOSITE[d.side] }] },
      ]);
      sel = new Set([id]);
      render();
      startEdit(id, { isNew: true });
    } else {
      render();
    }
  }
}

/** The group under the pointer that a dragged card would drop into. */
function dropGroupAt(wx: number, wy: number, moving: Set<string>): string | undefined {
  let best: CanvasNode | undefined;
  for (const n of board.nodes) {
    if (n.type !== 'group' || n.pinned || moving.has(n.id)) continue;
    if (wx < n.x || wx > n.x + n.width || wy < n.y || wy > n.y + n.height) continue;
    if (!best || n.width * n.height < best.width * best.height) best = n;
  }
  return best?.id;
}

/**
 * Board after a drag. Cards dropped on an agent-made column group slot into the column at
 * the pointer (kanban-style). Otherwise cards land where they were dropped; cards that left
 * an auto-sized group close its stack, and groups that received a card grow to hold it.
 */
function settleMove(ids: string[], drop: string | undefined, dropY: number): Canvas {
  const next = cloneCanvas(board);
  const moved = new Set(ids);
  const before = parentMap(next);
  const roots = ids.filter((id) => !moved.has(before.get(id) ?? ''));
  const find = (id: string) => next.nodes.find((n) => n.id === id);
  const leaveStacks = (list: string[]) => {
    for (const id of [...list].sort((a, b) => find(b)!.y - find(a)!.y)) {
      const g = find(before.get(id) ?? '');
      if (g?.autoHeight && !moved.has(g.id)) closeGap(next, id);
    }
  };
  const target = drop ? find(drop) : undefined;
  if (target?.autoHeight && roots.every((id) => find(id)!.type !== 'group') && isColumnGroup(next, target.id, moved)) {
    leaveStacks(roots);
    const cards = roots
      .map((id) => find(id)!)
      .sort((a, b) => (preview.get(a.id)?.y ?? a.y) - (preview.get(b.id)?.y ?? b.y));
    next.nodes = next.nodes.filter((n) => !moved.has(n.id));
    insertIntoColumn(next, target.id, cards, dropY);
    return next;
  }
  const placed = cloneCanvas(next);
  for (const n of placed.nodes) {
    const p = preview.get(n.id);
    if (p) Object.assign(n, { x: p.x, y: p.y });
  }
  const after = parentMap(placed);
  leaveStacks(roots.filter((id) => before.get(id) !== after.get(id)));
  for (const n of next.nodes) {
    const p = preview.get(n.id);
    if (p) Object.assign(n, { x: p.x, y: p.y });
  }
  const final = parentMap(next);
  for (const id of roots) {
    const g = final.get(id);
    if (g && g !== before.get(id)) fitGroup(next, g);
  }
  return next;
}

viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

viewport.addEventListener('dblclick', (e) => {
  // Pointer capture retargets click/dblclick to the viewport, so ask what is under the pointer.
  const tgt = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement;
  if (tgt.closest(`${UI}, .editor, .label-editor, .edge-editor, input.task, a, code.path, .conn, .handle`)) return;
  const edgeEl = tgt.closest('.edge') as SVGGElement | null;
  if (edgeEl?.dataset.eid) {
    startEdgeEdit(edgeEl.dataset.eid);
    return;
  }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const nodeEl = tgt.closest('.node') as HTMLElement | null;
  if (nodeEl) {
    const n = byId(nodeEl.dataset.id!);
    if (!n) return;
    if (n.type === 'text') startEdit(n.id);
    else if (n.type === 'group') {
      if (tgt.closest('.glabel') || wy - n.y < HEADER) startLabelEdit(n.id);
      else createCard(wx, wy);
    } else openNode(n);
    return;
  }
  createCard(wx, wy);
});

viewport.addEventListener(
  'wheel',
  (e) => {
    if ((e.target as HTMLElement).closest('.editor')) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.0025));
      return;
    }
    cancelAnimationFrame(anim);
    if (e.shiftKey && !e.deltaX) view.x -= e.deltaY * k;
    else {
      view.x -= e.deltaX * k;
      view.y -= e.deltaY * k;
    }
    applyView();
  },
  { passive: false },
);

// Clicks on checkboxes, links and file paths (cards and the pinned bar).
app.addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const cb = tgt.closest('input.task') as HTMLInputElement | null;
  if (cb) {
    e.preventDefault();
    const host = cb.closest('[data-id]') as HTMLElement | null;
    const n = host && byId(host.dataset.id!);
    if (n?.type === 'text') commit([{ op: 'upsertNodes', nodes: [{ id: n.id, text: toggleTask(n.text ?? '', Number(cb.dataset.task)) }] }]);
    return;
  }
  const link = tgt.closest('a') as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    if (link.classList.contains('ref-name')) {
      const n = byId((link.closest('.node') as HTMLElement).dataset.id!);
      if (n) openNode(n);
    } else {
      const href = link.getAttribute('href');
      if (href) post({ type: 'open', target: href });
    }
    return;
  }
  const code = tgt.closest('code.path') as HTMLElement | null;
  if (code?.dataset.open) post({ type: 'open', target: code.dataset.open });
});

toolbar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  switch (b.dataset.action) {
    case 'add-card':
      return createCardAtCenter();
    case 'add-group':
      return createGroupAtCenter();
    case 'zoom-in':
      return zoomCenter(1.25);
    case 'zoom-out':
      return zoomCenter(0.8);
    case 'zoom-reset':
      return zoomCenter(1 / view.z);
    case 'fit':
      return fitTo(contentRect(), { animate: true });
    case 'undo':
      return undo();
    case 'redo':
      return redo();
  }
});

selbar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.dataset.color !== undefined) return setColorOfSelection(b.dataset.color);
  if (b.dataset.action === 'pin' && sel.size === 1) return togglePin([...sel][0]);
  if (b.dataset.action === 'duplicate') return duplicate();
  if (b.dataset.action === 'delete') return deleteSelection();
});

pinbar.addEventListener('pointerdown', (e) => {
  const tgt = e.target as HTMLElement;
  const pin = tgt.closest('.pin') as HTMLElement | null;
  if (!pin || tgt.closest('.editor, input.task, a, code.path, .pin-off')) return;
  if (editing) finishEditing();
  sel = new Set([pin.dataset.id!]);
  selEdge = null;
  renderSelection();
});

pinbar.addEventListener('dblclick', (e) => {
  const tgt = e.target as HTMLElement;
  const pin = tgt.closest('.pin') as HTMLElement | null;
  if (!pin || tgt.closest('.editor, input.task, a, code.path, .pin-off')) return;
  startEdit(pin.dataset.id!);
});

pinbar.addEventListener('click', (e) => {
  const off = (e.target as HTMLElement).closest('.pin-off');
  if (!off) return;
  const pin = off.closest('.pin') as HTMLElement;
  togglePin(pin.dataset.id!);
});

// ---------------- keyboard ----------------

window.addEventListener('keydown', (e) => {
  const typing = isTyping(e.target);
  if (e.key === ' ' && !typing && !editing) {
    spaceDown = true;
    viewport.classList.add('space');
    e.preventDefault();
    return;
  }
  if (typing || editing) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && k === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && k === 'a') {
    e.preventDefault();
    sel = new Set(board.nodes.filter((n) => !n.pinned).map((n) => n.id));
    selEdge = null;
    renderSelection();
    return;
  }
  if (mod && k === 'd') {
    e.preventDefault();
    duplicate();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === 'Escape') {
    sel.clear();
    selEdge = null;
    renderSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selEdge) startEdgeEdit(selEdge);
    else if (sel.size === 1) {
      const n = byId([...sel][0]);
      if (n?.type === 'text') startEdit(n.id);
      else if (n?.type === 'group') startLabelEdit(n.id);
      else if (n) openNode(n);
    }
  } else if (e.shiftKey && e.code === 'Digit1') {
    fitTo(contentRect(), { animate: true });
  } else if (e.shiftKey && e.code === 'Digit0') {
    zoomCenter(1 / view.z);
  } else if (e.key === '+' || e.key === '=') {
    zoomCenter(1.25);
  } else if (e.key === '-' || e.key === '_') {
    zoomCenter(0.8);
  } else if (e.key.startsWith('Arrow') && sel.size) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const v: Record<string, Pt> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
    nudge(...v[e.key]);
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    viewport.classList.remove('space');
  }
});

window.addEventListener('blur', () => {
  spaceDown = false;
  viewport.classList.remove('space');
});

window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }));

applyStaticTexts();
applyView();
post({ type: 'ready' });
