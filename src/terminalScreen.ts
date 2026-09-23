import { Terminal } from '@xterm/headless';

/**
 * A terminal's screen rebuilt from its raw output stream. VS Code gives an
 * extension the bytes a command writes (TerminalShellExecution.read) but not
 * the rendered screen, and TUI agents redraw in place with cursor movement,
 * so the text only means something after it has been through an emulator.
 */
export class TerminalScreen {
  private readonly term: Terminal;
  private _title = '';

  constructor(cols = 120, rows = 40) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
    this.term.onTitleChange(title => (this._title = title));
  }

  /** The last OSC 0/2 title the program set. */
  get title(): string {
    return this._title;
  }

  /** Resolves once the emulator has processed `data`. */
  write(data: string): Promise<void> {
    return new Promise(resolve => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (
      cols > 0 &&
      rows > 0 &&
      (cols !== this.term.cols || rows !== this.term.rows)
    ) {
      this.term.resize(cols, rows);
    }
  }

  /**
   * The visible rows of whichever buffer is active, right-trimmed — the same
   * plain-text shape herdr's detection reads.
   */
  text(): string {
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
}
