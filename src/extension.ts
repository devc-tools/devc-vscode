import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { DevContainerFileSystemProvider } from './devcontainerFs';
import { execDocker } from './docker';

const SCHEME = 'devcontainer-filetree';

interface ContainerInfo {
	id: string
	name: string
}

interface BindMountMatch {
	containerName: string
	destPath: string
}

/** Regex for file paths in terminal output: /absolute/path.ext or relative/path.ext, optionally with :line:col */
const FILE_PATH_RE =
	/(?:(?:\/[\w.@-]+)+(?:\.\w+)?)|(?:(?:[\w.@-]+\/)+(?:[\w.@-]+\.\w+))(?::\d+)?(?::\d+)?/g;

class DevContainerTerminalLink extends vscode.TerminalLink {
	constructor(
		startIndex: number,
		length: number,
		tooltip: string,
		public readonly data: { path: string; containerId: string },
	) {
		super(startIndex, length, tooltip);
	}
}

let provider: DevContainerFileSystemProvider;
let dockerEventsProcess: cp.ChildProcess | undefined;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	provider = new DevContainerFileSystemProvider();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
			isCaseSensitive: true,
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devcontainer-filetree.openContainerFolder',
			() => openContainerFolder(provider),
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devcontainer-filetree.refresh', () => {
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (folder.uri.scheme === SCHEME) {
					provider.refresh(folder.uri);
				}
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devcontainer-filetree.openInDevContainer',
			async (uri: vscode.Uri) => {
				const cwd = uri?.fsPath;
				const t = vscode.window.createTerminal({
					name: 'devcontainer',
					cwd,
					location: vscode.TerminalLocation.Editor,
					isTransient: true,
				});
				t.sendText('devc herdr');
			},
		),
	);

	context.subscriptions.push(
		vscode.window.registerTerminalLinkProvider({
			async provideTerminalLinks(context) {
				// Only activate for terminals created by our "Open in Dev Container" command.
				const opts = context.terminal.creationOptions;
				if (!('name' in opts) || opts.name !== 'devcontainer') {
					return [];
				}
				const containerIds = getTrackedContainerIds();
				if (containerIds.size === 0) {
					return [];
				}
				const links: DevContainerTerminalLink[] = [];
				let match: RegExpExecArray | null;
				FILE_PATH_RE.lastIndex = 0;
				while ((match = FILE_PATH_RE.exec(context.line)) !== null) {
					if (match[0].length < 3) {
						continue;
					}
					const candidatePath = stripLineCol(match[0]);
					// Try each tracked container to see if the path exists.
					for (const containerId of containerIds) {
						const uri = vscode.Uri.from({
							scheme: SCHEME,
							authority: containerId,
							path: candidatePath,
						});
						try {
							await provider.stat(uri);
							links.push(
								new DevContainerTerminalLink(
									match.index,
									match[0].length,
									`Open in Dev Container`,
									{ path: match[0], containerId },
								),
							);
							break; // Found in one container, no need to check others.
						} catch {
							// Doesn't exist in this container — try next.
						}
					}
				}
				return links;
			},
			async handleTerminalLink(link) {
				const { path: filePath, containerId } = (
					link as DevContainerTerminalLink
				).data;
				const cleanPath = stripLineCol(filePath);
				const uri = vscode.Uri.from({
					scheme: SCHEME,
					authority: containerId,
					path: cleanPath,
				});
				try {
					const stat = await provider.stat(uri);
					if (stat.type === vscode.FileType.Directory) {
						await vscode.commands.executeCommand('revealInExplorer', uri);
					} else {
						vscode.window.showTextDocument(uri);
					}
				} catch {
					vscode.window.showTextDocument(uri);
				}
			},
		}),
	);

	// Auto-detect: if running containers have workspace folders bind-mounted,
	// open their container folders automatically.
	autoOpenContainers(provider).catch((err) => {
		console.error('devcontainer-filetree: auto-detect failed', err);
	});

	// Watch for container start/stop events.
	startDockerEventsWatcher();
}

