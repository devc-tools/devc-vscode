import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangePoller, ContainerFileSystemProvider, PolledProvider, SshFileSystemProvider } from '../remoteFs';
import { DockerShell, LocalShell, RemoteShell, RunOptions, ShellResult, shQuote, SshShell, Spawn } from '../remoteShell';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A shell that records its commands and answers from a script: never runs anything. */
class RecordingShell implements RemoteShell {
	readonly calls: { argv: string[]; options?: RunOptions }[] = [];
	constructor(private readonly answer: (argv: string[]) => Partial<ShellResult> = () => ({})) {}
	async run(argv: string[], options?: RunOptions): Promise<ShellResult> {
		this.calls.push({ argv, options });
		return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, ...this.answer(argv) };
	}
	spawn(): cp.ChildProcess {
		throw new Error('not used');
	}
	/** The commands, first word first, without the leading stats the provider makes for itself. */
	commands(): string[][] {
		return this.calls.map((c) => c.argv).filter((a) => a[0] !== 'stat');
	}
}

const ID = 'abcdefabcdef';
const uri = (p: string, authority = ID) => vscode.Uri.from({ scheme: 'herdr-container', authority, path: p });

const missing = (argv: string[]): Partial<ShellResult> =>
	argv[0] === 'stat' ? { exitCode: 1, stderr: Buffer.from(`stat: cannot statx '${argv[argv.length - 1]}': No such file or directory`) } : {};
const statOutput = (type: string) => (argv: string[]): Partial<ShellResult> =>
	argv[0] === 'stat' ? { stdout: Buffer.from(`${type}\n5\n1700000000\n0\n`) } : {};

function provider(answer?: (argv: string[]) => Partial<ShellResult>) {
	const shell = new RecordingShell(answer);
	return { shell, fs: new ContainerFileSystemProvider((id) => (id === ID ? shell : undefined)) };
}

async function fsErrorCode(promise: Thenable<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof vscode.FileSystemError, `got ${err}`);
		return err.code;
	}
	assert.fail('expected a FileSystemError');
}

