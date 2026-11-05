import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BOARD_DIR, BOARD_FILE, emptyCanvas, serializeCanvas } from '../shared/canvas';
import { BoardEditorProvider } from './editor';

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new BoardEditorProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(BoardEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('desk.open', () => openBoard(provider)),
    vscode.commands.registerCommand('desk.connectClaude', () => connectClaude(ctx)),
  );

  const ru = vscode.env.language.toLowerCase().startsWith('ru') || vscode.workspace.getConfiguration('desk').get('language') === 'ru';
  const item = vscode.window.createStatusBarItem('desk.open', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Desk';
  item.text = `$(layout) ${ru ? 'Доска' : 'Board'}`;
  item.tooltip = ru ? 'Открыть доску проекта' : 'Open the project board';
  item.command = 'desk.open';
  if (vscode.workspace.workspaceFolders?.length) item.show();
  ctx.subscriptions.push(item);

  // When the agent writes the board and it is not open anywhere, show it next to the chat.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${BOARD_DIR}/${BOARD_FILE}`);
  const pending = new Set<string>();
  const onTouch = (uri: vscode.Uri) => {
    if (!vscode.workspace.getConfiguration('desk').get<boolean>('autoOpen', true)) return;
    const key = uri.toString();
    if (provider.isOpen(uri) || pending.has(key)) return;
    pending.add(key);
    setTimeout(() => {
      reveal(provider, uri, true)
        .catch((e) => console.error('[desk] auto-open failed', e))
        .finally(() => pending.delete(key));
    }, 150);
  };
  ctx.subscriptions.push(watcher, watcher.onDidChange(onTouch), watcher.onDidCreate(onTouch));

  try {
    syncServer(ctx);
  } catch (e) {
    console.error('[desk] could not copy the MCP server', e);
  }
}

export function deactivate(): void {}

/** Column right of the Claude Code chat tab, if there is one; otherwise next to the active editor. */
function pickColumn(): vscode.ViewColumn {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputWebview && (/claude/i.test(input.viewType) || /claude/i.test(tab.label))) {
        return (group.viewColumn + 1) as vscode.ViewColumn;
      }
    }
  }
  return vscode.ViewColumn.Beside;
}

async function reveal(provider: BoardEditorProvider, uri: vscode.Uri, preserveFocus: boolean): Promise<void> {
  const panel = provider.panelFor(uri);
  if (panel) {
    panel.reveal(panel.viewColumn, preserveFocus);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, BoardEditorProvider.viewType, {
    viewColumn: pickColumn(),
    preserveFocus,
    preview: false,
  });
}

/** Same rule as the MCP server: nearest existing board up the tree, else the git root. */
function boardForFile(file: string, stopAt: string): string {
  const up = (test: (dir: string) => boolean): string | undefined => {
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      if (test(dir)) return dir;
      if (dir === stopAt || path.dirname(dir) === dir || !dir.startsWith(stopAt)) return undefined;
    }
  };
  const root =
    up((d) => fs.existsSync(path.join(d, BOARD_DIR, BOARD_FILE))) ?? up((d) => fs.existsSync(path.join(d, '.git'))) ?? stopAt;
  return path.join(root, BOARD_DIR, BOARD_FILE);
}

async function openBoard(provider: BoardEditorProvider): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showWarningMessage('Desk: open a folder first. The board is stored in <folder>/.desk/board.canvas.');
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = active?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  let file: string | undefined;
  if (active && activeFolder) {
    file = boardForFile(active.fsPath, activeFolder.uri.fsPath);
  } else {
    const found = await vscode.workspace.findFiles(`**/${BOARD_DIR}/${BOARD_FILE}`, '**/node_modules/**', 50);
    if (found.length === 1) file = found[0].fsPath;
    else if (found.length > 1) {
      const pick = await vscode.window.showQuickPick(
        found.map((u) => ({ label: vscode.workspace.asRelativePath(u), file: u.fsPath })),
        { placeHolder: 'Desk: which board?' },
      );
      if (!pick) return;
      file = pick.file;
    } else {
      file = path.join(folders[0].uri.fsPath, BOARD_DIR, BOARD_FILE);
    }
  }
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeCanvas(emptyCanvas()));
  }
  await reveal(provider, vscode.Uri.file(file), false);
}

/** Keep a copy of the bundled MCP server at a path that survives extension updates. */
function syncServer(ctx: vscode.ExtensionContext): string {
  const src = path.join(ctx.extensionPath, 'dist', 'mcp-server.js');
  const dir = ctx.globalStorageUri.fsPath;
  const dst = path.join(dir, 'mcp-server.js');
  const data = fs.readFileSync(src);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(data)) fs.writeFileSync(dst, data);
  return dst;
}

async function connectClaude(ctx: vscode.ExtensionContext): Promise<void> {
  let server: string;
  try {
    server = syncServer(ctx);
  } catch (e) {
    vscode.window.showErrorMessage(`Desk: ${(e as Error).message}`);
    return;
  }
  const cmd = `claude mcp add --scope user desk -- node "${server}"`;
  const run = 'Run in terminal';
  const copy = 'Copy command';
  const pick = await vscode.window.showInformationMessage(
    'Desk: register the board MCP server in Claude Code for all projects (user scope). Restart Claude Code afterwards.',
    run,
    copy,
  );
  if (pick === run) {
    const term = vscode.window.createTerminal({ name: 'Desk MCP' });
    term.show();
    term.sendText(`claude mcp remove --scope user desk >/dev/null 2>&1; ${cmd}`);
  } else if (pick === copy) {
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage('Desk: command copied to the clipboard.');
  }
}
