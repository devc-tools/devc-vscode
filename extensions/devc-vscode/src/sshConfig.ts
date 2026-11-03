import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATTERN } from './sshFs';

/** How deep Include lines are followed; stops include cycles. */
const MAX_INCLUDE_DEPTH = 8;

/** The file system calls the parser makes. Injected for tests. */
export interface ConfigFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(dir: string): string[];
}

/** A line's words: whitespace separated, one layer of double quotes removed. */
function tokens(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}

/**
 * The files an Include argument names. Relative paths are under ~/.ssh, as
 * ssh reads them; only a `*` in the last path segment is expanded.
 */
function includeTargets(arg: string, home: string, files: ConfigFs): string[] {
  let target = arg;
  if (target.startsWith('~/')) {
    target = path.join(home, target.slice(2));
  } else if (!path.isAbsolute(target)) {
    target = path.join(home, '.ssh', target);
  }
  const base = path.basename(target);
  if (!base.includes('*')) {
    return [target];
  }
  const dir = path.dirname(target);
  const pattern = new RegExp(
    `^${base
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`
  );
  let names: string[];
  try {
    names = files.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(name => pattern.test(name))
    .sort()
    .map(name => path.join(dir, name));
}

function collect(
  file: string,
  depth: number,
  home: string,
  files: ConfigFs,
  out: string[]
): void {
  if (depth > MAX_INCLUDE_DEPTH) {
    return;
  }
  let text: string;
  try {
    text = files.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // `Keyword args` or `Keyword=args`.
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const keyword = m[1].toLowerCase();
    if (keyword === 'host') {
      out.push(
        ...tokens(m[2]).filter(
          token => !/[*?!]/.test(token) && HOST_PATTERN.test(token)
        )
      );
    } else if (keyword === 'include') {
      for (const arg of tokens(m[2])) {
        for (const target of includeTargets(arg, home, files)) {
          collect(target, depth + 1, home, files, out);
        }
      }
    }
  }
}

/**
 * The concrete host aliases in ~/.ssh/config and the files it includes, in
 * the order they appear, each once: no wildcard or negated patterns, and
 * nothing from Match blocks. A missing or unreadable file yields nothing.
 */
export function sshConfigAliases(
  home: string = os.homedir(),
  files: ConfigFs = fs
): string[] {
  const found: string[] = [];
  collect(path.join(home, '.ssh', 'config'), 0, home, files, found);
  const seen = new Set<string>();
  return found.filter(alias => {
    const key = alias.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
