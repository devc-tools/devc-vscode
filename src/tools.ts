import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Which of the extension's optional host tools are here. Every one is
 * optional: commands and pickers offer only what the tools present can do.
 * Host herdr is checked in hostHerdr (hostHerdrInstalled); herdr in a
 * container or on an SSH host is checked per environment, as it is used.
 */

/** A tool check that takes longer than this counts the tool as absent. */
const CHECK_TIMEOUT_MS = 5000;

/**
 * Whether the Docker CLI runs. `--version` never contacts the daemon, so a
 * stopped daemon still counts as present.
 */
export function dockerInstalled(dockerCommand: string): Promise<boolean> {
  return new Promise(resolve => {
    cp.execFile(
      dockerCommand,
      ['--version'],
      { timeout: CHECK_TIMEOUT_MS },
      err => resolve(!err)
    );
  });
}

/**
 * Where devc is: the first executable `devc` in `~/.local/bin` (where its
 * installer puts it, and often missing from the PATH of a VS Code launched
 * from the Dock), then each PATH entry. A shell function or alias of that
 * name is invisible here; a command setting set by hand covers those.
 */
export async function findDevc(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? os.homedir(),
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  const names = platform === 'win32' ? ['devc.exe', 'devc.cmd'] : ['devc'];
  const dirs = [
    path.join(home, '.local', 'bin'),
    ...(env.PATH ?? '').split(path.delimiter),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        if ((await fs.promises.stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

/** The values of a setting that `WorkspaceConfiguration.inspect` reports. */
export interface InspectedSetting {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * Whether the user set a command setting: a non-blank string at any scope.
 * A blank one falls back to the default, so it counts as unset.
 */
export function isUserSet(inspected: InspectedSetting | undefined): boolean {
  return [
    inspected?.globalValue,
    inspected?.workspaceValue,
    inspected?.workspaceFolderValue,
  ].some(value => typeof value === 'string' && value.trim() !== '');
}

/**
 * Whether a command setting will run: one the user set is theirs to vouch
 * for; the default runs devc, so it needs devc.
 */
export function commandAvailable(
  inspected: InspectedSetting | undefined,
  devcFound: boolean
): boolean {
  return isUserSet(inspected) || devcFound;
}