suite('read-write providers (no Docker or ssh required)', () => {
	test('stat: argv and result', async () => {
		const { shell, fs: p } = provider(statOutput('regular file'));
		const stat = await p.stat(uri('/a b'));
		assert.deepStrictEqual(shell.calls[0].argv, ['stat', '-L', '-c', '%F\n%s\n%Y\n%W', '--', '/a b']);
		assert.deepStrictEqual(stat, { type: vscode.FileType.File, ctime: 1700000000000, mtime: 1700000000000, size: 5 });
	});

	test('readDirectory: argv and NUL-delimited pairs', async () => {
		const { shell, fs: p } = provider(() => ({ stdout: Buffer.from('a b\0f\0dir\0d\0link\0l\0odd\0s\0') }));
		assert.deepStrictEqual(await p.readDirectory(uri('/x')), [
			['a b', vscode.FileType.File],
			['dir', vscode.FileType.Directory],
			['link', vscode.FileType.SymbolicLink],
			['odd', vscode.FileType.Unknown],
		]);
		assert.deepStrictEqual(shell.calls[0].argv, ['find', '-L', '/x', '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0%y\\0']);
	});

	test('readFile: argv', async () => {
		const { shell, fs: p } = provider(() => ({ stdout: Buffer.from('hi') }));
		assert.strictEqual(Buffer.from(await p.readFile(uri('/x'))).toString(), 'hi');
		assert.deepStrictEqual(shell.calls[0].argv, ['cat', '--', '/x']);
	});

	test('writeFile: content on stdin, the path as $1, never in the script', async () => {
		const { shell, fs: p } = provider(statOutput('regular file'));
		const content = Buffer.from('new');
		await p.writeFile(uri("/it's $(x).txt"), content, { create: false, overwrite: true });
		const write = shell.calls.find((c) => c.argv[0] === 'sh')!;
		assert.deepStrictEqual(write.argv, ['sh', '-c', 'cat > "$1"', 'sh', "/it's $(x).txt"]);
		assert.strictEqual(write.options?.input, content);
	});

	test('writeFile: the contract of create and overwrite', async () => {
		const exists = provider(statOutput('regular file'));
		assert.strictEqual(await fsErrorCode(exists.fs.writeFile(uri('/x'), Buffer.alloc(0), { create: true, overwrite: false })), 'FileExists');
		const dir = provider(statOutput('directory'));
		assert.strictEqual(await fsErrorCode(dir.fs.writeFile(uri('/x'), Buffer.alloc(0), { create: true, overwrite: true })), 'FileIsADirectory');
		const gone = provider(missing);
		assert.strictEqual(await fsErrorCode(gone.fs.writeFile(uri('/x'), Buffer.alloc(0), { create: false, overwrite: true })), 'FileNotFound');
		for (const p of [exists, dir, gone]) {
			assert.ok(!p.shell.calls.some((c) => c.argv[0] === 'sh'));
		}
	});

	test('createDirectory: mkdir without -p', async () => {
		const { shell, fs: p } = provider(missing);
		await p.createDirectory(uri('/x/y'));
		assert.deepStrictEqual(shell.commands(), [['mkdir', '--', '/x/y']]);
	});

	test('delete: rmdir for an empty-directory non-recursive delete, else rm -rf', async () => {
		const dir = provider(statOutput('directory'));
		await dir.fs.delete(uri('/d'), { recursive: false });
		assert.deepStrictEqual(dir.shell.commands(), [['rmdir', '--', '/d']]);
		const tree = provider(statOutput('directory'));
		await tree.fs.delete(uri('/d'), { recursive: true });
		assert.deepStrictEqual(tree.shell.commands(), [['rm', '-rf', '--', '/d']]);
		const file = provider(statOutput('regular file'));
		await file.fs.delete(uri('/f'), { recursive: false });
		assert.deepStrictEqual(file.shell.commands(), [['rm', '-rf', '--', '/f']]);
	});

	test('rename: mv; refused across authorities', async () => {
		const { shell, fs: p } = provider(statOutput('regular file'));
		await p.rename(uri('/a'), uri('/b'), { overwrite: true });
		assert.deepStrictEqual(shell.commands(), [['mv', '--', '/a', '/b']]);
		await assert.rejects(Promise.resolve(p.rename(uri('/a'), uri('/b', 'bbbbbbbbbbbb'), { overwrite: true })), (err: vscode.FileSystemError) => {
			assert.strictEqual(err.code, 'NoPermissions');
			assert.match(err.message, /Cannot rename across containers/);
			return true;
		});
		const ssh = new SshFileSystemProvider(() => new RecordingShell(statOutput('regular file')));
		await assert.rejects(Promise.resolve(ssh.rename(uri('/a', 'one'), uri('/b', 'two'), { overwrite: true })), /Cannot rename across SSH hosts/);
	});

	test('errors from stderr map as in devc-vscode', async () => {
		const failing = (stderr: string) => provider(() => ({ exitCode: 1, stderr: Buffer.from(stderr) }));
		const cases: [string, string][] = [
			['stat: No such file or directory', 'FileNotFound'],
			['cat: x: Permission denied', 'NoPermissions'],
			['cat: x: Not a directory', 'FileNotADirectory'],
			['cat: x: Is a directory', 'FileIsADirectory'],
			['mkdir: File exists', 'FileExists'],
			['Error response from daemon: Container x is not running', 'Unavailable'],
		];
		for (const [stderr, code] of cases) {
			assert.strictEqual(await fsErrorCode(failing(stderr).fs.readFile(uri('/x'))), code, stderr);
		}
		await assert.rejects(Promise.resolve(failing('').fs.readFile(uri('/x'))), /docker exec failed/);
		const ssh = new SshFileSystemProvider(() => new RecordingShell(() => ({ exitCode: 1, stderr: Buffer.alloc(0) })));
		await assert.rejects(Promise.resolve(ssh.readFile(uri('/x', 'host'))), /ssh command failed/);
		const down = new SshFileSystemProvider(() => new RecordingShell(() => ({ exitCode: 255, stderr: Buffer.from('Connection refused') })));
		assert.strictEqual(await fsErrorCode(down.stat(uri('/x', 'host'))), 'Unavailable');
	});

	test('an unknown container or unconfigured SSH authority is rejected without spawning', async () => {
		const { shell, fs: p } = provider();
		const operations = (q: vscode.FileSystemProvider, u: vscode.Uri): Thenable<unknown>[] => [
			Promise.resolve().then(() => q.stat(u)),
			Promise.resolve().then(() => q.readDirectory(u)),
			Promise.resolve().then(() => q.readFile(u)),
			Promise.resolve().then(() => q.writeFile(u, Buffer.alloc(0), { create: true, overwrite: true })),
			Promise.resolve().then(() => q.createDirectory(u)),
			Promise.resolve().then(() => q.delete(u, { recursive: true })),
			Promise.resolve().then(() => q.rename(u, u, { overwrite: true })),
		];
		// Unknown, too short, too long (a prefix must not do), empty, and an option in disguise.
		for (const authority of ['bbbbbbbbbbbb', 'abc', `${ID}0`, '', '-oProxyCommand=x']) {
			for (const op of operations(p, uri('/x', authority))) {
				await assert.rejects(Promise.resolve(op), (err: vscode.FileSystemError) => {
					assert.strictEqual(err.code, 'Unavailable');
					assert.match(err.message, /Not a known dev container/);
					return true;
				});
			}
		}
		assert.strictEqual(shell.calls.length, 0);

		const sshShell = new RecordingShell();
		const ssh = new SshFileSystemProvider((host) => (host.toLowerCase() === 'agent-vm' ? sshShell : undefined));
		for (const authority of ['other', '', '-oProxyCommand=x']) {
			for (const op of operations(ssh, vscode.Uri.from({ scheme: 'herdr-ssh', authority, path: '/x' }))) {
				await assert.rejects(Promise.resolve(op), (err: vscode.FileSystemError) => {
					assert.strictEqual(err.code, 'Unavailable');
					assert.match(err.message, /SSH host is not in herdr.sshHosts/);
					return true;
				});
			}
		}
		assert.strictEqual(sshShell.calls.length, 0);
		await ssh.readFile(vscode.Uri.from({ scheme: 'herdr-ssh', authority: 'Agent-VM', path: '/x' }));
		assert.strictEqual(sshShell.calls.length, 1, 'a configured host, whatever the case');
	});

	test('an authority is not judged before discovery has settled', async () => {
		let settle: () => void = () => undefined;
		const settled = new Promise<void>((r) => (settle = r));
		const shell = new RecordingShell();
		let known = false;
		const p = new ContainerFileSystemProvider(
			() => (known ? shell : undefined),
			() => settled,
		);
		const read = p.readFile(uri('/x'));
		await sleep(10);
		assert.strictEqual(shell.calls.length, 0);
		known = true;
		settle();
		await read;
		assert.strictEqual(shell.calls.length, 1);
	});

	test('ssh goes through SshShell, with the safety options, every word quoted', async () => {
		const seen: { command: string; args: string[] }[] = [];
		const spawn: Spawn = (command, args) => {
			seen.push({ command, args });
			return cp.spawn('true', [], { stdio: ['pipe', 'pipe', 'pipe'] });
		};
		const shell = new SshShell('agent-vm', { sshPath: 'ssh', controlDir: undefined, allowed: () => true, spawn });
		const p = new SshFileSystemProvider(() => shell);
		await p.readFile(uri("/it's", 'agent-vm'));
		assert.strictEqual(seen[0].command, 'ssh');
		assert.deepStrictEqual(seen[0].args, [
			'-T',
			'-o',
			'BatchMode=yes',
			'-o',
			'ForwardAgent=no',
			'-o',
			'ForwardX11=no',
			'-o',
			'ClearAllForwardings=yes',
			'-o',
			'PermitLocalCommand=no',
			'--',
			'agent-vm',
			`${shQuote('cat')} ${shQuote('--')} ${shQuote("/it's")}`,
		]);
	});

	test('a container runs as its remote user', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-docker-'));
		try {
			// A stand-in for the docker CLI, that says what it was asked.
			const docker = path.join(dir, 'docker');
			fs.writeFileSync(docker, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
			const p = new ContainerFileSystemProvider(() => new DockerShell(ID, 'vscode', docker));
			const out = Buffer.from(await p.readFile(uri('/x'))).toString();
			assert.deepStrictEqual(out.trim().split('\n'), ['exec', '-i', '-u', 'vscode', ID, 'cat', '--', '/x']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	suite('the real commands, on a temp directory', () => {
		let dir: string;
		const shell = new LocalShell();
		const p = new ContainerFileSystemProvider(() => shell);
		const at = (name: string) => uri(path.posix.join(dir, name));

		setup(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-fs-'));
		});
		teardown(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test('create, write, read, stat, list, rename, delete', async () => {
			await p.createDirectory(at('d'));
			assert.strictEqual(await fsErrorCode(p.createDirectory(at('no/such'))), 'FileNotFound');
			const name = "d/a file's $(name).txt";
			await p.writeFile(at(name), Buffer.from('hello'), { create: true, overwrite: false });
			assert.strictEqual(fs.readFileSync(path.join(dir, name), 'utf8'), 'hello');
			assert.strictEqual(Buffer.from(await p.readFile(at(name))).toString(), 'hello');
			const stat = await p.stat(at(name));
			assert.strictEqual(stat.type, vscode.FileType.File);
			assert.strictEqual(stat.size, 5);
			assert.deepStrictEqual(await p.readDirectory(at('d')), [["a file's $(name).txt", vscode.FileType.File]]);
			await p.rename(at(name), at('d/b.txt'), { overwrite: false });
			assert.deepStrictEqual(await p.readDirectory(at('d')), [['b.txt', vscode.FileType.File]]);
			await assert.rejects(Promise.resolve(p.delete(at('d'), { recursive: false })), /not empty/);
			await p.delete(at('d'), { recursive: true });
			assert.strictEqual(await fsErrorCode(p.stat(at('d'))), 'FileNotFound');
		});

		test('a save overwrites in place: owner and mode stay', async () => {
			const file = path.join(dir, 'f');
			fs.writeFileSync(file, 'old', { mode: 0o640 });
			const inode = fs.statSync(file).ino;
			await p.writeFile(at('f'), Buffer.from('new'), { create: false, overwrite: true });
			const after = fs.statSync(file);
			assert.strictEqual(after.ino, inode);
			assert.strictEqual(after.mode & 0o777, 0o640);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
		});

		test('a file that may not be written is a permission error', async () => {
			const file = path.join(dir, 'ro');
			fs.writeFileSync(file, 'x', { mode: 0o444 });
			if (process.getuid?.() === 0) {
				return; // root writes anywhere.
			}
			assert.strictEqual(await fsErrorCode(p.writeFile(at('ro'), Buffer.from('y'), { create: false, overwrite: true })), 'NoPermissions');
		});
	});
});

suite('change polling', () => {
	/** A provider whose stat is set by hand. */
	class Fake implements PolledProvider {
		mtime = 1000;
		size = 1;
		stats = 0;
		failing = false;
		readonly fired: string[] = [];
		async stat(): Promise<vscode.FileStat> {
			this.stats++;
			if (this.failing) {
				throw vscode.FileSystemError.FileNotFound();
			}
			return { type: vscode.FileType.File, ctime: 0, mtime: this.mtime, size: this.size };
		}
		refresh(u: vscode.Uri): void {
			this.fired.push(u.toString());
		}
	}

	function setup() {
		const fake = new Fake();
		const doc = uri('/open');
		let open: vscode.Uri[] = [doc];
		const opened = new vscode.EventEmitter<vscode.Uri>();
		const closed = new vscode.EventEmitter<vscode.Uri>();
		const poller = new ChangePoller(new Map([['herdr-container', fake]]), () => open, opened.event, closed.event, 3600000);
		return {
			fake,
			doc,
			poller,
			opened,
			close: () => {
				open = [];
				closed.fire(doc);
			},
			open: () => {
				open = [doc];
				opened.fire(doc);
			},
		};
	}

	test('fires Changed once per mtime change, and for a size change', async () => {
		const { fake, doc, poller } = setup();
		await poller.poll();
		assert.deepStrictEqual(fake.fired, [], 'the first look only records');
		await poller.poll();
		assert.deepStrictEqual(fake.fired, []);
		fake.mtime = 2000;
		await poller.poll();
		await poller.poll();
		await poller.poll();
		assert.deepStrictEqual(fake.fired, [doc.toString()]);
		fake.size = 2;
		await poller.poll();
		assert.deepStrictEqual(fake.fired, [doc.toString(), doc.toString()]);
		poller.dispose();
	});

	test('stops on close; opened again it starts over', async () => {
		const { fake, poller, close, open } = setup();
		await poller.poll();
		close();
		const stats = fake.stats;
		fake.mtime = 2000;
		await poller.poll();
		assert.strictEqual(fake.stats, stats, 'not looked at while closed');
		assert.deepStrictEqual(fake.fired, []);
		open();
		await sleep(0);
		await poller.poll();
		assert.deepStrictEqual(fake.fired, [], 'the file changing while closed is not a change');
		poller.dispose();
	});

	test('a failing stat fires nothing, and the next change is still seen', async () => {
		const { fake, doc, poller } = setup();
		await poller.poll();
		fake.failing = true;
		await poller.poll();
		assert.deepStrictEqual(fake.fired, []);
		fake.failing = false;
		fake.mtime = 2000;
		await poller.poll();
		assert.deepStrictEqual(fake.fired, [doc.toString()]);
		poller.dispose();
	});

	test('other schemes are left alone', async () => {
		const fake = new Fake();
		const poller = new ChangePoller(new Map([['herdr-ssh', fake]]), () => [vscode.Uri.file('/x'), uri('/y')], () => new vscode.Disposable(() => undefined), () => new vscode.Disposable(() => undefined), 3600000);
		await poller.poll();
		assert.strictEqual(fake.stats, 0);
		poller.dispose();
	});

	test('a real editor reloads when polling sees a change, and saves through the provider', async function () {
		this.timeout(20000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-poll-'));
		const scheme = 'herdr-polltest';
		const shell = new LocalShell();
		const p = new ContainerFileSystemProvider(() => shell);
		const registration = vscode.workspace.registerFileSystemProvider(scheme, p, { isCaseSensitive: true });
		const file = path.join(dir, 'notes.txt');
		fs.writeFileSync(file, 'one\n');
		const poller = new ChangePoller(new Map([[scheme, p]]), undefined, undefined, undefined, 3600000);
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme, authority: ID, path: file }));
			const editor = await vscode.window.showTextDocument(doc);
			assert.strictEqual(doc.getText(), 'one\n');
			await poller.poll();

			// Something else, say an agent, changes it; `stat -c %Y` has 1 s resolution, the size does not care.
			fs.writeFileSync(file, 'one\ntwo\n');
			await poller.poll();
			const start = Date.now();
			while (doc.getText() !== 'one\ntwo\n' && Date.now() - start < 8000) {
				await sleep(50);
			}
			assert.strictEqual(doc.getText(), 'one\ntwo\n');
			assert.strictEqual(doc.isDirty, false);

			await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'zero\n'));
			assert.ok(await doc.save());
			assert.strictEqual(fs.readFileSync(file, 'utf8'), 'zero\none\ntwo\n');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			poller.dispose();
			registration.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
