import * as assert from 'assert';
import * as vscode from 'vscode';

suite('herdr-vscode', () => {
	test('activates', async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode');
		assert.ok(extension, 'herdr-vscode is loaded');
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	test('contributes and registers the herdr.sessions view', async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode');
		assert.ok(extension);
		const views = extension.packageJSON.contributes.views.herdr as { id: string }[];
		assert.deepStrictEqual(views.map((v) => v.id), ['herdr.sessions']);
		await extension.activate();
		// Opening the view resolves its registered provider; an unregistered view would fail to focus.
		await vscode.commands.executeCommand('herdr.sessions.focus');
	});
});
