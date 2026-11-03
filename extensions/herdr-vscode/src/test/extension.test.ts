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

	test('contributes and registers the Sessions, Spaces, Agents and Active Pane views', async () => {
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
		assert.strictEqual(config.get('openPaneIn'), undefined);
	});

	test('agent filter commands set the filter', async () => {
		await extension().activate();
		await vscode.commands.executeCommand('herdr.agents.showBlocked');
		await vscode.commands.executeCommand('herdr.agents.showAll');
	});

	test('sidebar triage: Agents filter, done and scope commands, title bar, Start on containers', async () => {
		const ext = extension();
		await ext.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const c of ['herdr.agents.filter', 'herdr.agents.showDone', 'herdr.agents.scopeSession', 'herdr.agents.scopeAll']) {
			assert.ok(registered.has(c), c);
		}
		await vscode.commands.executeCommand('herdr.agents.showDone');
		await vscode.commands.executeCommand('herdr.agents.scopeSession');
		await vscode.commands.executeCommand('herdr.agents.scopeAll');
		await vscode.commands.executeCommand('herdr.agents.showAll');
		const contributed = ext.packageJSON.contributes;
		const commands = contributed.commands as { command: string; title: string; icon?: string; category?: string }[];
		const cmd = (id: string) => commands.find((c) => c.command === id);
		assert.deepStrictEqual(
			['herdr.agents.filter', 'herdr.agents.showDone', 'herdr.agents.scopeSession', 'herdr.agents.scopeAll'].map((id) => [cmd(id)?.title, cmd(id)?.category]),
			[
				['Filter Agents…', 'herdr'],
				['Show Done', 'herdr'],
				['Show Only the Selected Session', 'herdr'],
				['Show All Sessions', 'herdr'],
			],
		);
		const title = (contributed.menus['view/title'] as { command: string; when: string; group: string }[]).filter((m) => m.when.startsWith('view == herdr.agents'));
		assert.deepStrictEqual(
			title.map((m) => [m.group, m.command, cmd(m.command)?.icon, m.when]),
			[
				['navigation@1', 'herdr.agents.scopeSession', '$(globe)', 'view == herdr.agents && herdr.agentsScope != session'],
				['navigation@1', 'herdr.agents.scopeAll', '$(target)', 'view == herdr.agents && herdr.agentsScope == session'],
				['navigation@2', 'herdr.agents.filter', '$(filter)', 'view == herdr.agents'],
				['navigation@3', 'herdr.agents.showAll', '$(list-flat)', 'view == herdr.agents && herdr.agentsFilter != all'],
			],
		);
		const palette = (contributed.menus.commandPalette as { command: string }[]).map((m) => m.command);
		for (const c of ['herdr.agents.filter', 'herdr.agents.showDone', 'herdr.agents.scopeSession', 'herdr.agents.scopeAll']) {
			assert.ok(!palette.includes(c), `${c} is in the palette`);
		}
		const welcome = (contributed.viewsWelcome as { view: string; contents: string; when: string }[]).filter((w) => w.view === 'herdr.agents');
		assert.deepStrictEqual(welcome.map((w) => w.contents), ['No session selected.\n[Select Session](command:herdr.sessions.switch)', 'No agents.', 'No agents match this filter.']);
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

	test('Layout tabs are gone; pane rows: Open in herdr Space and Focus in herdr TUI', async () => {
		const ext = extension();
		await ext.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const c of ['herdr.newLayout', 'herdr.openLayout', 'herdr.renameLayout', 'herdr.deleteLayout', 'herdr.addToLayout', 'herdr.cancelPlacement']) {
			assert.ok(!registered.has(c), c);
		}
		const contributed = ext.packageJSON.contributes;
		assert.strictEqual(contributed.keybindings, undefined);
		assert.strictEqual(contributed.configuration.properties['herdr.openPaneIn'], undefined);
		assert.deepStrictEqual(
			(contributed.menus['view/item/context'] as { command: string }[])
				.map((m) => m.command)
				.filter((c) => !c.startsWith('herdr.paneContext.')),
			[
				'herdr.openHostTerminal',
				'herdr.newSpace',
				'herdr.sessions.start',
				'herdr.sessions.stop',
				'herdr.sessions.delete',
				'herdr.openHostTerminal',
				'herdr.closeSpace',
				'herdr.closeTab',
				'herdr.closePane',
				'herdr.openPaneTab',
				'herdr.focusPane',
			],
		);
		const focus = (contributed.commands as { command: string; title: string }[]).find((c) => c.command === 'herdr.focusPane');
		assert.strictEqual(focus?.title, 'Focus in herdr TUI');
	});

	test('tile context menu: Split Right, Split Down, Zoom / Unzoom, Close Pane, hidden from the palette', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = ext.packageJSON.contributes;
		const tile = "webviewId == 'herdr.tiles' && webviewSection == 'tile'";
		assert.deepStrictEqual(contributed.menus['webview/context'], [
			{ command: 'herdr.tile.splitRight', when: tile, group: '1_split@1' },
			{ command: 'herdr.tile.splitDown', when: tile, group: '1_split@2' },
			{ command: 'herdr.tile.zoom', when: `${tile} && !zoomed`, group: '2_view@1' },
			{ command: 'herdr.tile.unzoom', when: `${tile} && zoomed`, group: '2_view@1' },
			{ command: 'herdr.tile.close', when: tile, group: '3_close@1' },
		]);
		const titles = Object.fromEntries((contributed.commands as { command: string; title: string }[]).map((c) => [c.command, c.title]));
		assert.deepStrictEqual(
			['herdr.tile.splitRight', 'herdr.tile.splitDown', 'herdr.tile.zoom', 'herdr.tile.unzoom', 'herdr.tile.close'].map((c) => titles[c]),
			['Split Right', 'Split Down', 'Zoom', 'Unzoom', 'Close Pane'],
		);
		const hidden = (contributed.menus.commandPalette as { command: string; when: string }[]).filter((m) => m.command.startsWith('herdr.tile.'));
		assert.strictEqual(hidden.length, 5);
		assert.ok(hidden.every((m) => m.when === 'false'));
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const c of ['herdr.tile.splitRight', 'herdr.tile.splitDown', 'herdr.tile.zoom', 'herdr.tile.unzoom', 'herdr.tile.close']) {
			assert.ok(registered.has(c), c);
		}
		// No panel shows that pane: a warning, nothing else.
		await vscode.commands.executeCommand('herdr.tile.splitRight', { webviewSection: 'tile', paneKey: 'host/none|w1:p1' });
	});

	test('pane context: the title bar, the actions, and the schemes', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = ext.packageJSON.contributes;
		const icon = (c: string) => (contributed.commands as { command: string; icon?: string }[]).find((x) => x.command === c)?.icon;
		assert.strictEqual(icon('herdr.paneContext.refresh'), '$(refresh)');
		assert.strictEqual(icon('herdr.paneContext.addToWorkspace'), '$(root-folder-opened)');
		assert.strictEqual(icon('herdr.paneContext.showPane'), '$(window)');
		assert.strictEqual(icon('herdr.paneContext.openChanges'), '$(diff)');
		for (const event of ['onFileSystem:herdr-container', 'onFileSystem:herdr-ssh']) {
			assert.ok((ext.packageJSON.activationEvents as string[]).includes(event), event);
		}
		await vscode.commands.executeCommand('herdr.paneContext.focus');
		await vscode.commands.executeCommand('herdr.paneContext.refresh');
		// Nothing is followed in the test host: the actions have nothing to do.
		await vscode.commands.executeCommand('herdr.paneContext.showPane');
		// The real providers are registered, and turn away what discovery has not found.
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse('herdr-container://abcdefabcdef/etc/hosts'))), /Not a known dev container/);
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse('herdr-ssh://nohost/etc/hosts'))), /SSH host is not in herdr.sshHosts/);
		assert.strictEqual(vscode.workspace.fs.isWritableFileSystem('herdr-ssh'), true);
		assert.strictEqual(vscode.workspace.fs.isWritableFileSystem('herdr-container'), true);
		const left = await vscode.workspace.openTextDocument(vscode.Uri.parse('herdr-git://container:gone/r/a.ts?HEAD#2'));
		assert.strictEqual(left.getText(), '');
	});

	test('ask agent: commands, menus and when clauses; no devc ids', async () => {
		const ext = extension();
		await ext.activate();
		const contributed = ext.packageJSON.contributes;
		const ids = ['herdr.askAgent', 'herdr.agentReview.submit', 'herdr.agentReview.showAgent', 'herdr.agentReview.delete', 'herdr.agentReview.resend'];
		const commands = contributed.commands as { command: string; title: string; icon?: string }[];
		assert.deepStrictEqual(
			ids.map((id) => {
				const c = commands.find((x) => x.command === id);
				return [c?.title, c?.icon];
			}),
			[
				['Ask herdr Agent About Selection', undefined],
				['Ask Agent', undefined],
				['Show Agent', '$(terminal)'],
				['Delete Thread', '$(trash)'],
				['Resend', undefined],
			],
		);
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const id of ids) {
			assert.ok(registered.has(id), id);
		}
		const menu = (name: string) => (contributed.menus[name] as { command: string; when: string; group?: string }[]).map((m) => [m.command, m.when, m.group]);
		assert.deepStrictEqual(menu('editor/context'), [
			['herdr.askAgent', 'herdr.hasAgents && resourceScheme =~ /^(file|git|review|pr|herdr-container|herdr-ssh|herdr-git)$/', 'herdr@1'],
		]);
		assert.deepStrictEqual(menu('comments/commentThread/context'), [['herdr.agentReview.submit', 'commentController == herdr.agentReview', undefined]]);
		assert.deepStrictEqual(menu('comments/commentThread/title'), [
			['herdr.agentReview.showAgent', 'commentController == herdr.agentReview && commentThread =~ /hasAgent/', 'inline'],
			['herdr.agentReview.delete', 'commentController == herdr.agentReview', 'inline'],
		]);
		assert.deepStrictEqual(menu('comments/comment/title'), [['herdr.agentReview.resend', 'commentController == herdr.agentReview && comment == failed', 'inline']]);
		const palette = menu('commandPalette').filter(([c]) => ids.includes(c!));
		assert.deepStrictEqual(palette, [
			['herdr.askAgent', 'herdr.hasAgents && editorIsOpen', undefined],
			['herdr.agentReview.submit', 'false', undefined],
			['herdr.agentReview.showAgent', 'false', undefined],
			['herdr.agentReview.delete', 'false', undefined],
			['herdr.agentReview.resend', 'false', undefined],
		]);
		// The editor/context regex as VS Code reads it.
		const scheme = new RegExp(/resourceScheme =~ \/(.*)\/$/.exec(menu('editor/context')[0][1]!)![1]);
		for (const ok of ['file', 'git', 'review', 'pr', 'herdr-container', 'herdr-ssh', 'herdr-git']) {
			assert.ok(scheme.test(ok), ok);
		}
		for (const no of ['untitled', 'vscode-remote', 'gitx', 'xfile']) {
			assert.ok(!scheme.test(no), no);
		}
		const everyId = JSON.stringify(contributed).match(/"(?:command|id|view)":"[^"]*"/g) ?? [];
		assert.deepStrictEqual(everyId.filter((x) => x.includes('"devc-')), []);
		assert.ok(!(ext.packageJSON.activationEvents as string[]).some((e) => e.includes('agentReview')), 'no new activation events');
	});

	test('ask agent: the command runs with no agent (discovery off)', async () => {
		await extension().activate();
		const doc = await vscode.workspace.openTextDocument({ content: 'x' });
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('herdr.askAgent');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});
