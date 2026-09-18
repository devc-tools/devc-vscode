import * as vscode from 'vscode';
import { execDocker, DockerExecResult } from './docker';

/**
 * FileSystemProvider that reads/writes files inside a running Docker container
 * (typically one started by the devcontainer CLI) by shelling out to
 * `docker exec <container> <coreutils>`.
 *
 * URI shape: devcontainer-filetree://<container-id-or-name>/<absolute path in container>
 *
 * Requires GNU coreutils/findutils in the container (stat, find, cat, mkdir,
 * rm, mv, rmdir) — true for typical dev container images (Debian/Ubuntu
 * based). BusyBox (Alpine) is not supported.
 */
export class DevContainerFileSystemProvider implements vscode.FileSystemProvider {

	// --- file metadata

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		// %F = type string, %s = size, %Y = mtime (epoch s), %W = birth time (epoch s, 0/- if unknown)
		const stdout = await this.exec(uri, ['stat', '-L', '-c', '%F\n%s\n%Y\n%W', '--', this.pathOf(uri)]);
		const lines = stdout.toString('utf8').split('\n');

		const mtime = (Number(lines[2]) || 0) * 1000;
		const btime = Number(lines[3]) || 0;

		let type: vscode.FileType;
		switch ((lines[0] ?? '').trim()) {
			case 'directory':
				type = vscode.FileType.Directory;
				break;
			case 'regular file':
			case 'regular empty file':
				type = vscode.FileType.File;
				break;
			case 'symbolic link':
				type = vscode.FileType.SymbolicLink;
				break;
			default:
				type = vscode.FileType.Unknown;
		}

		return {
			type,
			ctime: btime > 0 ? btime * 1000 : mtime,
			mtime,
			size: type === vscode.FileType.Directory ? 0 : (Number(lines[1]) || 0),
		};
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		// NUL-delimited "<name>\0<type-char>\0" pairs so names with spaces/newlines survive.
		// -L dereferences symlinks so %y reports the target's type.
		// NB: the format string must contain the two characters \0 (which find
		// interprets as NUL) — a literal NUL in argv is rejected by spawn().
		const stdout = await this.exec(uri, [
			'find', '-L', this.pathOf(uri),
			'-mindepth', '1', '-maxdepth', '1',
			'-printf', '%f\\0%y\\0',
		]);

		const parts = stdout.toString('utf8').split('\0');
		const result: [string, vscode.FileType][] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const name = parts[i];
			if (!name) {
				continue;
			}
			let type: vscode.FileType;
			switch (parts[i + 1]) {
				case 'd':
					type = vscode.FileType.Directory;
					break;
				case 'f':
					type = vscode.FileType.File;
					break;
				case 'l':
					type = vscode.FileType.SymbolicLink;
					break;
				default:
					type = vscode.FileType.Unknown;
			}
			result.push([name, type]);
		}
		return result;
	}

	// --- file contents

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return this.exec(uri, ['cat', '--', this.pathOf(uri)]);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		const existing = await this.tryStat(uri);
		if (existing && existing.type === vscode.FileType.Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (!existing && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (existing && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		// sh redirection (not tee) so the content isn't echoed back to stdout.
		// The path travels via argv ($1), never interpolated into the script.
		await this.exec(uri, ['sh', '-c', 'cat > "$1"', 'sh', this.pathOf(uri)], content);
		this._fireSoon({ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri });
	}

	// --- files/folders

	async createDirectory(uri: vscode.Uri): Promise<void> {
		if (await this.tryStat(uri)) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		// No -p: a missing parent must surface as FileNotFound per provider contract.
		await this.exec(uri, ['mkdir', '--', this.pathOf(uri)]);
		this._fireSoon({ type: vscode.FileChangeType.Created, uri });
	}

	async delete(uri: vscode.Uri, options: { recursive: boolean, useTrash?: boolean }): Promise<void> {
		const existing = await this.tryStat(uri);
		if (!existing) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (existing.type === vscode.FileType.Directory && !options.recursive) {
			await this.exec(uri, ['rmdir', '--', this.pathOf(uri)]);
		} else {
			await this.exec(uri, ['rm', '-rf', '--', this.pathOf(uri)]);
		}
		this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (oldUri.authority !== newUri.authority) {
			throw vscode.FileSystemError.NoPermissions('Cannot rename across containers');
		}
		if (!await this.tryStat(oldUri)) {
			throw vscode.FileSystemError.FileNotFound(oldUri);
		}
		if (!options.overwrite && await this.tryStat(newUri)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}
		await this.exec(oldUri, ['mv', '--', this.pathOf(oldUri), this.pathOf(newUri)]);
		this._fireSoon(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri },
		);
	}

	// --- watching (not supported; explorer gets explicit change events)

	watch(_resource: vscode.Uri): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}

	/** Fire a change event so VS Code re-reads the given path (used by the refresh command). */
	refresh(uri: vscode.Uri): void {
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
	}

	// --- docker plumbing

	private pathOf(uri: vscode.Uri): string {
		const path = uri.path;
		return path === '' ? '/' : path;
	}

	private async exec(uri: vscode.Uri, command: string[], input?: Uint8Array): Promise<Buffer> {
		const container = uri.authority;
		if (!container) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		let result: DockerExecResult;
		try {
			result = await execDocker(['exec', '-i', container, ...command], input, this.dockerCommand());
		} catch (err) {
			throw vscode.FileSystemError.Unavailable(`${uri.toString()}: ${(err as Error).message}`);
		}
		if (result.exitCode !== 0) {
			throw this.toFsError(uri, result.stderr.toString('utf8'));
		}
		return result.stdout;
	}

	private dockerCommand(): string {
		const configured = vscode.workspace.getConfiguration('devcontainer-filetree').get<string>('dockerPath');
		return configured && configured.trim() !== '' ? configured : 'docker';
	}

	private async tryStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
		try {
			return await this.stat(uri);
		} catch (err) {
			if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
				return undefined;
			}
			throw err;
		}
	}

	private toFsError(uri: vscode.Uri, stderr: string): Error {
		const msg = stderr.trim() || 'docker exec failed';
		if (/no such file or directory/i.test(msg)) {
			return vscode.FileSystemError.FileNotFound(uri);
		}
		if (/permission denied/i.test(msg)) {
			return vscode.FileSystemError.NoPermissions(uri);
		}
		if (/not a directory/i.test(msg)) {
			return vscode.FileSystemError.FileNotADirectory(uri);
		}
		if (/is a directory/i.test(msg)) {
			return vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (/file exists/i.test(msg)) {
			return vscode.FileSystemError.FileExists(uri);
		}
		if (/is not running|no such container/i.test(msg)) {
			return vscode.FileSystemError.Unavailable(uri);
		}
		return new Error(msg);
	}

	// --- file events

	private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: ReturnType<typeof setTimeout>;

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events);

		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle);
		}

		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents);
			this._bufferedEvents.length = 0;
		}, 5);
	}
}
