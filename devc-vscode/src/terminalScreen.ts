import { Terminal } from '@xterm/headless';

/** Sequences that wipe the screen: ED 2 / ED 3 (erase display, scrollback), RIS. */
const FULL_CLEAR = /\x1b\[[23]J|\x1bc/g;
/** Bound on output kept for replay when nothing clears the screen. */
const MAX_REPLAY = 1 << 20;

/**
 * A terminal's screen rebuilt from its raw output stream. VS Code gives an
 * extension the bytes a command writes (TerminalShellExecution.read) but not
 * the rendered screen, and TUI agents redraw in place with cursor movement,
 * so the text only means something after it has been through an emulator.
 *
 * The real size is only learned after the fact (stable API has no terminal
 * dimensions), and output drawn at one width means something else at another.
 * So the output since the last full clear is kept, and a resize rebuilds the
 * screen from it at the new size. TUIs clear and redraw when their width
 * changes, which makes that replay match what the real terminal shows.
 */
export class TerminalScreen {
  private readonly term: Terminal;
  private _title = '';
  /** Output since the last full clear, in order. */
  private replay: string[] = [];
  private replayLength = 0;
  /** Every emulator operation, serialized so a replay never interleaves. */
  private queue: Promise<void> = Promise.resolve();

  constructor(cols = 120, rows = 40) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
    this.term.onTitleChange(title => (this._title = title));
  }

  /** The last OSC 0/2 title the program set. */
  get title(): string {
    return this._title;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /** Resolves once the emulator has processed `data`. */
  write(data: string): Promise<void> {
    return this.enqueue(() => {
      this.remember(data);
      return this.feed(data);
    });
  }

  /** Rebuild the screen at a new size from the output since the last clear. */
  resize(cols: number, rows: number): Promise<void> {
    return this.enqueue(() => {
      if (
        cols <= 0 ||
        rows <= 0 ||
        (cols === this.term.cols && rows === this.term.rows)
      ) {
        return;
      }
      this.term.reset();
      this.term.resize(cols, rows);
      return this.feed(this.replay.join(''));
    });
  }

  /**
   * The visible rows of whichever buffer is active, right-trimmed — the same
   * plain-text shape herdr's detection reads.
   */
  async text(): Promise<string> {
    await this.queue;
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = buffer.baseY; y < buffer.baseY + this.term.rows; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }

  dispose(): void {
    this.term.dispose();
  }

  private enqueue(op: () => Promise<void> | void): Promise<void> {
    this.queue = this.queue.then(op, op);
    return this.queue;
  }

  private feed(data: string): Promise<void> {
    return new Promise(resolve => this.term.write(data, resolve));
  }

  private remember(data: string): void {
    let clearAt = -1;
    for (const m of data.matchAll(FULL_CLEAR)) {
      clearAt = m.index;
    }
    if (clearAt >= 0) {
      this.replay = [];
      this.replayLength = 0;
      data = data.slice(clearAt);
    }
    this.replay.push(data);
    this.replayLength += data.length;
    while (this.replayLength > MAX_REPLAY && this.replay.length > 1) {
      this.replayLength -= this.replay.shift()!.length;
    }
  }
}
