import * as fs from 'fs';
import * as vscode from 'vscode';
import { Environment } from './environments';

/** True while the selected session runs in a dev container whose project folder is known. */
export const HOST_FOLDER_CONTEXT_KEY = 'herdr.sessionHasHostFolder';

/** The host terminal's name: `<folder name> (host)`. */
export function hostTerminalName(env: Pick<Environment, 'label'>): string {
	return `${env.label} (host)`;
}

/**
 * A terminal on this machine in a dev container's project folder (its
 * `devcontainer.local_folder`), in the panel. Warns when the environment has no
 * such folder, or the folder is not on this machine.
 */
export function openHostTerminal(env: Pick<Environment, 'label' | 'localFolder'>, exists: (dir: string) => boolean = isDirectory): vscode.Terminal | undefined {
	const folder = env.localFolder;
	if (!folder) {
		void vscode.window.showWarningMessage('herdr: the selected session is not in a dev container.');
		return undefined;
	}
	if (!exists(folder)) {
		void vscode.window.showWarningMessage(`herdr: the project folder ${folder} is not on this machine.`);
		return undefined;
	}
	const terminal = vscode.window.createTerminal({
		name: hostTerminalName(env),
		cwd: folder,
		location: vscode.TerminalLocation.Panel,
	});
	terminal.show();
	return terminal;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
