import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Canvas, parseCanvas } from '../src/shared/canvas';
import { intersects, parentMap } from '../src/shared/layout';

// Bundled to dist/test/, so the server sits one level up.
const SERVER = path.resolve(__dirname, '..', 'mcp-server.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
fs.mkdirSync(path.join(root, '.git'));
const cwd = path.join(root, 'packages', 'web');
fs.mkdirSync(cwd, { recursive: true });
const boardFile = path.join(root, '.desk', 'board.canvas');

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, isError: !!r.isError };
}
const read = (): Canvas => parseCanvas(fs.readFileSync(boardFile, 'utf8'));
const node = (c: Canvas, id: string) => {
  const n = c.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} exists`);
  return n;
};

function assertNoOverlaps(c: Canvas): void {
  const pm = parentMap(c);
  const vis = c.nodes.filter((n) => !n.pinned);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i];
      const b = vis[j];
      if (pm.get(a.id) !== pm.get(b.id)) continue;
      assert.ok(!intersects(a, b), `overlap: ${a.id} [${a.x},${a.y},${a.width},${a.height}] vs ${b.id} [${b.x},${b.y},${b.width},${b.height}]`);
    }
  }
}

function assertInside(c: Canvas, childId: string, groupId: string): void {
  assert.equal(parentMap(c).get(childId), groupId, `${childId} belongs to ${groupId}`);
  const ch = node(c, childId);
  const g = node(c, groupId);
  assert.ok(
    ch.x >= g.x && ch.y >= g.y && ch.x + ch.width <= g.x + g.width && ch.y + ch.height <= g.y + g.height,
    `${childId} fits inside ${groupId}`,
  );
}

test('connects and lists the tools', async () => {
  client = new Client({ name: 'desk-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd, stderr: 'inherit' }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['board_add', 'board_delete', 'board_focus', 'board_read', 'board_update']);
  assert.match(client.getInstructions() ?? '', /whiteboard/);
});

test('reads an empty board without creating a file', async () => {
  const r = await call('board_read');
  assert.match(r.text, /is empty/);
  assert.ok(!fs.existsSync(boardFile));
});

test('focus lands in the git root, not in the cwd', async () => {
  await call('board_focus', { text: '**Цель:** запустить доску', color: 'yellow' });
  const f = node(read(), 'focus');
  assert.equal(f.pinned, true);
  assert.equal(f.color, '3');
  assert.ok(!fs.existsSync(path.join(cwd, '.desk')));
});

test('three groups go side by side with stacked cards', async () => {
  const r = await call('board_add', {
    items: [
      {
        id: 'now',
        label: 'Сейчас',
        color: 'yellow',
        children: [
          { id: 't1', text: '- [ ] MCP сервер' },
          { id: 't2', text: '- [ ] Webview: перетаскивание, правка текста, стрелки и длинное описание, чтобы карточка заняла несколько строк' },
        ],
      },
      { id: 'next', label: 'Дальше', children: [{ id: 't3', text: '- [ ] Упаковать VSIX' }] },
      { id: 'done', label: 'Готово', color: 'green', children: [] },
    ],
  });
  assert.ok(!r.isError, r.text);
  const c = read();
  assertInside(c, 't1', 'now');
  assertInside(c, 't2', 'now');
  assertInside(c, 't3', 'next');
  const [a, b, d] = ['now', 'next', 'done'].map((id) => node(c, id));
  assert.equal(a.y, b.y);
  assert.ok(b.x > a.x + a.width && d.x > b.x + b.width, 'groups in a row');
  assert.ok(node(c, 't2').y >= node(c, 't1').y + node(c, 't1').height, 't2 below t1');
  assertNoOverlaps(c);
});

test('a flow diagram goes below a group, left to right, without overlaps', async () => {
  const r = await call('board_add', {
    items: [
      { id: 'cc', text: '**Claude Code**' },
      { id: 'mcp', text: '**MCP desk**' },
      { id: 'file', text: '`.desk/board.canvas`' },
      { id: 'tab', text: '**Вкладка VS Code**' },
    ],
    arrows: [
      { from: 'cc', to: 'mcp', label: 'stdio' },
      { from: 'mcp', to: 'file', label: 'пишет' },
      { from: 'file', to: 'tab', label: 'следит' },
    ],
    layout: 'flow-right',
    position: { below: 'now' },
  });
  assert.ok(!r.isError, r.text);
  const c = read();
  assert.equal(c.edges.length, 3);
  const xs = ['cc', 'mcp', 'file', 'tab'].map((id) => node(c, id).x);
  assert.deepEqual([...xs].sort((p, q) => p - q), xs, 'left to right');
  const top = Math.min(...['cc', 'mcp', 'file', 'tab'].map((id) => node(c, id).y));
  assert.ok(top > node(c, 'now').y + node(c, 'now').height, 'below the group');
  assertNoOverlaps(c);
});

test('appending to a group grows it and pushes the diagram below as a whole', async () => {
  const c0 = read();
  const h0 = node(c0, 'next').height;
  const ys0 = ['cc', 'mcp', 'file', 'tab'].map((id) => node(c0, id).y);
  const r = await call('board_add', {
    items: [{ id: 't4', text: '- [ ] Иконка\n- [ ] README\n- [ ] Проверить в тёмной теме\n- [ ] Ещё строка\n- [ ] И ещё одна', parent: 'next' }],
  });
  assert.ok(!r.isError, r.text);
  const c = read();
  assertInside(c, 't4', 'next');
  assertInside(c, 't3', 'next');
  assert.ok(node(c, 'next').height > h0);
  const ys = ['cc', 'mcp', 'file', 'tab'].map((id) => node(c, id).y);
  const shifts = ys.map((y, i) => y - ys0[i]);
  assert.ok(shifts.every((s) => s === shifts[0]), `diagram moved as one: ${shifts}`);
  assertNoOverlaps(c);
});

test('longer text re-fits the card and moves the stack below it', async () => {
  const c0 = read();
  const y2 = node(c0, 't2').y;
  const h1 = node(c0, 't1').height;
  await call('board_update', { items: [{ id: 't1', text: '- [ ] MCP сервер\n- [ ] пять инструментов\n- [ ] авто-раскладка\n- [ ] инструкции для агента' }] });
  const c = read();
  const dh = node(c, 't1').height - h1;
  assert.ok(dh > 40, `grew by ${dh}`);
  assert.equal(node(c, 't2').y, y2 + dh);
  assertInside(c, 't2', 'now');
  assertNoOverlaps(c);
});

test('a card moves between groups', async () => {
  await call('board_update', { items: [{ id: 't3', parent: 'done', color: 'green' }] });
  const c = read();
  assertInside(c, 't3', 'done');
  assertInside(c, 't4', 'next');
  assert.equal(node(c, 't3').color, '4');
  assertNoOverlaps(c);
});

test('deleting a card closes the gap in its group', async () => {
  const t1 = node(read(), 't1');
  await call('board_delete', { ids: ['t1'] });
  const c = read();
  assert.equal(node(c, 't2').y, t1.y);
  assertInside(c, 't2', 'now');
});

test('deleting a group removes its cards and arrows', async () => {
  await call('board_add', { items: [{ id: 'tmp', text: 'x', parent: 'done' }], arrows: [{ from: 'done', to: 'cc' }] });
  assert.equal(read().edges.length, 4);
  const r = await call('board_delete', { ids: ['done'] });
  assert.ok(!r.isError, r.text);
  const c = read();
  assert.ok(!c.nodes.some((n) => ['done', 't3', 'tmp'].includes(n.id)));
  assert.equal(c.edges.length, 3);
});

test('board_read returns JSON with nested groups', async () => {
  const r = await call('board_read');
  const json = JSON.parse(r.text.slice(r.text.indexOf('\n') + 1));
  assert.equal(json.pinned[0].id, 'focus');
  const now = json.items.find((i: { id: string }) => i.id === 'now');
  assert.deepEqual(now.children.map((c: { id: string }) => c.id), ['t2']);
  assert.equal(json.arrows.length, 3);
});

test('an existing id in board_add updates the card in place', async () => {
  const x = node(read(), 'cc').x;
  await call('board_add', { items: [{ id: 'cc', text: '**Claude Code** (агент)' }] });
  const c = read();
  assert.equal(node(c, 'cc').text, '**Claude Code** (агент)');
  assert.equal(node(c, 'cc').x, x);
  assert.equal(c.nodes.filter((n) => n.id === 'cc').length, 1);
});

test('a broken file is reported and left untouched', async () => {
  const good = fs.readFileSync(boardFile, 'utf8');
  fs.writeFileSync(boardFile, '{"nodes": [');
  const r = await call('board_add', { items: [{ text: 'x' }] });
  assert.ok(r.isError);
  assert.match(r.text, /invalid JSON/);
  assert.equal(fs.readFileSync(boardFile, 'utf8'), '{"nodes": [');
  fs.writeFileSync(boardFile, good);
});

test('focus can be cleared', async () => {
  await call('board_focus', { text: '' });
  assert.ok(!read().nodes.some((n) => n.id === 'focus'));
});

after(async () => {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});
