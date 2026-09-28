import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SSH_SAFETY_OPTIONS, SshShell } from '../remoteShell';
import {
  ReviewRequest,
  SyncDeps,
  SyncError,
  SyncUi,
  fetchFromSshHost,
  gitSshCommand,
  isSensitivePath,
  makeGit,
  mirror,
  parseWorktrees,
  sendToSshHost,
} from '../workspaceSync';

// No vscode import: this suite also runs under plain mocha
// (`npx mocha --ui tdd out/test/workspaceSync.test.js`).

suite('mirror', () => {
  test('maps a path to the same place under the remote home', () => {
    assert.strictEqual(
      mirror('/Users/bo/code/r', '/Users/bo', '/home/ubuntu'),
      '/home/ubuntu/code/r'
    );
    assert.strictEqual(
      mirror('/Users/bo/code/r.worktrees/f', '/Users/bo', '/home/ubuntu'),
      '/home/ubuntu/code/r.worktrees/f'
    );
  });

  test('home itself maps to the remote home', () => {
    assert.strictEqual(mirror('/Users/bo', '/Users/bo', '/home/ubuntu'), '/home/ubuntu');
  });

  test('refuses paths outside home, including a sibling prefix', () => {
    for (const p of ['/opt/r', '/Users/bob/r', '/Users']) {
      assert.throws(
        () => mirror(p, '/Users/bo', '/home/ubuntu'),
        (err: Error) =>
          err instanceof SyncError &&
          err.message ===
            `${p} is outside your home folder — only folders under ~ can be sent.`
      );
    }
  });

  test('refuses characters that break quoting', () => {
    for (const p of ["/Users/bo/it's", '/Users/bo/a\\b', '/Users/bo/a\nb', '/Users/bo/a\tb']) {
      assert.throws(
        () => mirror(p, '/Users/bo', '/home/ubuntu'),
        (err: Error) =>
          err.message === `${p} contains characters that can't be sent over ssh.`
      );
    }
  });
});

suite('parseWorktrees', () => {
  const refs = (...names: string[]) =>
    '\0\0REFS\0' + names.map(n => `${n}\0\n`).join('');

  test('main only', () => {
    const out =
      'worktree /h/code/r\0HEAD abc\0branch refs/heads/main\0\0' + refs('main');
    assert.deepStrictEqual(parseWorktrees(out), {
      worktrees: [{ path: '/h/code/r', branch: 'main' }],
      refs: new Set(['main']),
    });
  });

  test('main plus a linked worktree with a space in its path', () => {
    const out =
      'worktree /h/code/r\0HEAD abc\0branch refs/heads/main\0\0' +
      'worktree /h/code/r.worktrees/my f\0HEAD def\0branch refs/heads/f\0\0' +
      refs('f', 'main');
    const parsed = parseWorktrees(out);
    assert.deepStrictEqual(parsed.worktrees, [
      { path: '/h/code/r', branch: 'main' },
      { path: '/h/code/r.worktrees/my f', branch: 'f' },
    ]);
    assert.deepStrictEqual([...parsed.refs].sort(), ['f', 'main']);
  });

  test('detached head has no branch', () => {
    const out = 'worktree /h/code/r\0HEAD abc\0detached\0\0' + refs('main');
    assert.deepStrictEqual(parseWorktrees(out).worktrees, [{ path: '/h/code/r' }]);
  });

  test('an unborn branch is on its worktree but not in refs', () => {
    const out =
      'worktree /h/code/r\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0' +
      refs();
    const parsed = parseWorktrees(out);
    assert.strictEqual(parsed.worktrees[0].branch, 'main');
    assert.strictEqual(parsed.refs.has('main'), false);
  });
});

