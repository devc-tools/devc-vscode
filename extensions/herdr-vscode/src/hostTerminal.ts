import * as fs from 'fs';
import * as vscode from 'vscode';
import { Environment } from './environments';
import { BindMount, hostPathOf } from './paths';

/** True while the selected session runs in a dev container whose project folder is known. */
export const HOST_FOLDER_CONTEXT_KEY = 'herdr.sessionHasHostFolder';

/** The host terminal's name: `<folder name>`, or `<folder name> · <space>` for a space. */
export function hostTerminalName(env: Pick<Environment, 'label'>, space?: string): string {
	return space ? `${env.label} · ${space}` : env.label;
}

/** Where a host terminal starts: a space's directory on this machine when it is bind-mounted, else the project folder. */
export function hostTerminalFolder(localFolder: string, dir: string | undefined, mounts: readonly BindMount[]): string {
	return (dir && hostPathOf(dir, mounts)) || localFolder;
}

/**
 * A terminal on this machine in a dev container's project folder (its
 * `devcontainer.local_folder`), in the panel. Warns when the environment has no
 * such folder, or the folder is not on this machine.
 */
export function openHostTerminal(
	env: Pick<Environment, 'label' | 'localFolder'>,
	place: { folder?: string; space?: string } = {},
	exists: (dir: string) => boolean = isDirectory,
): vscode.Terminal | undefined {
	const folder = env.localFolder && (place.folder ?? env.localFolder);
	if (!folder) {
		void vscode.window.showWarningMessage('herdr: the selected session is not in a dev container.');
		return undefined;
	}
	if (!exists(folder)) {
		void vscode.window.showWarningMessage(`herdr: the project folder ${folder} is not on this machine.`);
		return undefined;
	}
	const terminal = vscode.window.createTerminal({
		name: hostTerminalName(env, place.space),
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