export function deactivate() {
	if (dockerEventsProcess) {
		dockerEventsProcess.kill();
		dockerEventsProcess = undefined;
	}
}

// ── Commands ────────────────────────────────────────────────────────────────

async function openContainerFolder(
	provider: DevContainerFileSystemProvider,
): Promise<void> {
	const hostFolder = getHostFolders()[0];

	let container: ContainerInfo | undefined;
	try {
		container = await pickContainer(hostFolder);
	} catch (err) {
		vscode.window.showErrorMessage((err as Error).message);
		return;
	}
	if (!container) {
		vscode.window.showErrorMessage(
			'No running dev container found. Start one first (e.g. `devcontainer up --workspace-folder <path>`).',
		);
		return;
	}

	const guess = hostFolder ? `/workspaces/${path.basename(hostFolder)}` : '/';
	const remotePath = await vscode.window.showInputBox({
		prompt: `Path inside container ${container.name || container.id.slice(0, 12)}`,
		value: guess,
		validateInput: (v) =>
			v.startsWith('/') ? undefined : 'Path must be absolute',
	});
	if (remotePath === undefined) {
		return;
	}

	const uri = vscode.Uri.from({
		scheme: SCHEME,
		authority: container.id,
		path: remotePath,
	});

	// Fail fast before adding the folder to the workspace.
	try {
		const stat = await provider.stat(uri);
		if (stat.type !== vscode.FileType.Directory) {
			vscode.window.showErrorMessage(
				`${remotePath} is not a directory in container ${container.id.slice(0, 12)}`,
			);
			return;
		}
	} catch (err) {
		vscode.window.showErrorMessage(
			`Cannot open ${remotePath}: ${(err as Error).message}`,
		);
		return;
	}

	const index = vscode.workspace.workspaceFolders?.length ?? 0;
	vscode.workspace.updateWorkspaceFolders(index, 0, {
		uri,
		name: containerFolderLabel(container.name || container.id, path.basename(remotePath)),
	});
}

// ── Auto-detect ─────────────────────────────────────────────────────────────

/**
 * Auto-open containers for ALL workspace folders that are bind-mounted
 * in running containers and not yet tracked in the workspace.
 */
async function autoOpenContainers(
	_provider: DevContainerFileSystemProvider,
): Promise<void> {
	const hostFolders = getHostFolders();
	if (hostFolders.length === 0) {
		return;
	}

	const docker = getDockerCommand();

	// Get all running container IDs.
	const idsRes = await execDocker(['ps', '-q'], undefined, docker);
	if (idsRes.exitCode !== 0 || idsRes.stdout.toString('utf8').trim() === '') {
		return;
	}
	const ids = idsRes.stdout
		.toString('utf8')
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		return;
	}

	// For each host folder, find a matching container and add it.
	for (const hostFolder of hostFolders) {
		// Skip if this host folder is already tracked.
		if (await hasContainerForHostFolder(hostFolder)) {
			continue;
		}

		for (const id of ids) {
			const match = await findMatchingBindMount(id, hostFolder);
			if (match) {
				const uri = vscode.Uri.from({
					scheme: SCHEME,
					authority: id,
					path: '/',
				});
				const index = vscode.workspace.workspaceFolders?.length ?? 0;
				vscode.workspace.updateWorkspaceFolders(index, 0, {
					uri,
					name: containerFolderLabel(match.containerName || id, path.basename(hostFolder)),
				});
				break; // Found a match for this host folder, move to next.
			}
		}
	}
}

// ── Docker events watcher ───────────────────────────────────────────────────

