import * as posix from 'path/posix';

/**
 * Detection and resolution of file paths printed in a dev container terminal.
 *
 * Pure: no vscode, no docker. The container-specific facts a path needs to be
 * resolved arrive as a PathContext so every case here is unit testable.
 */

/** A path-shaped run of text found in a terminal line. */
export interface PathCandidate {
  /** Offset of the whole match, including any :line:col suffix. */
  startIndex: number;
  /** Length of the whole match, so the link underlines the suffix too. */
  length: number;
  /** The path itself, suffix removed and still unresolved (may be ~ or relative). */
  raw: string;
  /** 1-based line from a :line or :line:col suffix. */
  line?: number;
  /** 1-based column from a :line:col suffix. */
  column?: number;
}

/** The container-side facts needed to turn a candidate into an absolute path. */
export interface PathContext {
  /**
   * Base for relative paths: where the terminal's host folder is mounted inside
   * the container. Undefined when it could not be determined, which makes every
   * relative path unresolvable rather than guessed.
   */
  cwd?: string;
  /** The container user's home, for ~. Undefined when it could not be read. */
  home?: string;
}

/**
 * A path segment. Deliberately conservative: no spaces (they would swallow the
 * rest of the line) and no ':' (it separates the line/column suffix).
 */
const SEGMENT = String.raw`[\w.@+-]+`;

/**
 * Either an absolute path with an optional leading ~, or a relative path —
 * which must contain a '/', so a bare word like "Makefile" is never a link.
 * A trailing (?::\d+){0,2} captures :line and :line:col.
 */
const PATH_PATTERN = String.raw`(?:~?(?:\/${SEGMENT})+|(?:${SEGMENT}\/)+${SEGMENT})(?::\d+){0,2}`;

/**
 * Characters that mean a match started mid-token, so what was found is a
 * fragment of something larger rather than a path: '~' from a ~user home, '$'
 * or '}' from an unexpanded variable, '/' or ':' from a URL. Expanding those
 * needs information we do not have, so they are dropped instead of guessed at.
 */
const TRUNCATED_AFTER = /[~$}:/\w.@+-]/;

/** Trailing sentence punctuation that is far more likely prose than filename. */
const TRAILING_PUNCTUATION = /\.+$/;

/**
 * Every path-shaped run in `line`. The regex is built per call because
 * provideTerminalLinks may be re-entered before an earlier call resolves, and a
 * shared /g regex would have its lastIndex reset underneath it.
 */
export function findPathCandidates(line: string): PathCandidate[] {
  const re = new RegExp(PATH_PATTERN, 'g');
  const candidates: PathCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    const text = match[0];
    const before = match.index > 0 ? line[match.index - 1] : '';
    if (before && TRUNCATED_AFTER.test(before)) {
      continue;
    }

    const { path, line: lineNo, column } = splitLineColumn(text);
    const raw = path.replace(TRAILING_PUNCTUATION, '');
    if (raw.length < 2 || !raw.includes('/')) {
      continue;
    }

    candidates.push({
      startIndex: match.index,
      // The link covers the suffix but not punctuation trimmed off the end.
      length: text.length - (path.length - raw.length),
      raw,
      line: lineNo,
      column,
    });
  }
  return candidates;
}

/** Split "src/a.ts:42:7" into its path, line and column. */
function splitLineColumn(text: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (!match) {
    return { path: text };
  }
  return {
    path: match[1],
    line: match[2] === undefined ? undefined : Number(match[2]),
    column: match[3] === undefined ? undefined : Number(match[3]),
  };
}

/**
 * The absolute container path a candidate points at, or undefined when it
 * cannot be resolved with certainty — an unknown home for ~, or an unknown
 * base for a relative path. Callers drop the link rather than fall back to '/',
 * which would otherwise turn "usr/bin/env" into a confident link to an
 * unrelated file.
 */
export function resolveCandidatePath(
  raw: string,
  context: PathContext
): string | undefined {
  if (raw.startsWith('/')) {
    return posix.normalize(raw);
  }
  if (raw === '~' || raw.startsWith('~/')) {
    return usableBase(context.home)
      ? posix.normalize(posix.join(context.home as string, raw.slice(1)))
      : undefined;
  }
  return usableBase(context.cwd)
    ? posix.normalize(posix.join(context.cwd as string, raw))
    : undefined;
}

/**
 * A base is usable only when it is absolute and not the container root.
 * Resolving against '/' is what makes an unrelated "etc/hosts" in some tool's
 * output look like a real file.
 */
function usableBase(base: string | undefined): boolean {
  return base !== undefined && base.startsWith('/') && base !== '/';
}
