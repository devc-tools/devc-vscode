import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { RemoteShell } from '../remoteShell';
import { closedState, controlArgv, PaneFrame, PaneStreams, PaneViewer, parseTerminalRecord } from '../streams';
import { TileStreamState } from '../tilesProtocol';
import { createWheelAccumulator, wrapPaste } from '../webview/input';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A child process with piped stdin and stdout, that records what it is told. */
class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stdin = new PassThrough();
	exitCode: number | null = null;
	signalCode: string | null = null;
	readonly written: unknown[] = [];
	stdinEnded = false;
	killed = false;

	constructor(readonly argv: string[]) {
		super();
		this.stdin.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString().split('\n').filter(Boolean)) {
				this.written.push(JSON.parse(line));
			}
		});
		this.stdin.on('end', () => (this.stdinEnded = true));
	}

	record(rec: unknown): void {
		this.stdout.write(JSON.stringify(rec) + '\n');
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}

	/** The commands written so far of one type. */
	commands(type: string): Record<string, unknown>[] {
		return this.written.filter((c) => (c as { type: string }).type === type) as Record<string, unknown>[];
	}
}

class FakeViewer implements PaneViewer {
	frames: PaneFrame[] = [];
	states: TileStreamState[] = [];
	frame(_paneKey: string, frame: PaneFrame): void {
		this.frames.push(frame);
	}
	state(_paneKey: string, state: TileStreamState): void {
		this.states.push(state);
	}
}

const frame = (full: boolean, seq = 1) => ({
	type: 'terminal.frame',
	seq,
	encoding: 'ansi',
	full,
	width: 80,
	height: 24,
	bytes: 'aGk=',
});

function fixture(graceMs = 20) {
	const children: FakeChild[] = [];
	const shell = {
		spawn(argv: string[]) {
			const child = new FakeChild(argv);
			children.push(child);
			return child as unknown as cp.ChildProcess;
		},
	} as unknown as RemoteShell;
	const streams = new PaneStreams(
		(key) => (key === 'host/s' ? { shell, name: 's' } : undefined),
		() => undefined,
		graceMs,
	);
	return { children, streams };
}

const KEY = 'host/s|w1:p1';

suite('terminal records', () => {
	test('frame', () => {
		assert.deepStrictEqual(parseTerminalRecord(JSON.stringify(frame(true, 7))), {
			type: 'frame',
			seq: 7,
			full: true,
			width: 80,
			height: 24,
			bytes: 'aGk=',
		});
	});

	test('closed, with each reason', () => {
		for (const reason of ['detached', 'terminal attach taken over', 'terminal term_1 exited']) {
			assert.deepStrictEqual(parseTerminalRecord(JSON.stringify({ type: 'terminal.closed', reason })), {
				type: 'closed',
				reason,
			});
		}
		assert.deepStrictEqual(closedState('terminal attach taken over'), { kind: 'takenOver' });
		assert.deepStrictEqual(closedState('terminal term_1 exited'), { kind: 'ended', reason: 'terminal term_1 exited' });
	});

	test('junk lines are ignored', () => {
		for (const line of ['', 'not json', '42', 'null', '{"type":"other"}', '{"type":"terminal.frame"}']) {
			assert.strictEqual(parseTerminalRecord(line), undefined, line);
		}
	});

	test('controller argv', () => {
		assert.deepStrictEqual(controlArgv('s', 'w1:p1', 80, 24).slice(4), [
			'--session',
			's',
			'terminal',
			'session',
			'control',
			'w1:p1',
			'--takeover',
			'--cols',
			'80',
			'--rows',
			'24',
		]);
	});
});