function startDockerEventsWatcher(): void {
	const docker = getDockerCommand();
	const child = cp.spawn(
		docker,
		[
			'events',
			'--filter',
			'type=container',
			'--filter',
			'event=start',
			'--filter',
			'event=stop',
			'--filter',
			'event=die',
			'--format',
			'{{json .}}',
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);

	dockerEventsProcess = child;

	let buf = '';
	child.stdout?.on('data', (chunk: Buffer) => {
		buf += chunk.toString('utf8');
		let nl: number;
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) {
				handleDockerEvent(line).catch((err) => {
					console.error('devcontainer-filetree: event handling error', err);
				});
			}
		}
	});

	child.on('error', () => {
		// Docker not available — silently ignore.
	});

	child.on('close', () => {
		dockerEventsProcess = undefined;
	});
}

async function handleDockerEvent(jsonLine: string): Promise<void> {
	let event: {
		Type?: string
		Actor?: { ID?: string; Attributes?: Record<string, string> }
		Action?: string
	};
	try {
		event = JSON.parse(jsonLine);
	} catch {
		return;
	}

	if (event.Type !== 'container') {
		return;
	}

	const containerId = event.Actor?.ID;
	const action = event.Action;
	if (!containerId) {
		return;
	}

	if (action === 'start') {
		// Small delay — container may not be fully ready for inspect immediately.
		await new Promise((r) => setTimeout(r, 500));
		await onContainerStarted(containerId);
	} else if (action === 'stop' || action === 'die') {
		await onContainerStopped(containerId);
	}
}

/**
 * When a container starts, check all host folders to see if any match
 * and aren't already tracked, then add them to the workspace.
 */
async function onContainerStarted(containerId: string): Promise<void> {
	const hostFolders = getHostFolders();
	if (hostFolders.length === 0) {
		return;
	}

	for (const hostFolder of hostFolders) {
		// Skip if this host folder is already tracked.
		if (await hasContainerForHostFolder(hostFolder)) {
			continue;
		}

		const match = await findMatchingBindMount(containerId, hostFolder);
		if (match) {
			const uri = vscode.Uri.from({
				scheme: SCHEME,
				authority: containerId,
				path: '/',
			});
			const index = vscode.workspace.workspaceFolders?.length ?? 0;
			vscode.workspace.updateWorkspaceFolders(index, 0, {
				uri,
				name: containerFolderLabel(match.containerName || containerId, path.basename(hostFolder)),
			});
		}
	}
}

async function onContainerStopped(containerId: string): Promise<void> {
	const folders = vscode.workspace.workspaceFolders?.filter(
		(f) => f.uri.scheme === SCHEME && f.uri.authority === containerId,
	);
	if (!folders || folders.length === 0) {
		return;
	}

	const shortName = folders[0].name;
	const remove = 'Remove from Workspace';
	const keep = 'Keep';
	const choice = await vscode.window.showWarningMessage(
		`Container ${shortName} has stopped.`,
		remove,
		keep,
	);
	if (choice === remove) {
		const startIndex = vscode.workspace.workspaceFolders!.indexOf(folders[0]);
		vscode.workspace.updateWorkspaceFolders(startIndex, folders.length);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function containerFolderLabel(_containerName: string, projectName: string): string {
	return `[container] ${projectName}`;
}

function getDockerCommand(): string {
	return (
		vscode.workspace
			.getConfiguration('devcontainer-filetree')
			.get<string>('dockerPath') || 'docker'
	);
}

/** Return the fsPath of all file:// workspace folders. */
function getHostFolders(): string[] {
	return vscode.workspace.workspaceFolders
		?.filter((f) => f.uri.scheme === 'file')
		.map((f) => f.uri.fsPath) ?? [];
}

/** Return the set of container IDs that are already represented in the workspace. */
function getTrackedContainerIds(): Set<string> {
	const tracked = new Set<string>();
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		if (f.uri.scheme === SCHEME && f.uri.authority) {
			tracked.add(f.uri.authority);
		}
	}
	return tracked;
}

/**
 * Check whether a specific host folder already has a devcontainer workspace
 * entry. We inspect each existing devcontainer folder's bind mount to find
 * which host folder it maps to.
 */
async function hasContainerForHostFolder(hostFolder: string): Promise<boolean> {
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		if (f.uri.scheme !== SCHEME || !f.uri.authority) {
			continue;
		}
		const mounts = await getBindMounts(f.uri.authority);
		for (const mount of mounts) {
			if (mount.source === hostFolder) {
				return true;
			}
		}
	}
	return false;
}

