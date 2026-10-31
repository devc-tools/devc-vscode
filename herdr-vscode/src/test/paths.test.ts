import * as assert from 'assert';
import * as vscode from 'vscode';
import { BindMount, EnvironmentPaths, environmentUri, hostPathOf, parseBindMounts, parseLinkText, resolveLinkPath } from '../paths';
import { Environment, EnvironmentsChange } from '../environments';
import { LocalShell } from '../remoteShell';
import { findPathLinks } from '../webview/links';

suite('paths', () => {
	const MOUNTS: BindMount[] = [
		{ source: '/Users/me/code/app', destination: '/workspaces/app' },
		{ source: '/Users/me/cache', destination: '/workspaces/app/.cache' },
		{ source: '/Users/me/.ssh', destination: '/home/vscode/.ssh' },
	];
	const container = { kind: 'container', containerId: 'abcdefabcdef0123' } as const;

	test('docker inspect output: bind mounts only, and Docker Desktop prefix dropped', () => {
		assert.deepStrictEqual(
			parseBindMounts(
				JSON.stringify([
					{ Type: 'bind', Source: '/Users/me/app', Destination: '/workspaces/app', Mode: '', RW: true },
					{ Type: 'volume', Name: 'x', Source: '/var/lib/docker/volumes/x/_data', Destination: '/data' },
					{ Type: 'bind', Source: '/host_mnt/Users/me/lib', Destination: '/lib2' },
					{ Type: 'bind', Source: '/host_mntx/a', Destination: '/a' },
					{ Type: 'bind', Source: 1 },
				]),
			),
			[
				{ source: '/Users/me/app', destination: '/workspaces/app' },
				{ source: '/Users/me/lib', destination: '/lib2' },
				{ source: '/host_mntx/a', destination: '/a' },
			],
		);
		assert.deepStrictEqual(parseBindMounts('null'), []);
		assert.deepStrictEqual(parseBindMounts('nope'), []);
	});

	test('the longest destination wins', () => {
		assert.strictEqual(hostPathOf('/workspaces/app/src/a.ts', MOUNTS), '/Users/me/code/app/src/a.ts');
		assert.strictEqual(hostPathOf('/workspaces/app/.cache/x', MOUNTS), '/Users/me/cache/x');
		assert.strictEqual(hostPathOf('/workspaces/app', MOUNTS), '/Users/me/code/app');
		assert.strictEqual(hostPathOf('/workspaces/app2/x', MOUNTS), undefined, 'a sibling is not under it');
		assert.strictEqual(hostPathOf('/etc/hosts', MOUNTS), undefined);
		assert.strictEqual(hostPathOf('/x', [{ source: '/host', destination: '/' }]), '/host/x');
	});

	test('URIs per environment', () => {
		assert.strictEqual(environmentUri({ kind: 'host' }, '/a b/c.ts').toString(true), 'file:///a b/c.ts');
		const mapped = environmentUri(container, '/workspaces/app/a.ts', MOUNTS);
		assert.strictEqual(mapped.scheme, 'file');
		assert.strictEqual(mapped.path, '/Users/me/code/app/a.ts');
		const unmapped = environmentUri(container, '/home/vscode/n.txt', MOUNTS);
		assert.strictEqual(unmapped.toString(), 'herdr-container://abcdefabcdef/home/vscode/n.txt');
		const ssh = environmentUri({ kind: 'ssh', alias: 'Agent-VM' }, '/srv/x');
		assert.strictEqual(ssh.scheme, 'herdr-ssh');
		assert.strictEqual(ssh.authority, 'Agent-VM');
		assert.strictEqual(ssh.path, '/srv/x');
	});

	test('mounts are cached per container until it starts or dies again', async () => {
		const changes = new vscode.EventEmitter<EnvironmentsChange>();
		const events = new vscode.EventEmitter<string>();
		let reads = 0;
		const paths = new EnvironmentPaths({ onDidChange: changes.event, onDidContainerEvent: events.event }, async () => {
			reads++;
			return MOUNTS;
		});
		const env = { containerId: 'abcdefabcdef' };
		assert.deepStrictEqual(await paths.mounts(env), MOUNTS);
		await paths.mounts(env);
		assert.strictEqual(reads, 1);
		events.fire('abcdefabcdef0123456789');
		await paths.mounts(env);
		assert.strictEqual(reads, 2);
		changes.fire({ added: [], removed: [env as Environment], recheck: [] });
		await paths.mounts(env);
		assert.strictEqual(reads, 3);
		assert.deepStrictEqual(await paths.mounts({}), [], 'no container, no mounts');
		assert.strictEqual(reads, 3);
		paths.dispose();
	});

	test('a failed mounts read is not kept', async () => {
		const noop = () => new vscode.Disposable(() => undefined);
		let answer: BindMount[] | undefined;
		const paths = new EnvironmentPaths({ onDidChange: noop, onDidContainerEvent: noop }, async () => answer);
		assert.deepStrictEqual(await paths.mounts({ containerId: 'a' }), []);
		answer = MOUNTS;
		assert.deepStrictEqual(await paths.mounts({ containerId: 'a' }), MOUNTS);
		paths.dispose();
	});

	test('$HOME is read once per environment', async () => {
		const noop = () => new vscode.Disposable(() => undefined);
		const paths = new EnvironmentPaths({ onDidChange: noop, onDidContainerEvent: noop }, async () => []);
		const local = new LocalShell();
		let runs = 0;
		const shell = { run: (argv: string[]) => (runs++, local.run(argv)), spawn: () => local.spawn([]) };
		const env = { key: 'host', shell };
		assert.strictEqual(await paths.home(env), process.env.HOME);
		await paths.home(env);
		assert.strictEqual(runs, 1);
		paths.dispose();
	});

	test('link text and resolving it', () => {
		assert.deepStrictEqual(parseLinkText('src/a.ts:12:3'), { file: 'src/a.ts', line: 12, col: 3 });
		assert.deepStrictEqual(parseLinkText('src/a.ts:12'), { file: 'src/a.ts', line: 12, col: undefined });
		assert.deepStrictEqual(parseLinkText('README.md'), { file: 'README.md', line: undefined, col: undefined });
		assert.strictEqual(resolveLinkPath('/etc/../etc/hosts', '/x', '/h'), '/etc/hosts');
		assert.strictEqual(resolveLinkPath('~/n.txt', '/x', '/h'), '/h/n.txt');
		assert.strictEqual(resolveLinkPath('~/n.txt', '/x', undefined), undefined);
		assert.strictEqual(resolveLinkPath('./y/z.md', '/x', '/h'), '/x/y/z.md');
		assert.strictEqual(resolveLinkPath('../z.md', '/x/y', '/h'), '/x/z.md');
		assert.strictEqual(resolveLinkPath('a.ts', undefined, '/h'), undefined);
	});

	suite('link regex', () => {
		const texts = (line: string) => findPathLinks(line).map((l) => l.text);

		test('finds paths, with a position', () => {
			assert.deepStrictEqual(texts('src/a.ts:12:3'), ['src/a.ts:12:3']);
			assert.deepStrictEqual(texts('./x/y.md'), ['./x/y.md']);
			assert.deepStrictEqual(texts('~/n.txt'), ['~/n.txt']);
			assert.deepStrictEqual(texts('~/dir/n.txt:4'), ['~/dir/n.txt:4']);
			assert.deepStrictEqual(texts('./y.md'), ['./y.md']);
			assert.deepStrictEqual(texts('README.md'), ['README.md']);
			assert.deepStrictEqual(texts('../up/a.ts:9'), ['../up/a.ts:9']);
			assert.deepStrictEqual(texts('/abs/path/file'), ['/abs/path/file']);
			assert.deepStrictEqual(texts('see src/auth/middleware.ts:19 and README.md, now'), ['src/auth/middleware.ts:19', 'README.md']);
		});

		test('not URLs or version numbers', () => {
			assert.deepStrictEqual(texts('http://x.y/z'), []);
			assert.deepStrictEqual(texts('see https://example.com/a/b.html?x=1 now'), []);
			assert.deepStrictEqual(texts('1.2.3'), []);
			assert.deepStrictEqual(texts('v1.2.3 is out at 10.0.0.1:22'), ['v1.2.3']);
			assert.deepStrictEqual(texts('plain words here'), []);
		});

		test("a sentence's last full stop is not part of the path", () => {
			assert.deepStrictEqual(texts('I changed src/a.ts.'), ['src/a.ts']);
			assert.deepStrictEqual(texts('Done with README.md.'), ['README.md']);
		});

		test('positions', () => {
			assert.deepStrictEqual(findPathLinks('in  a/b.ts now'), [{ text: 'a/b.ts', start: 4 }]);
		});
	});
});