suite('pane streams', () => {
	test('two tiles share one spawn; the newcomer gets a full repaint', async () => {
		const { children, streams } = fixture();
		const a = new FakeViewer();
		const b = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		children[0].record(frame(true));
		await sleep(5);
		assert.strictEqual(a.frames.length, 1);
		assert.deepStrictEqual(a.states, [{ kind: 'live' }]);
		streams.open(KEY, b, 100, 30);
		assert.strictEqual(children.length, 1);
		await sleep(5);
		// Same size as the pane has: herdr answers any terminal.resize with a full frame.
		assert.deepStrictEqual(children[0].commands('terminal.resize'), [{ type: 'terminal.resize', cols: 80, rows: 24 }]);
		children[0].record(frame(true, 2));
		await sleep(5);
		assert.strictEqual(a.frames.length, 2);
		assert.strictEqual(b.frames.length, 1);
		streams.dispose();
	});

	test('last tile closed: release, then stdin ends after the grace period', async () => {
		const { children, streams } = fixture(30);
		const a = new FakeViewer();
		const b = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		streams.open(KEY, b, 80, 24);
		streams.close(KEY, a);
		await sleep(5);
		assert.strictEqual(children[0].commands('terminal.release').length, 0, 'b still shows it');
		streams.close(KEY, b);
		await sleep(5);
		assert.strictEqual(children[0].commands('terminal.release').length, 1);
		assert.strictEqual(children[0].stdinEnded, false, 'stdin stays open during the grace period');
		await sleep(60);
		assert.strictEqual(children[0].stdinEnded, true);
		assert.strictEqual(children.length, 1);
		streams.dispose();
	});

	test('resize owner is the last focused tile', async () => {
		const { children, streams } = fixture();
		const a = new FakeViewer();
		const b = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		streams.open(KEY, b, 100, 30);
		await sleep(5);
		const child = children[0];
		child.written.length = 0;

		streams.resize(KEY, b, 110, 31);
		await sleep(5);
		assert.deepStrictEqual(child.commands('terminal.resize'), [], 'b is not the owner yet');

		streams.focus(KEY, b);
		await sleep(5);
		assert.deepStrictEqual(child.commands('terminal.resize'), [{ type: 'terminal.resize', cols: 110, rows: 31 }]);
		child.written.length = 0;

		streams.resize(KEY, a, 90, 25);
		await sleep(5);
		assert.deepStrictEqual(child.commands('terminal.resize'), [], 'a lost ownership');

		streams.resize(KEY, b, 120, 32);
		await sleep(5);
		assert.deepStrictEqual(child.commands('terminal.resize'), [{ type: 'terminal.resize', cols: 120, rows: 32 }]);
		child.written.length = 0;

		// The owner goes away: the size comes from a tile that is left.
		streams.close(KEY, b);
		await sleep(5);
		assert.deepStrictEqual(child.commands('terminal.resize'), [{ type: 'terminal.resize', cols: 90, rows: 25 }]);
		streams.dispose();
	});

	test('an unchanged size is not sent again', async () => {
		const { children, streams } = fixture();
		const a = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		streams.resize(KEY, a, 80, 24);
		streams.focus(KEY, a);
		await sleep(5);
		assert.deepStrictEqual(children[0].commands('terminal.resize'), []);
		streams.dispose();
	});

	test('input and scroll go to the controller', async () => {
		const { children, streams } = fixture();
		streams.open(KEY, new FakeViewer(), 80, 24);
		streams.input(KEY, 'ls\r');
		streams.scroll(KEY, 'up', 3);
		await sleep(5);
		assert.deepStrictEqual(children[0].written, [
			{ type: 'terminal.input', text: 'ls\r' },
			{ type: 'terminal.scroll', direction: 'up', lines: 3 },
		]);
		streams.dispose();
	});

	test('taken over: tiles are told, Reconnect restarts with --takeover', async () => {
		const { children, streams } = fixture();
		const a = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		children[0].record({ type: 'terminal.closed', reason: 'terminal attach taken over' });
		await sleep(5);
		assert.deepStrictEqual(a.states, [{ kind: 'takenOver' }]);
		streams.reconnect(KEY);
		assert.strictEqual(children.length, 2);
		assert.ok(children[1].argv.includes('--takeover'));
		// The replaced process going away is not news.
		children[0].emit('close');
		children[1].record(frame(true));
		await sleep(5);
		assert.deepStrictEqual(a.states, [{ kind: 'takenOver' }, { kind: 'live' }]);
		streams.dispose();
	});

	test('a controller that exits without a record, or a session not connected, ends the tile', async () => {
		const { children, streams } = fixture();
		const a = new FakeViewer();
		streams.open(KEY, a, 80, 24);
		children[0].stdout.end();
		children[0].emit('close');
		await sleep(5);
		assert.deepStrictEqual(a.states, [{ kind: 'ended', reason: 'the terminal stream ended' }]);
		const b = new FakeViewer();
		streams.open('host/gone|w1:p1', b, 80, 24);
		assert.deepStrictEqual(b.states, [{ kind: 'ended', reason: 'session host/gone is not connected' }]);
		streams.dispose();
	});

	test('dispose releases and ends stdin at once', async () => {
		const { children, streams } = fixture(60000);
		streams.open(KEY, new FakeViewer(), 80, 24);
		streams.dispose();
		await sleep(5);
		assert.strictEqual(children[0].commands('terminal.release').length, 1);
		assert.strictEqual(children[0].stdinEnded, true);
	});
});

suite('webview input', () => {
	test('paste: single lines as is, multiple lines bracketed with \\r', () => {
		assert.strictEqual(wrapPaste('ls -la'), 'ls -la');
		assert.strictEqual(wrapPaste('a\nb\r\nc'), '\x1b[200~a\rb\rc\x1b[201~');
	});

	test('wheel: 3 lines per notch; pixels accumulate and reset on reversal', () => {
		const line = createWheelAccumulator();
		assert.deepStrictEqual(line(1, 20, 1), { direction: 'down', lines: 3 });
		assert.deepStrictEqual(line(-1, 20, 1), { direction: 'up', lines: 3 });
		assert.strictEqual(line(0, 20, 0), undefined);

		const px = createWheelAccumulator();
		assert.strictEqual(px(30, 20, 0), undefined);
		assert.deepStrictEqual(px(30, 20, 0), { direction: 'down', lines: 3 });
		assert.strictEqual(px(30, 20, 0), undefined);
		assert.strictEqual(px(-30, 20, 0), undefined, 'reversal drops what had accumulated');
		assert.deepStrictEqual(px(-120, 20, 0), { direction: 'up', lines: 6 });
	});
});
