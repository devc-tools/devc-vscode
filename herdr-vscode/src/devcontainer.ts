// Copied from devc-vscode/src/herdr.ts at fb5ecae; maintained separately.
// (`remoteUserFromMetadata`, `getRemoteUser` and their helpers; `listDevcontainers` is new.)

import { execDocker } from './docker';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The user the devcontainer CLI execs as, from the devcontainer.metadata label.
 * herdr's socket lives under that user's home, so the watcher must run as them
 * rather than as whatever user the image defaults to. Later entries override
 * earlier ones, as they do for the CLI.
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

// ── New in herdr-vscode ─────────────────────────────────────────────────────

/** A running dev container, as `docker ps` lists it. */
export interface Devcontainer {
  /** The container id (`docker ps` prints the first 12 characters). */
  id: string;
  /** The `devcontainer.local_folder` label: the project folder on the host. */
  localFolder: string;
  name: string;
}

export const DEVCONTAINER_PS_ARGS = [
  'ps',
  '--filter',
  'label=devcontainer.local_folder',
  '--format',
  '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.Names}}',
];

/** `docker ps` output (see {@link DEVCONTAINER_PS_ARGS}) as containers; bad lines are skipped. */
export function parseDevcontainerList(stdout: string): Devcontainer[] {
  const out: Devcontainer[] = [];
  for (const line of stdout.split('\n')) {
    const [id, localFolder, name] = line.trim().split('\t');
    if (!id || !localFolder) {
      continue;
    }
    out.push({ id, localFolder, name: name ?? '' });
  }
  return out;
}

/**
 * Every running dev container. No Docker (it cannot be started, or it
 * fails) means none.
 */
export async function listDevcontainers(
  dockerCommand: string
): Promise<Devcontainer[]> {
  try {
    const res = await execDocker(
      DEVCONTAINER_PS_ARGS,
      undefined,
      dockerCommand,
      15000
    );
    return res.exitCode === 0
      ? parseDevcontainerList(res.stdout.toString('utf8'))
      : [];
  } catch {
    return [];
  }
}
