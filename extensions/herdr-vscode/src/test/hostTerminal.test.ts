import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HOST_FOLDER_CONTEXT_KEY, hostTerminalName, openHostTerminal } from '../hostTerminal';

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

	test('a dev container: a panel terminal named `<folder> (host)` in its project folder', async () => {
		const terminal = openHostTerminal({ label: 'my-app', localFolder: dir });
		assert.ok(terminal);
		opened.push(terminal);
		assert.strictEqual(terminal.name, 'my-app (host)');
		assert.strictEqual(hostTerminalName({ label: 'x' }), 'x (host)');
		const options = terminal.creationOptions as vscode.TerminalOptions;
		assert.strictEqual(typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath, dir);
		assert.strictEqual(options.location, vscode.TerminalLocation.Panel);
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
	});
});
