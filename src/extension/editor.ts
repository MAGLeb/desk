import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Op } from '../shared/ops';
import { BoardStore } from './store';

type FromWebview =
  | { type: 'ready' }
  | { type: 'ops'; ops: Op[]; seq?: number }
  | { type: 'open'; target: string }
  | { type: 'error'; message: string };

export class BoardEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'desk.board';
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly stores = new Map<string, { store: BoardStore; refs: number }>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  isOpen(uri: vscode.Uri): boolean {
    return this.panels.has(uri.toString());
  }

  panelFor(uri: vscode.Uri): vscode.WebviewPanel | undefined {
    return this.panels.get(uri.toString());
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  private acquire(file: string): BoardStore {
    let entry = this.stores.get(file);
    if (!entry) {
      entry = { store: new BoardStore(file), refs: 0 };
      this.stores.set(file, entry);
    }
    entry.refs++;
    return entry.store;
  }

  private release(file: string): void {
    const entry = this.stores.get(file);
    if (!entry || --entry.refs > 0) return;
    entry.store.dispose();
    this.stores.delete(file);
  }

  resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const key = doc.uri.toString();
    const file = doc.uri.fsPath;
    this.panels.set(key, panel);
    const store = this.acquire(file);
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    panel.webview.html = this.html(panel.webview);

    const sub = store.onDidChange((ch) =>
      panel.webview.postMessage({ type: 'state', board: ch.board, source: ch.source, error: ch.error, ack: ch.ack }),
    );
    const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(path.dirname(file));
    panel.webview.onDidReceiveMessage((msg: FromWebview) => {
      switch (msg.type) {
        case 'ready':
          store.readDisk(false);
          panel.webview.postMessage({
            type: 'init',
            board: store.board,
            error: store.error,
            lang: language(),
            file: vscode.workspace.asRelativePath(doc.uri),
          });
          break;
        case 'ops':
          try {
            store.apply(msg.ops, msg.seq);
          } catch (e) {
            vscode.window.showErrorMessage(`Desk: could not save the board: ${(e as Error).message}`);
          }
          break;
        case 'open':
          openTarget(msg.target, root, panel).catch((e) => vscode.window.showWarningMessage(`Desk: ${(e as Error).message}`));
          break;
        case 'error':
          console.error('[desk webview]', msg.message);
          break;
      }
    });
    panel.onDidDispose(() => {
      sub.dispose();
      this.panels.delete(key);
      this.release(file);
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'board.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Desk</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function language(): string {
  const setting = vscode.workspace.getConfiguration('desk').get<string>('language', 'auto');
  if (setting === 'ru' || setting === 'en') return setting;
  return vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

async function openTarget(target: string, root: string, panel: vscode.WebviewPanel): Promise<void> {
  if (/^(https?|mailto):/i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  let p = target.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  let line: number | undefined;
  const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/.exec(p);
  if (m) {
    p = m[1];
    line = Number(m[2] ?? m[3]);
  }
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(abs)) throw new Error(`not found: ${p}`);
  const uri = vscode.Uri.file(abs);
  if (fs.statSync(abs).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  if (abs.endsWith('.canvas')) {
    await vscode.commands.executeCommand('vscode.openWith', uri, BoardEditorProvider.viewType);
    return;
  }
  const column = panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  const editor = await vscode.window.showTextDocument(uri, { viewColumn: column, preview: true });
  if (line && line > 0) {
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}