suite('isSensitivePath', () => {
  test('matches every pattern', () => {
    for (const p of [
      '.vscode/settings.json',
      '.vscode/tasks.json',
      '.devcontainer/devcontainer.json',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      '.gitmodules',
      '.gitattributes',
      '.envrc',
      'package.json',
      'packages/a/package.json',
      '.npmrc',
      'sub/.npmrc',
      'Makefile',
      'native/Makefile',
      'x.code-workspace',
      'dir/x.code-workspace',
      '.pre-commit-config.yaml',
      'sub/.pre-commit-config.yaml',
    ]) {
      assert.ok(isSensitivePath(p), p);
    }
  });

  test('does not match look-alikes', () => {
    for (const p of [
      'src/package.json.bak',
      'docs/.vscode.md',
      'sub/.vscode/settings.json',
      'sub/.gitmodules',
      'src/index.ts',
      'README.md',
    ]) {
      assert.ok(!isSensitivePath(p), p);
    }
  });
});

suite('gitSshCommand', () => {
  test('carries every safety option, BatchMode and a quoted ssh path', () => {
    const cmd = gitSshCommand('/opt/my ssh', '/tmp/devc-1000');
    assert.ok(cmd.startsWith(`'/opt/my ssh' `), cmd);
    for (const opt of SSH_SAFETY_OPTIONS) {
      assert.ok(cmd.includes(`'${opt}'`), opt);
    }
    assert.ok(cmd.includes(`'-o' 'BatchMode=yes'`));
    assert.ok(cmd.includes(`'ControlPath=/tmp/devc-1000/%C'`));
  });

  test('omits control options with no control directory', () => {
    assert.ok(!gitSshCommand('ssh', undefined).includes('Control'));
  });
});

// ── End to end, against a fake ssh ──────────────────────────────────────────

const FAKE_SSH = path.resolve(__dirname, '../../src/test/fixtures/fake-ssh.sh');
const HOST = 'vm';

/** Identity and isolation for every git process, local and "remote". */
const GIT_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

interface Recorded {
  warn: { message: string; modal: boolean }[];
  info: string[];
  reviews: ReviewRequest[];
  errors: unknown[];
}

function stubUi(modalAnswer: string | undefined): { ui: SyncUi; calls: Recorded } {
  const calls: Recorded = { warn: [], info: [], reviews: [], errors: [] };
  const ui: SyncUi = {
    warn: async (message, modal) => {
      calls.warn.push({ message, modal });
      return modal ? modalAnswer : undefined;
    },
    info: async message => {
      calls.info.push(message);
      return undefined;
    },
    pick: async items => items[0]?.label,
    openReview: async request => {
      calls.reviews.push(request);
    },
    error: err => calls.errors.push(err),
  };
  return { ui, calls };
}

