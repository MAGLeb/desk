import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Canvas, emptyCanvas, parseCanvas, serializeCanvas } from '../shared/canvas';
import { Op, applyOps } from '../shared/ops';

export interface BoardChange {
  board: Canvas;
  source: 'local' | 'external';
  error?: string;
  ack?: number;
}

/**
 * One board file on disk. The extension applies the webview's ops to the freshest
 * file contents (read-modify-write), so edits made by the agent in between are kept.
 */
export class BoardStore implements vscode.Disposable {
  text = '';
  board: Canvas = emptyCanvas();
  error: string | undefined;
  private readonly emitter = new vscode.EventEmitter<BoardChange>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private mtime = 0;

  constructor(readonly file: string) {
    this.readDisk(true);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.readDisk(false), 40);
    };
    this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    // Belt and braces: some setups drop watcher events for files outside the workspace.
    this.poll = setInterval(() => {
      try {
        const m = fs.statSync(this.file).mtimeMs;
        if (m !== this.mtime) schedule();
      } catch {
        /* missing file is handled by readDisk */
      }
    }, 1500);
  }

  private readText(): string {
    try {
      const st = fs.statSync(this.file);
      this.mtime = st.mtimeMs;
      return fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  readDisk(initial: boolean): void {
    let text: string;
    try {
      text = this.readText();
    } catch {
      return;
    }
    if (!initial && text === this.text) return;
    this.text = text;
    try {
      this.board = parseCanvas(text);
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    }
    if (!initial) this.emitter.fire({ board: this.board, source: 'external', error: this.error });
  }

  apply(ops: Op[], ack?: number): void {
    let base: Canvas;
    try {
      const text = this.readText();
      base = parseCanvas(text);
      if (text !== this.text) {
        this.text = text;
        this.board = base;
      }
    } catch (e) {
      this.error = (e as Error).message;
      this.emitter.fire({ board: this.board, source: 'external', error: this.error, ack });
      return;
    }
    this.write(applyOps(base, ops), ack);
  }

  private write(c: Canvas, ack?: number): void {
    const text = serializeCanvas(c);
    if (text !== this.text || !fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.file);
      try {
        this.mtime = fs.statSync(this.file).mtimeMs;
      } catch {
        /* ignore */
      }
    }
    this.text = text;
    this.board = c;
    this.error = undefined;
    this.emitter.fire({ board: c, source: 'local', ack });
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