interface BindMount {
	source: string
	dest: string
}

/** Return all bind mounts for a container. */
async function getBindMounts(containerId: string): Promise<BindMount[]> {
	const docker = getDockerCommand();
	const inspectRes = await execDocker(
		[
			'inspect',
			'--format',
			'{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\t{{.Destination}}\n{{end}}{{end}}',
			containerId,
		],
		undefined,
		docker,
	);
	if (inspectRes.exitCode !== 0) {
		return [];
	}
	const mounts: BindMount[] = [];
	for (const line of inspectRes.stdout.toString('utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const [source, dest] = trimmed.split('\t');
		if (source && dest) {
			mounts.push({ source, dest });
		}
	}
	return mounts;
}

/** Strip trailing :line or :line:col from a path string. */
function stripLineCol(filePath: string): string {
	const colonIdx = filePath.lastIndexOf(':');
	if (colonIdx > 0 && /^\d+(:\d+)?$/.test(filePath.slice(colonIdx + 1))) {
		return filePath.slice(0, colonIdx);
	}
	return filePath;
}

/**
 * Inspect a container and return its name plus the matching dest path
 * if any bind mount source matches `hostFolder`, undefined otherwise.
 */
async function findMatchingBindMount(
	containerId: string,
	hostFolder: string,
): Promise<BindMountMatch | undefined> {
	const docker = getDockerCommand();
	const inspectRes = await execDocker(
		[
			'inspect',
			'--format',
			'{{.Name}}{{"\t"}}{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\t"}}{{end}}{{end}}',
			containerId,
		],
		undefined,
		docker,
	);
	if (inspectRes.exitCode !== 0) {
		return undefined;
	}

	for (const line of inspectRes.stdout.toString('utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.startsWith('/')) {
			continue;
		}
		const parts = trimmed.split('\t');
		const containerName = parts[0];
		for (let i = 1; i + 1 < parts.length; i += 2) {
			if (parts[i] === hostFolder) {
				return { containerName, destPath: parts[i + 1] || '/' };
			}
		}
	}
	return undefined;
}

/**
 * Locate the dev container for the host workspace folder using the labels the
 * devcontainer CLI stamps on containers (devcontainer.local_folder). Falls back
 * to listing every container with devcontainer.config_file and letting the
 * user pick.
 */
async function pickContainer(
	hostFolder: string | undefined,
): Promise<ContainerInfo | undefined> {
	const format = '{{.ID}} {{.Names}}';

	if (hostFolder) {
		const matches = parseContainers(
			await ps([
				'--filter',
				`label=devcontainer.local_folder=${hostFolder}`,
				'--format',
				format,
			]),
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
		await ps([
			'--filter',
			'label=devcontainer.config_file',
			'--format',
			format,
		]),
	);
	if (all.length === 0) {
		return undefined;
	}
	return pickFrom(all);
}

async function ps(args: string[]): Promise<Buffer> {
	const docker = getDockerCommand();
	const res = await execDocker(['ps', ...args], undefined, docker);
	if (res.exitCode !== 0) {
		throw new Error(`docker ps failed: ${res.stderr.toString('utf8').trim()}`);
	}
	return res.stdout;
}

function parseContainers(stdout: Buffer): ContainerInfo[] {
	return stdout
		.toString('utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [id, name = ''] = line.split(/\s/, 2);
			return { id: id.trim(), name: name.trim() };
		});
}

async function pickFrom(
	containers: ContainerInfo[],
): Promise<ContainerInfo | undefined> {
	const picked = await vscode.window.showQuickPick(
		containers.map((c) => ({
			label: c.name || c.id.slice(0, 12),
			description: c.id.slice(0, 12),
			container: c,
		})),
		{ placeHolder: 'Select the dev container to open' },
	);
	return picked?.container;
}
