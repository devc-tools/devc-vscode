// Ported from devc-vscode/src/containerTree.ts and src/herdr.ts at 8f2844f; maintained separately.
// (Dev container discovery, root labels and the remote user; the `all` scope is new.)

import * as posix from 'path/posix';
import { execDocker } from './docker';

/** A running dev container shown as a root. */
export interface ContainerInfo {
  /** The 12-char short id `docker ps` prints; the URI authority. */
  id: string;
  /** Tree label. */
  name: string;
  /** Docker's own name for the container. */
  containerName: string;
  /** The devcontainer.local_folder label: the project folder on the host. */
  localFolder: string;
}

/** Which running dev containers are roots (remoteFiles.containers). */
export type ContainerScope = 'workspace' | 'all';

/** A running container that carries a devcontainer.local_folder label. */
export interface LabelledContainer {
  id: string;
  containerName: string;
  localFolder: string;
}

/** Drop a trailing slash so '/a/' and '/a' compare equal. '/' stays '/'. */
export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '') || '/';
  }
  return path === '' ? '/' : path;
}

/** Whether `target` is `base` or sits underneath it. */
export function isPathWithin(base: string, target: string): boolean {
  const b = normalizePath(base);
  const t = normalizePath(target);
  if (b === '/') {
    return true;
  }
  return t === b || t.startsWith(`${b}/`);
}

/**
 * The tree label for a container's root: the workspace folder's basename, plus
 * the path down to the project when the container serves a subfolder rather
 * than the workspace folder itself.
 */
export function rootLabel(hostFolder: string, localFolder: string): string {
  const base = posix.basename(hostFolder) || hostFolder;
  if (normalizePath(hostFolder) === normalizePath(localFolder)) {
    return base;
  }
  return posix.join(base, posix.relative(hostFolder, localFolder));
}

/** `docker ps` for every running container with a devcontainer.local_folder label. */
export const DEV_CONTAINER_ARGS = [
  'ps',
  '--filter',
  'label=devcontainer.local_folder',
  '--format',
  '{{.ID}}\t{{.Names}}\t{{.Label "devcontainer.local_folder"}}',
];

/**
 * DEV_CONTAINER_ARGS output, one container per line. Tab-delimited because
 * host paths can contain spaces.
 */
export function parseDevContainers(stdout: string): LabelledContainer[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t').map(field => field.trim()))
    .filter(fields => fields.length >= 3 && fields[0] && fields[2])
    .map(([id, containerName, localFolder]) => ({
      id: id.slice(0, 12),
      containerName,
      localFolder,
    }));
}

/**
 * The roots among `labelled`, in display order (label, then Docker name).
 *
 * - `workspace`: a container whose project folder is one of `hostFolders` or
 *   under one; the most specific folder labels it.
 * - `all`: every container, labelled by its project folder's basename.
 */
export function scopeContainers(
  labelled: LabelledContainer[],
  scope: ContainerScope,
  hostFolders: string[]
): ContainerInfo[] {
  const found = new Map<string, ContainerInfo>();
  for (const container of labelled) {
    if (found.has(container.id)) {
      continue;
    }
    let name: string;
    if (scope === 'all') {
      name =
        posix.basename(normalizePath(container.localFolder)) ||
        container.containerName ||
        container.id;
    } else {
      const owner = hostFolders
        .filter(folder => isPathWithin(folder, container.localFolder))
        .sort((a, b) => b.length - a.length)[0];
      if (owner === undefined) {
        continue;
      }
      name = rootLabel(owner, container.localFolder);
    }
    found.set(container.id, {
      id: container.id,
      name,
      containerName: container.containerName,
      localFolder: container.localFolder,
    });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.containerName.localeCompare(b.containerName)
  );
}

/**
 * The running dev containers that are roots. Docker that cannot be run, or
 * fails, gives none.
 */
export async function listDevContainers(
  dockerCommand: string,
  scope: ContainerScope,
  hostFolders: string[]
): Promise<ContainerInfo[]> {
  if (scope === 'workspace' && hostFolders.length === 0) {
    return [];
  }
  let stdout: string;
  try {
    const res = await execDocker(DEV_CONTAINER_ARGS, undefined, dockerCommand);
    if (res.exitCode !== 0) {
      return [];
    }
    stdout = res.stdout.toString('utf8');
  } catch {
    return [];
  }
  return scopeContainers(parseDevContainers(stdout), scope, hostFolders);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The user a dev container's tools run as, from its devcontainer.metadata
 * label: the last remoteUser, else the last containerUser.
 */
export function remoteUserFromMetadata(label: string): string | undefined {
  let entries: unknown;
  try {
    entries = JSON.parse(label);
  } catch {
    return undefined;
  }
  let user: string | undefined;
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (!isObject(entry)) {
      continue;
    }
    user = stringOr(entry.remoteUser) ?? stringOr(entry.containerUser) ?? user;
  }
  return user;
}

/** A container's remote user; undefined runs as Docker's default user. */
export async function getRemoteUser(
  containerId: string,
  dockerCommand: string
): Promise<string | undefined> {
  let res;
  try {
    res = await execDocker(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "devcontainer.metadata"}}',
        containerId,
      ],
      undefined,
      dockerCommand
    );
  } catch {
    return undefined;
  }
  if (res.exitCode !== 0) {
    return undefined;
  }
  return remoteUserFromMetadata(res.stdout.toString('utf8').trim());
}
