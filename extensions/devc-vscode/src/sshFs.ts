import * as vscode from 'vscode';
import { CoreutilsFileSystemProvider } from './devcontainerFs';
import {
  RemoteShell,
  ShellResult,
  SshHostNotAllowedError,
  sshFailure,
} from './remoteShell';

export const SSH_SCHEME = 'devc-ssh';

/** An SSH host from devc-vscode.sshHosts. */
export interface SshHostInfo {
  /** The ~/.ssh/config alias, as configured. */
  host: string;
  /** Tree and picker label. */
  label: string;
  /** Absolute remote directory to start in; undefined for the remote home. */
  root?: string;
}

/** An ssh alias: never an option, never a shell word that needs quoting. */
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The usable entries of a devc-vscode.sshHosts value, in order, and the
 * hosts of the entries dropped: malformed, a bad host or root, or a host
 * already listed.
 */
export function parseSshHosts(raw: unknown): {
  hosts: SshHostInfo[];
  invalid: string[];
} {
  const hosts: SshHostInfo[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const host =
      typeof entry === 'object' && entry && typeof entry.host === 'string'
        ? entry.host
        : undefined;
    const root = typeof entry?.root === 'string' ? entry.root : undefined;
    const label =
      typeof entry?.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : undefined;
    if (
      host === undefined ||
      !HOST_PATTERN.test(host) ||
      (root !== undefined && !root.startsWith('/')) ||
      seen.has(host.toLowerCase())
    ) {
      invalid.push(host ?? String(JSON.stringify(entry)));
      continue;
    }
    seen.add(host.toLowerCase());
    hosts.push({ host, label: label ?? host, root });
  }
  return { hosts, invalid };
}

export function sshUri(host: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SSH_SCHEME,
    authority: host,
    path: path === '' ? '/' : path,
  });
}

/**
 * Files on an SSH host, through `ssh <host> <coreutils>`.
 *
 * URI shape: devc-ssh://<ssh config alias>/<absolute remote path>
 *
 * The authority becomes an ssh argument, and any devc-ssh:// URI from
 * anywhere reaches this provider, so a host that is not configured is
 * refused before anything is spawned.
 */
export class SshFileSystemProvider extends CoreutilsFileSystemProvider {
  protected readonly crossAuthorityMessage = 'Cannot rename across SSH hosts';
  protected readonly execFailedMessage = 'ssh command failed';

  constructor(
    private readonly shells: (host: string) => RemoteShell,
    /** Whether a host is configured. */
    private readonly allowed: (host: string) => boolean
  ) {
    super();
  }

  protected shellFor(uri: vscode.Uri): RemoteShell {
    if (!uri.authority || !this.allowed(uri.authority)) {
      throw vscode.FileSystemError.NoPermissions(
        new SshHostNotAllowedError(uri.authority).message
      );
    }
    return this.shells(uri.authority);
  }

  protected toFsError(uri: vscode.Uri, result: ShellResult): Error {
    const failure = sshFailure(uri.authority, result);
    return failure
      ? vscode.FileSystemError.Unavailable(failure)
      : super.toFsError(uri, result);
  }
}
