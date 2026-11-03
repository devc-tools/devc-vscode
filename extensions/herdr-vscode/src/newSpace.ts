import * as path from 'path';
import * as vscode from 'vscode';
import { Environment } from './environments';
import { BindMount, CONTAINER_SCHEME, containerPathOf, environmentUri, resolveLinkPath, SSH_SCHEME } from './paths';
import { Snapshot } from './sessions';
import { spaceCwd } from './sessionControl';

/** **New Space**: which directory the new space starts in, in the session's environment. */

export const NEW_SPACE_TITLE = 'New herdr Space';
export const NEW_SPACE_PLACEHOLDER = 'Directory for the new space (type a path, or Browse…)';
export const BROWSE_LABEL = '$(folder-opened) Browse…';

type DirEnv = Pick<Environment, 'kind' | 'alias' | 'containerId' | 'label'>;

/**
 * Directories offered, without repeats: the focused space's, the other spaces',
 * VS Code's workspace folders that are in this environment, then home.
 */
export function newSpaceCandidates(snapshot: Snapshot | undefined, workspaceDirs: readonly string[], home: string | undefined): string[] {
	const spaces = snapshot ? [...snapshot.workspaces].sort((a, b) => Number(b.focused) - Number(a.focused) || a.number - b.number) : [];
	const dirs = [...spaces.map((w) => spaceCwd(snapshot!, w.workspace_id)), ...workspaceDirs, home];
	return [...new Set(dirs.filter((d): d is string => typeof d === 'string' && d.startsWith('/')).map((d) => d.replace(/(.)\/+$/, '$1')))];
}

/** A folder VS Code knows (a workspace folder, a Browse… pick) as a path in the environment; undefined when it is not there. */
export function environmentPathOf(uri: vscode.Uri, env: DirEnv, mounts: readonly BindMount[]): string | undefined {
	switch (env.kind) {
		case 'host':
			return uri.scheme === 'file' ? uri.fsPath : undefined;
		case 'ssh':
			return uri.scheme === SSH_SCHEME && uri.authority === env.alias ? uri.path : undefined;
		case 'container':
			if (uri.scheme === 'file') {
				return containerPathOf(uri.fsPath, mounts);
			}
			return uri.scheme === CONTAINER_SCHEME && !!env.containerId && uri.authority === env.containerId.slice(0, 12) ? uri.path : undefined;
	}
}

/** `~` as the home; the rest of `/`-rooted paths as typed. Undefined for anything else. */
export function typedDirectory(value: string, home: string | undefined): string | undefined {
	const text = value.trim();
	if (text === '~') {
		return home;
	}
	if (!text.startsWith('/') && !text.startsWith('~/')) {
		return undefined;
	}
	return resolveLinkPath(text, undefined, home);
}

/** `~/src/api` for a path under the home. */
function shortPath(dir: string, home: string | undefined): string {
	if (home && (dir === home || dir.startsWith(`${home}/`))) {
		return `~${dir.slice(home.length)}`;
	}
	return dir;
}

export interface PickDirectoryDeps {
	env: DirEnv;
	snapshot: Snapshot | undefined;
	mounts: readonly BindMount[];
	home: string | undefined;
}

type Item = vscode.QuickPickItem & { dir?: string; browse?: true };

/** Picks the directory; undefined when cancelled. */
export async function pickSpaceDirectory(deps: PickDirectoryDeps): Promise<string | undefined> {
	const { env, mounts, home } = deps;
	const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => environmentPathOf(f.uri, env, mounts)).filter((d): d is string => !!d);
	const candidates = newSpaceCandidates(deps.snapshot, workspaceDirs, home);
	const fixed: Item[] = [
		...candidates.map((dir): Item => ({ label: `$(folder) ${path.posix.basename(dir) || dir}`, description: shortPath(dir, home), dir })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: BROWSE_LABEL, browse: true, alwaysShow: true },
	];

	const qp = vscode.window.createQuickPick<Item>();
	qp.title = NEW_SPACE_TITLE;
	qp.placeholder = NEW_SPACE_PLACEHOLDER;
	qp.matchOnDescription = true;
	qp.items = fixed;
	qp.onDidChangeValue((value) => {
		const typed = typedDirectory(value, home);
		qp.items = typed ? [{ label: `$(arrow-right) ${value.trim()}`, description: 'Use this path', dir: typed, alwaysShow: true }, ...fixed] : fixed;
	});

	const picked = await new Promise<Item | undefined>((resolve) => {
		qp.onDidAccept(() => resolve(qp.selectedItems[0]));
		qp.onDidHide(() => resolve(undefined));
		qp.show();
	});
	qp.dispose();
	if (!picked?.browse) {
		return picked?.dir;
	}

	const start = candidates[0] ?? home;
	const chosen = await vscode.window.showOpenDialog({
		title: NEW_SPACE_TITLE,
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: 'Create Space Here',
		...(start ? { defaultUri: environmentUri(env, start, mounts) } : {}),
	});
	if (!chosen?.[0]) {
		return undefined;
	}
	const dir = environmentPathOf(chosen[0], env, mounts);
	if (!dir) {
		void vscode.window.showWarningMessage(`herdr: ${chosen[0].fsPath} is not in ${env.label}.`);
	}
	return dir;
}
