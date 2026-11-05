// Stand-in for the VS Code host, so the webview can be exercised in a plain browser.
import { Canvas, parseCanvas } from '../src/shared/canvas';
import { Op, applyOps } from '../src/shared/ops';

const params = new URLSearchParams(location.search);
document.body.classList.add(params.get('theme') === 'dark' ? 'vscode-dark' : 'vscode-light');

let board: Canvas = { nodes: [], edges: [] };
const posted: unknown[] = [];
const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

(window as any).acquireVsCodeApi = () => ({
  postMessage(m: { type: string; ops?: Op[]; seq?: number }) {
    posted.push(m);
    if (m.type === 'ready') {
      fetch(params.get('board') ?? 'sample.canvas')
        .then((r) => (r.ok ? r.text() : ''))
        .then((text) => {
          board = parseCanvas(text);
          send({ type: 'init', board, lang: params.get('lang') ?? 'en', file: '.desk/board.canvas' });
        });
    } else if (m.type === 'ops') {
      board = applyOps(board, m.ops!);
      setTimeout(() => send({ type: 'state', board, source: 'local', ack: m.seq }), 5);
    }
  },
  getState: () => null,
  setState: () => {},
});

(window as any).__desk = {
  posted,
  get board() {
    return board;
  },
  external(next: Canvas) {
    board = next;
    send({ type: 'state', board, source: 'external' });
  },
};
