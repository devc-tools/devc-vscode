import * as vscode from 'vscode';

/** Placeholder for the Sessions view until herdr-sidebar fills it; empty, so the welcome text shows. */
class EmptyTreeProvider implements vscode.TreeDataProvider<never> {
	getTreeItem(element: never): vscode.TreeItem {
		return element;
	}

	getChildren(): never[] {
		return [];
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('herdr');
	context.subscriptions.push(output);
	output.appendLine('herdr-vscode activated');

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('herdr.sessions', new EmptyTreeProvider()),
	);
}

export function deactivate(): void {}
