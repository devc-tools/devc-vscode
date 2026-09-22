import * as cp from 'child_process';

export interface DockerExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/**
 * Run `docker <args>` on the host, optionally piping `input` to stdin.
 * Never throws on non-zero exit codes; rejects only when docker itself
 * cannot be spawned (e.g. not installed / not on PATH).
 */
export function execDocker(
  args: string[],
  input?: Uint8Array,
  dockerCommand = 'docker'
): Promise<DockerExecResult> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(dockerCommand, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // Avoid unhandled stream errors (EPIPE) when the process fails to start.
    child.stdin.on('error', () => {
      /* ignore */
    });

    child.on('error', err => {
      reject(new Error(`Failed to start ${dockerCommand}: ${err.message}`));
    });
    child.on('close', code => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: code ?? -1,
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