suite('workspace sync end to end', function () {
  this.timeout(30000);

  let tmp: string;
  let localHome: string;
  let remoteHome: string;
  let repo: string;
  const savedEnv: Record<string, string | undefined> = {};

  setup(() => {
    for (const [k, v] of Object.entries(GIT_TEST_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devc-sync-')));
    localHome = path.join(tmp, 'local');
    remoteHome = path.join(tmp, 'remote');
    fs.mkdirSync(remoteHome, { recursive: true });
    savedEnv.FAKE_SSH_REMOTE_HOME = process.env.FAKE_SSH_REMOTE_HOME;
    process.env.FAKE_SSH_REMOTE_HOME = remoteHome;

    repo = path.join(localHome, 'code', 'r');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    write(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
  });

  teardown(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(modalAnswer?: string): { deps: SyncDeps; calls: Recorded } {
    const { ui, calls } = stubUi(modalAnswer);
    return {
      calls,
      deps: {
        shell: host =>
          new SshShell(host, {
            sshPath: FAKE_SSH,
            controlDir: undefined,
            allowed: () => true,
          }),
        sshHome: async () => remoteHome,
        git: makeGit(
          {
            ...process.env,
            GIT_SSH_COMMAND: gitSshCommand(FAKE_SSH, undefined),
            GIT_SSH_VARIANT: 'ssh',
            GIT_TERMINAL_PROMPT: '0',
          },
          () => {}
        ),
        localHome,
        checkedHosts: new Set(),
        log: () => {},
        ui,
      },
    };
  }

  const remoteRepo = () => path.join(remoteHome, 'code', 'r');

  async function rejects(promise: Promise<unknown>, message: string | RegExp) {
    await assert.rejects(promise, (err: Error) => {
      assert.ok(err instanceof SyncError, String(err));
      if (typeof message === 'string') {
        assert.strictEqual(err.message, message);
      } else {
        assert.match(err.message, message);
      }
      return true;
    });
  }

  test('first send creates the mirrored repo with the branch checked out', async () => {
    const { deps: d, calls } = deps();
    await sendToSshHost(repo, HOST, d);

    const rp = remoteRepo();
    assert.strictEqual(fs.readFileSync(path.join(rp, 'README.md'), 'utf8'), 'hello\n');
    assert.strictEqual(git(rp, 'config', 'devc.hostPath'), repo);
    assert.strictEqual(git(rp, 'config', 'receive.denyCurrentBranch'), 'updateInstead');
    assert.strictEqual(git(rp, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.strictEqual(git(repo, 'remote', 'get-url', HOST), `${HOST}:${rp}`);
    assert.deepStrictEqual(calls.warn, [], 'no hand-off prompt on the first send');
    assert.deepStrictEqual(calls.info, ['Sent main to vm.']);
  });

  test('send from a linked worktree creates the matching remote worktree', async () => {
    const wt = path.join(localHome, 'code', 'r.worktrees', 'f');
    git(repo, 'worktree', 'add', '-q', '-b', 'f', wt);
    write(path.join(wt, 'feature.txt'), 'f\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'feature');

    const { deps: d } = deps();
    await sendToSshHost(wt, HOST, d);

    const rt = path.join(remoteHome, 'code', 'r.worktrees', 'f');
    assert.strictEqual(fs.readFileSync(path.join(rt, 'feature.txt'), 'utf8'), 'f\n');
    assert.strictEqual(git(rt, 'symbolic-ref', '--short', 'HEAD'), 'f');
    // The main worktree started on the local main worktree's branch.
    assert.strictEqual(git(remoteRepo(), 'symbolic-ref', '--short', 'HEAD'), 'main');
  });

  test("git's own ssh gets the forwarding options", async () => {
    const log = path.join(tmp, 'ssh.log');
    savedEnv.FAKE_SSH_LOG = process.env.FAKE_SSH_LOG;
    process.env.FAKE_SSH_LOG = log;
    await sendToSshHost(repo, HOST, deps().deps);

    const pushes = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(line => line.includes('git-receive-pack'));
    assert.strictEqual(pushes.length, 1, 'one push went through ssh');
    for (const opt of [...SSH_SAFETY_OPTIONS.filter(o => o !== '-o'), 'BatchMode=yes']) {
      assert.ok(pushes[0].includes(opt), `${opt} in: ${pushes[0]}`);
    }
  });

  test('a later send prompts, then updates a clean checkout', async () => {
    await sendToSshHost(repo, HOST, deps().deps);
    write(path.join(repo, 'second.txt'), '2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');

    const { deps: d, calls } = deps('Push');
    await sendToSshHost(repo, HOST, d);

    assert.strictEqual(calls.warn.length, 1);
    assert.strictEqual(calls.warn[0].modal, true);
    assert.strictEqual(
      calls.warn[0].message,
      `main is checked out on vm at ${remoteRepo()}. Pushing updates the files there if that checkout is clean. Continue?`
    );
    assert.ok(fs.existsSync(path.join(remoteRepo(), 'second.txt')));
  });

  test('declining the hand-off prompt pushes nothing', async () => {
    await sendToSshHost(repo, HOST, deps().deps);
    write(path.join(repo, 'second.txt'), '2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');

    await sendToSshHost(repo, HOST, deps(undefined).deps);
    assert.ok(!fs.existsSync(path.join(remoteRepo(), 'second.txt')));
    assert.notStrictEqual(git(remoteRepo(), 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
  });

  test('a dirty remote checkout refuses the push', async () => {
    await sendToSshHost(repo, HOST, deps().deps);
    write(path.join(remoteRepo(), 'README.md'), 'agent edit\n');
    write(path.join(repo, 'second.txt'), '2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');

    await rejects(sendToSshHost(repo, HOST, deps('Push').deps), /rejected/);
    assert.strictEqual(
      fs.readFileSync(path.join(remoteRepo(), 'README.md'), 'utf8'),
      'agent edit\n'
    );
  });

  test('refuses a remote repo created from somewhere else', async () => {
    const rp = remoteRepo();
    fs.mkdirSync(rp, { recursive: true });
    git(rp, 'init', '-q');
    git(rp, 'config', 'devc.hostPath', '/somewhere/else');

    await rejects(
      sendToSshHost(repo, HOST, deps().deps),
      `vm:${rp} exists but wasn't created from ${repo} — move it aside on vm to sync.`
    );
  });

  test('refuses and keeps a local remote that points elsewhere', async () => {
    git(repo, 'remote', 'add', HOST, 'other:/x');
    await rejects(
      sendToSshHost(repo, HOST, deps().deps),
      'Remote "vm" already points at other:/x — rename or remove it to sync with vm.'
    );
    assert.strictEqual(git(repo, 'remote', 'get-url', HOST), 'other:/x');
  });

  test('refuses a folder that is not a repo root', async () => {
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    await rejects(
      sendToSshHost(sub, HOST, deps().deps),
      `${sub} is not the root of a Git repository or worktree.`
    );
  });

  test('fetch reviews the agent commit with sensitive paths first and changes nothing locally', async () => {
    await sendToSshHost(repo, HOST, deps().deps);
    const rp = remoteRepo();
    write(path.join(rp, 'src', 'a.ts'), 'export {};\n');
    write(path.join(rp, '.vscode', 'settings.json'), '{}\n');
    git(rp, 'add', '.');
    git(rp, 'commit', '-q', '-m', 'agent work');

    const snapshot = () => ({
      head: git(repo, 'rev-parse', 'HEAD'),
      branches: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
      status: git(repo, 'status', '--porcelain'),
      readme: fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
      files: fs.readdirSync(repo).sort(),
    });
    const before = snapshot();

    const { deps: d, calls } = deps();
    await fetchFromSshHost(repo, HOST, d);

    assert.deepStrictEqual(snapshot(), before);
    assert.strictEqual(calls.reviews.length, 1);
    const review = calls.reviews[0];
    assert.strictEqual(review.title, 'vm/main vs main');
    assert.strictEqual(review.ref, 'refs/remotes/vm/main');
    assert.strictEqual(review.root, repo);
    assert.deepStrictEqual(
      review.files.map(f => `${f.status} ${f.path}`),
      ['A .vscode/settings.json', 'A src/a.ts']
    );
    assert.deepStrictEqual(calls.warn, [
      {
        message:
          'These changes touch files that can run code on this machine — review them before merging: .vscode/settings.json',
        modal: false,
      },
    ]);
  });

  test('fetch warns about uncommitted work on the host', async () => {
    await sendToSshHost(repo, HOST, deps().deps);
    const rp = remoteRepo();
    write(path.join(rp, 'README.md'), 'uncommitted\n');

    const { deps: d, calls } = deps();
    await fetchFromSshHost(repo, HOST, d);
    assert.deepStrictEqual(calls.info, ['No new commits on vm.']);
    assert.deepStrictEqual(calls.warn, [
      {
        message: `vm has uncommitted changes that weren't fetched: ${rp} (1 files)`,
        modal: false,
      },
    ]);
  });

  test('fetch before any send says so', async () => {
    await rejects(
      fetchFromSshHost(repo, HOST, deps().deps),
      "r hasn't been sent to vm yet — use Send to SSH Host first."
    );
  });
});
