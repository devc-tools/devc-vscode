import * as path from 'path';
import * as vscode from 'vscode';
import { DevContainerFileSystemProvider } from './devcontainerFs';
import { execDocker } from './docker';

const SCHEME = 'devcontainer-filetree';

interface ContainerInfo {
	id: string;
	name: string;
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new DevContainerFileSystemProvider();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true })
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devcontainer-filetree.openContainerFolder', () => openContainerFolder(provider))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devcontainer-filetree.refresh', () => {
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (folder.uri.scheme === SCHEME) {
					provider.refresh(folder.uri);
				}
			}
		})
	);
}

async function openContainerFolder(provider: DevContainerFileSystemProvider): Promise<void> {
	const hostFolder = vscode.workspace.workspaceFolders
		?.find(f => f.uri.scheme === 'file')
		?.uri.fsPath;

	let container: ContainerInfo | undefined;
	try {
		container = await pickContainer(hostFolder);
	} catch (err) {
		vscode.window.showErrorMessage((err as Error).message);
		return;
	}
	if (!container) {
		vscode.window.showErrorMessage(
			'No running dev container found. Start one first (e.g. `devcontainer up --workspace-folder <path>`).'
		);
		return;
	}

	const guess = hostFolder ? `/workspaces/${path.basename(hostFolder)}` : '/';
	const remotePath = await vscode.window.showInputBox({
		prompt: `Path inside container ${container.name || container.id.slice(0, 12)}`,
		value: guess,
		validateInput: v => v.startsWith('/') ? undefined : 'Path must be absolute',
	});
	if (remotePath === undefined) {
		return;
	}

	const uri = vscode.Uri.from({ scheme: SCHEME, authority: container.id, path: remotePath });

	// Fail fast before adding the folder to the workspace.
	try {
		const stat = await provider.stat(uri);
		if (stat.type !== vscode.FileType.Directory) {
			vscode.window.showErrorMessage(`${remotePath} is not a directory in container ${container.id.slice(0, 12)}`);
			return;
		}
	} catch (err) {
		vscode.window.showErrorMessage(`Cannot open ${remotePath}: ${(err as Error).message}`);
		return;
	}

	const shortName = container.name || container.id.slice(0, 12);
	const index = vscode.workspace.workspaceFolders?.length ?? 0;
	vscode.workspace.updateWorkspaceFolders(index, 0, {
		uri,
		name: `Dev Container (${shortName}): ${remotePath}`,
	});
}

/**
 * Locate the dev container for the host workspace folder using the labels the
 * devcontainer CLI stamps on containers (devcontainer.local_folder). Falls back
 * to listing every container with devcontainer.config_file and letting the
 * user pick.
 */
async function pickContainer(hostFolder: string | undefined): Promise<ContainerInfo | undefined> {
	const format = '{{.ID}} {{.Names}}';

	if (hostFolder) {
		const matches = parseContainers(
			await ps(['--filter', `label=devcontainer.local_folder=${hostFolder}`, '--format', format])
		);
		if (matches.length === 1) {
			return matches[0];
		}
		if (matches.length > 1) {
			return pickFrom(matches);
		}
	}

	// Fallback: any running dev container on this host.
	const all = parseContainers(
		await ps(['--filter', 'label=devcontainer.config_file', '--format', format])
	);
	if (all.length === 0) {
		return undefined;
	}
	return pickFrom(all);
}

async function ps(args: string[]): Promise<Buffer> {
	const docker = vscode.workspace.getConfiguration('devcontainer-filetree').get<string>('dockerPath') || 'docker';
	const res = await execDocker(['ps', ...args], undefined, docker);
	if (res.exitCode !== 0) {
		throw new Error(`docker ps failed: ${res.stderr.toString('utf8').trim()}`);
	}
	return res.stdout;
}

function parseContainers(stdout: Buffer): ContainerInfo[] {
	// Docker names never contain whitespace, so a single space is a safe delimiter.
	return stdout.toString('utf8')
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line => {
			const [id, name = ''] = line.split(/\s/, 2);
			return { id: id.trim(), name: name.trim() };
		});
}

async function pickFrom(containers: ContainerInfo[]): Promise<ContainerInfo | undefined> {
	const picked = await vscode.window.showQuickPick(
		containers.map(c => ({
			label: c.name || c.id.slice(0, 12),
			description: c.id.slice(0, 12),
			container: c,
		})),
		{ placeHolder: 'Select the dev container to open' }
	);
	return picked?.container;
}

export function deactivate() { }
