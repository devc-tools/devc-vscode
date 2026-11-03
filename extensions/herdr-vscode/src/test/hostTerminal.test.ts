import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HOST_FOLDER_CONTEXT_KEY, hostTerminalFolder, hostTerminalName, openHostTerminal } from '../hostTerminal';
import { spacesTreeItem, SpaceNode } from '../views/spacesView';

type Manifest = {
	contributes: { commands: { command: string; title: string; icon?: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> };
};

suite('host terminal', () => {
	let dir: string;
	const opened: vscode.Terminal[] = [];

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-hostterm-')));
	});

	teardown(() => {
		for (const t of opened.splice(0)) {
			t.dispose();
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a dev container: a panel terminal named `<folder>` in its project folder', async () => {
		const terminal = openHostTerminal({ label: 'my-app', localFolder: dir });
		assert.ok(terminal);
		opened.push(terminal);
		assert.strictEqual(terminal.name, 'my-app');
		assert.strictEqual(hostTerminalName({ label: 'x' }), 'x');
		const options = terminal.creationOptions as vscode.TerminalOptions;
		assert.strictEqual(typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath, dir);
		assert.strictEqual(options.location, vscode.TerminalLocation.Panel);
	});

	test('a space: its bind-mounted directory on this machine, else the project folder; named with the space', () => {
		const mounts = [{ source: '/Users/me/src/app', destination: '/workspaces/app' }];
		assert.strictEqual(hostTerminalFolder('/Users/me/src/app', '/workspaces/app/pkg/web', mounts), '/Users/me/src/app/pkg/web');
		assert.strictEqual(hostTerminalFolder('/Users/me/src/app', '/home/vscode/scratch', mounts), '/Users/me/src/app', 'not mounted');
		assert.strictEqual(hostTerminalFolder('/Users/me/src/app', undefined, mounts), '/Users/me/src/app');
		const sub = path.join(dir, 'pkg');
		fs.mkdirSync(sub);
		const terminal = openHostTerminal({ label: 'my-app', localFolder: dir }, { folder: sub, space: 'web' });
		assert.ok(terminal);
		opened.push(terminal);
		assert.strictEqual(terminal.name, 'my-app · web');
		const options = terminal.creationOptions as vscode.TerminalOptions;
		assert.strictEqual(typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath, sub);
	});

	test('no project folder, or one not on this machine: no terminal', () => {
		const before = vscode.window.terminals.length;
		assert.strictEqual(openHostTerminal({ label: 'this machine' }), undefined);
		assert.strictEqual(openHostTerminal({ label: 'gone', localFolder: path.join(dir, 'missing') }), undefined);
		assert.strictEqual(vscode.window.terminals.length, before);
	});

	test('the command: in the Spaces title bar and the palette, only for a dev container session', () => {
		const manifest = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!.packageJSON as Manifest;
		const command = manifest.contributes.commands.find((c) => c.command === 'herdr.openHostTerminal');
		assert.deepStrictEqual(command && { title: command.title, icon: command.icon }, { title: 'Open Host Terminal', icon: '$(terminal)' });
		const title = manifest.contributes.menus['view/title'].find((m) => m.command === 'herdr.openHostTerminal');
		assert.strictEqual(title?.when, `view == herdr.spaces && ${HOST_FOLDER_CONTEXT_KEY}`);
		const palette = manifest.contributes.menus.commandPalette.find((m) => m.command === 'herdr.openHostTerminal');
		assert.strictEqual(palette?.when, HOST_FOLDER_CONTEXT_KEY);
		const row = manifest.contributes.menus['view/item/context'].filter((m) => m.command === 'herdr.openHostTerminal');
		assert.deepStrictEqual(row, [{ command: 'herdr.openHostTerminal', when: 'view == herdr.spaces && viewItem == herdr.space.container', group: 'inline@0' }]);
		const close = manifest.contributes.menus['view/item/context'].find((m) => m.command === 'herdr.closeSpace')!;
		const closes = (value: string) => new RegExp(/viewItem =~ \/(.*)\//.exec(close.when!)![1]).test(value);
		assert.ok(closes('herdr.space') && closes('herdr.space.container') && !closes('herdr.tab'));
	});

	test('space rows: a dev container session\'s are herdr.space.container', () => {
		const node = (sessionKey: string): SpaceNode =>
			({ type: 'space', id: 'x', sessionKey, workspaceId: 'w1', label: 'web', tooltip: '', focused: false, children: [], status: undefined }) as SpaceNode;
		assert.strictEqual(spacesTreeItem(node('container:3f2a9c1b04de/default')).contextValue, 'herdr.space.container');
		assert.strictEqual(spacesTreeItem(node('host/default')).contextValue, 'herdr.space');
		assert.strictEqual(spacesTreeItem(node('ssh:dev/default')).contextValue, 'herdr.space');
	});
});
