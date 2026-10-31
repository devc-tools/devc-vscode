import * as assert from 'assert';
import * as vscode from 'vscode';

suite('herdr-vscode', () => {
	const extension = () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode');
		assert.ok(ext, 'herdr-vscode is loaded');
		return ext;
	};

	test('activates', async () => {
		const ext = extension();
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('contributes and registers the Sessions, Spaces and Agents views', async () => {
		const ext = extension();
		const views = ext.packageJSON.contributes.views.herdr as { id: string }[];
		assert.deepStrictEqual(
			views.map((v) => v.id),
			['herdr.sessions', 'herdr.spaces', 'herdr.agents', 'herdr.paneContext'],
		);
		await ext.activate();
		// Opening a view resolves its registered provider; an unregistered view would fail to focus.
		for (const v of views) {
			await vscode.commands.executeCommand(`${v.id}.focus`);
		}
	});

	test('registers the contributed commands', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = (ext.packageJSON.contributes.commands as { command: string }[]).map((c) => c.command);
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const c of contributed) {
			assert.ok(registered.has(c), c);
		}
	});

	test('settings defaults', () => {
		const config = vscode.workspace.getConfiguration('herdr');
		assert.deepStrictEqual(config.get('sshHosts'), []);
		assert.strictEqual(config.get('sshPath'), 'ssh');
		assert.strictEqual(config.get('dockerPath'), 'docker');
		assert.strictEqual(config.get('showStoppedSessions'), false);
		assert.strictEqual(config.get('openPaneIn'), 'layout');
	});

	test('agent filter commands set the filter', async () => {
		await extension().activate();
		await vscode.commands.executeCommand('herdr.agents.showBlocked');
		await vscode.commands.executeCommand('herdr.agents.showAll');
	});

	test('mirrored tabs: commands, serializer activation, no Attach in Terminal', async () => {
		const ext = extension();
		await ext.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		assert.ok(registered.has('herdr.openTab'));
		assert.ok(registered.has('herdr.openPaneTab'));
		assert.ok(![...registered].some((c) => c.startsWith('herdr.attach')));
		assert.ok((ext.packageJSON.activationEvents as string[]).includes('onWebviewPanel:herdr.tiles'));
		// Without the session connected (the test host discovers nothing) nothing opens.
		await vscode.commands.executeCommand('herdr.openPaneTab', 'host/none', 'w1:p1');
	});

	test('layout tabs: commands, the context menu, and the icon ships', async () => {
		const ext = extension();
		await ext.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const c of ['herdr.newLayout', 'herdr.openLayout', 'herdr.renameLayout', 'herdr.deleteLayout', 'herdr.addToLayout']) {
			assert.ok(registered.has(c), c);
		}
		const menus = ext.packageJSON.contributes.menus;
		assert.deepStrictEqual(
			(menus['view/item/context'] as { command: string }[])
				.map((m) => m.command)
				.filter((c) => !c.startsWith('herdr.paneContext.') && !/^herdr\.(startSession|stopSession|newTab|splitRight|splitDown)$/.test(c)),
			['herdr.addToLayout', 'herdr.openPaneTab', 'herdr.focusPane'],
		);
		const focus = (ext.packageJSON.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'herdr.focusPane');
		assert.strictEqual(focus?.title, 'Focus in herdr TUI');
		await vscode.workspace.fs.stat(vscode.Uri.joinPath(ext.extensionUri, 'resources', 'layout.svg'));
		// Without the session connected (the test host discovers nothing) nothing opens.
		await vscode.commands.executeCommand('herdr.addToLayout', 'host/none', 'w1:p1');
	});

	test('dragging panes: Cancel Placing Pane on Escape while placing, not in the palette', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = ext.packageJSON.contributes;
		const command = (contributed.commands as { command: string; title: string }[]).find((c) => c.command === 'herdr.cancelPlacement');
		assert.strictEqual(command?.title, 'Cancel Placing Pane');
		assert.deepStrictEqual(
			(contributed.keybindings as { command: string }[]).filter((k) => k.command === 'herdr.cancelPlacement'),
			[{ command: 'herdr.cancelPlacement', key: 'escape', when: 'herdr.placingPane' }],
		);
		assert.deepStrictEqual(
			(contributed.menus.commandPalette as { command: string; when: string }[]).find((m) => m.command === 'herdr.cancelPlacement'),
			{ command: 'herdr.cancelPlacement', when: 'false' },
		);
		// Nothing is armed in the test host.
		await vscode.commands.executeCommand('herdr.cancelPlacement');
	});

	test('pane context: the title bar, the actions, and the schemes', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = ext.packageJSON.contributes;
		const icon = (c: string) => (contributed.commands as { command: string; icon?: string }[]).find((x) => x.command === c)?.icon;
		assert.strictEqual(icon('herdr.paneContext.pin'), '$(pin)');
		assert.strictEqual(icon('herdr.paneContext.unpin'), '$(pinned)');
		assert.strictEqual(icon('herdr.paneContext.refresh'), '$(refresh)');
		assert.strictEqual(icon('herdr.paneContext.addToWorkspace'), '$(root-folder-opened)');
		assert.strictEqual(icon('herdr.paneContext.splitPane'), '$(split-horizontal)');
		assert.strictEqual(icon('herdr.paneContext.showPane'), '$(window)');
		assert.strictEqual(icon('herdr.paneContext.openChanges'), '$(diff)');
		const title = contributed.menus['view/title'] as { command: string; when: string }[];
		assert.match(title.find((m) => m.command === 'herdr.paneContext.pin')!.when, /!herdr\.paneContextPinned/);
		assert.match(title.find((m) => m.command === 'herdr.paneContext.unpin')!.when, /(^|\s)herdr\.paneContextPinned/);
		for (const event of ['onFileSystem:herdr-container', 'onFileSystem:herdr-ssh']) {
			assert.ok((ext.packageJSON.activationEvents as string[]).includes(event), event);
		}
		await vscode.commands.executeCommand('herdr.paneContext.focus');
		await vscode.commands.executeCommand('herdr.paneContext.refresh');
		// Nothing is followed in the test host: the actions have nothing to do.
		await vscode.commands.executeCommand('herdr.paneContext.pin');
		await vscode.commands.executeCommand('herdr.paneContext.unpin');
		await vscode.commands.executeCommand('herdr.paneContext.splitPane');
		await vscode.commands.executeCommand('herdr.paneContext.showPane');
		// The real providers are registered, and turn away what discovery has not found.
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse('herdr-container://abcdefabcdef/etc/hosts'))), /Not a known dev container/);
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse('herdr-ssh://nohost/etc/hosts'))), /SSH host is not in herdr.sshHosts/);
		assert.strictEqual(vscode.workspace.fs.isWritableFileSystem('herdr-ssh'), true);
		assert.strictEqual(vscode.workspace.fs.isWritableFileSystem('herdr-container'), true);
		const left = await vscode.workspace.openTextDocument(vscode.Uri.parse('herdr-git://container:gone/r/a.ts?HEAD#2'));
		assert.strictEqual(left.getText(), '');
	});
});
