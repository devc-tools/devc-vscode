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

	// Auto-detect: if a running container has the current workspace folder
	// bind-mounted, open its root folder automatically.
	autoOpenContainer(provider).catch(err => {
		console.error('devcontainer-filetree: auto-detect failed', err);
	});
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
 * On activation, check if any running container has the current workspace
 * folder bind-mounted. If exactly one match is found, open `/` in that
 * container automatically without any prompts.
 */
async function autoOpenContainer(provider: DevContainerFileSystemProvider): Promise<void> {
	const hostFolder = vscode.workspace.workspaceFolders
		?.find(f => f.uri.scheme === 'file')
		?.uri.fsPath;

	console.log('devcontainer-filetree: autoOpenContainer hostFolder=', hostFolder);

	if (!hostFolder) {
		console.log('devcontainer-filetree: no hostFolder, skipping');
		return;
	}

	// Don't auto-open if we already have a devcontainer folder in the workspace.
	const alreadyOpen = vscode.workspace.workspaceFolders?.some(f => f.uri.scheme === SCHEME);
	if (alreadyOpen) {
		console.log('devcontainer-filetree: already open, skipping');
		return;
	}

	const docker = vscode.workspace.getConfiguration('devcontainer-filetree').get<string>('dockerPath') || 'docker';
	console.log('devcontainer-filetree: docker command=', docker);

	// Get all running container IDs.
	const idsRes = await execDocker(['ps', '-q'], undefined, docker);
	console.log('devcontainer-filetree: ps exitCode=', idsRes.exitCode, 'stdout=', idsRes.stdout.toString('utf8'));
	if (idsRes.exitCode !== 0 || idsRes.stdout.toString('utf8').trim() === '') {
		return;
	}
	const ids = idsRes.stdout.toString('utf8').split('\n').map(s => s.trim()).filter(Boolean);
	console.log('devcontainer-filetree: container ids=', ids);
	if (ids.length === 0) {
		return;
	}

	// Inspect each container to find bind mounts matching the host folder.
	for (const id of ids) {
		const inspectRes = await execDocker(
			['inspect', '--format', '{{.Name}}{{"\t"}}{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\t"}}{{end}}{{end}}', id],
			undefined, docker
		);
		console.log('devcontainer-filetree: inspect', id, 'exitCode=', inspectRes.exitCode);
		if (inspectRes.exitCode !== 0) {
			continue;
		}

		const stdout = inspectRes.stdout.toString('utf8');
		console.log('devcontainer-filetree: inspect output (repr)=', JSON.stringify(stdout));

		for (const line of stdout.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('/')) {
				continue;
			}
			// Format: /containerName\t/source/path\t/dest/path\t...
			const parts = trimmed.split('\t');
			const containerName = parts[0];
			console.log('devcontainer-filetree: containerName=', containerName, 'parts count=', parts.length);
			// Check pairs: source, dest, source, dest, ...
			for (let i = 1; i + 1 < parts.length; i += 2) {
				const source = parts[i];
				console.log('devcontainer-filetree: checking source=', source, '===', hostFolder, '?', source === hostFolder);
				if (source === hostFolder) {
					console.log('devcontainer-filetree: MATCH found, opening container', id);
					const shortName = containerName.replace(/^\//, '') || id.slice(0, 12);
					const uri = vscode.Uri.from({ scheme: SCHEME, authority: id, path: '/' });
					const index = vscode.workspace.workspaceFolders?.length ?? 0;
					vscode.workspace.updateWorkspaceFolders(index, 0, {
						uri,
						name: `Dev Container (${shortName}): /`,
					});
					return;
				}
			}
		}
	}
	console.log('devcontainer-filetree: no matching container found');
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
