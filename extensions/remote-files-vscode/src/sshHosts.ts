// Ported from devc-vscode/src/sshFs.ts at 8f2844f; maintained separately.
// (`SshHostInfo`, `HOST_PATTERN` and `parseSshHosts` only.)

/** An SSH host from remoteFiles.sshHosts. */
export interface SshHostInfo {
  /** The ~/.ssh/config alias, as configured. */
  host: string;
  /** Tree label. */
  label: string;
  /** Absolute remote directory the tree starts at; undefined for the remote home. */
  root?: string;
}

/** An ssh alias: never an option, never a shell word that needs quoting. */
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The usable entries of a remoteFiles.sshHosts value, in order, and the
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

/** The configured entry for `host`, matched case-insensitively. */
export function findSshHost(
  hosts: SshHostInfo[],
  host: string
): SshHostInfo | undefined {
  const key = host.toLowerCase();
  return hosts.find(info => info.host.toLowerCase() === key);
}
