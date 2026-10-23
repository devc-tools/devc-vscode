import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DevcWebError,
  DevcWebServer,
  LoginEnv,
  ResolveDevcDeps,
  commandWords,
  devcChoice,
  loginEnv,
  messageHtml,
  newViewId,
  pageUrl,
  parseReadyLine,
  resolveDevc,
  sidebarHtml,
} from '../devcWeb';

// No vscode import: this suite also runs under plain mocha
// (`npx mocha --ui tdd out/test/devcWeb.test.js`).

const TOKEN = 'ab'.repeat(32);
const READY = `http://127.0.0.1:41234/#token=${TOKEN}`;

suite('parseReadyLine', () => {
  test('matches the ready line', () => {
    assert.strictEqual(parseReadyLine(`devc web: ${READY}`), READY);
  });

  test('ignores trailing whitespace and a CR', () => {
    assert.strictEqual(parseReadyLine(`devc web: ${READY}  `), READY);
    assert.strictEqual(parseReadyLine(`devc web: ${READY}\r`), READY);
  });

  test('rejects near-misses', () => {
    for (const line of [
      ` devc web: ${READY}`,
      `devc web:  ${READY}`,
      `devc web: ${READY}x`,
      `devc web: http://localhost:41234/#token=${TOKEN}`,
      `devc web: https://127.0.0.1:41234/#token=${TOKEN}`,
      `devc web: http://127.0.0.1:412345/#token=${TOKEN}`,
      `devc web: http://127.0.0.1:41234/#token=${TOKEN.slice(1)}`,
      `devc web: http://127.0.0.1:41234/#token=${TOKEN.toUpperCase()}`,
      `devc web: http://127.0.0.1:41234/sidebar#token=${TOKEN}`,
      `devc web: server exited (1); serving the built-in copy until the next change`,
      '',
    ]) {
      assert.strictEqual(parseReadyLine(line), undefined, line);
    }
  });
});

suite('newViewId', () => {
  test('is vscode- and 12 hex characters, valid for devc web', () => {
    const id = newViewId();
    assert.match(id, /^vscode-[0-9a-f]{12}$/);
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.notStrictEqual(newViewId(), id);
  });
});

suite('pageUrl', () => {
  test('builds the sidebar and main pages', () => {
    assert.strictEqual(
      pageUrl(READY, 'sidebar', 'vscode-0123456789ab'),
      `http://127.0.0.1:41234/sidebar#token=${TOKEN}&view=vscode-0123456789ab`
    );
    assert.strictEqual(
      pageUrl(READY, 'main', 'vscode-0123456789ab'),
      `http://127.0.0.1:41234/main#token=${TOKEN}&view=vscode-0123456789ab`
    );
  });

  test('takes a mapped origin', () => {
    assert.strictEqual(
      pageUrl(READY, 'main', 'v', 'https://41234-x.example.dev/'),
      `https://41234-x.example.dev/main#token=${TOKEN}&view=v`
    );
  });
});

suite('sidebarHtml', () => {
  const src = pageUrl(READY, 'sidebar', 'v');
  const html = sidebarHtml(src, ['http://127.0.0.1:41234', 'http://127.0.0.1:41234']);

  test('frames the sidebar URL', () => {
    assert.ok(
      html.includes(`<iframe src="${src.replace('&', '&amp;')}"`),
      html
    );
  });

  test('CSP allows only the server as a frame, and no script', () => {
    const csp = /content="([^"]*)"/.exec(html)?.[1];
    assert.strictEqual(
      csp,
      "default-src 'none'; frame-src http://127.0.0.1:41234; style-src 'unsafe-inline'"
    );
    assert.ok(!html.includes('<script'));
  });

  test('lists a mapped origin beside the local one', () => {
    const mapped = sidebarHtml(src, ['http://127.0.0.1:41234', 'https://m.example.dev']);
    assert.ok(
      mapped.includes('frame-src http://127.0.0.1:41234 https://m.example.dev;'),
      mapped
    );
  });
});

suite('messageHtml', () => {
  test('escapes the text and the detail', () => {
    const html = messageHtml('a <b> & "c"', { detail: "<script>x</script>'" });
    assert.ok(html.includes('<p>a &lt;b&gt; &amp; &quot;c&quot;</p>'), html);
    assert.ok(html.includes('<pre>&lt;script&gt;x&lt;/script&gt;&#39;</pre>'), html);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('command:'));
  });

  test('links the restart command', () => {
    const html = messageHtml('stopped', { restart: 'devc-vscode.restartDevcWeb' });
    assert.ok(html.includes('<a href="command:devc-vscode.restartDevcWeb">Restart</a>'), html);
  });

  test('CSP allows no script', () => {
    assert.ok(
      messageHtml('x').includes(
        `content="default-src 'none'; style-src 'unsafe-inline'"`
      )
    );
  });
});

suite('DevcWebServer', function () {
  this.timeout(15000);
  if (process.platform === 'win32') {
    return;
  }

  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-web-test-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A `devc` stub running `body`; its arguments are written to `args`. */
  function stub(body: string): string {
    const file = path.join(dir, 'devc');
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "$@" > "${dir}/args"\n${body}\n`,
      { mode: 0o755 }
    );
    return file;
  }

  function server(
    command: string | string[],
    args: string[] = [],
    timeouts = { readyMs: 2000, stopMs: 1000 }
  ): DevcWebServer {
    const cmd = typeof command === 'string' ? [command] : command;
    return new DevcWebServer(async () => ({ cmd }), () => args, timeouts);
  }

  async function rejection(p: Promise<unknown>): Promise<DevcWebError> {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof DevcWebError, String(err));
      return err;
    }
    assert.fail('expected a rejection');
  }

  test('starts, reads the URL, and stops on SIGTERM', async () => {
    const s = server(
      stub(`echo noise\necho "devc web: ${READY}"\nexec sleep 30`),
      ['--live']
    );
    const states: string[] = [];
    s.onDidChangeState(state => states.push(state.kind));
    assert.strictEqual(await s.url(), READY);
    assert.strictEqual(await s.url(), READY);
    assert.match(
      fs.readFileSync(path.join(dir, 'args'), 'utf8').trim(),
      /^web --no-open --port \d{1,5} --live$/
    );
    const started = Date.now();
    await s.stop();
    assert.ok(Date.now() - started < 1000);
    assert.deepStrictEqual(states, ['starting', 'ready', 'idle']);
  });

  test('kills one that ignores SIGTERM after the stop timeout', async () => {
    const s = server(
      stub(
        `trap '' TERM\necho "devc web: ${READY}"\nwhile true; do sleep 1; done`
      ),
      [],
      { readyMs: 2000, stopMs: 5000 }
    );
    await s.url();
    const started = Date.now();
    await s.stop();
    const took = Date.now() - started;
    assert.ok(took >= 4900 && took < 7000, `took ${took} ms`);
  });

  test('reports the stderr tail when it exits before its ready line', async () => {
    const s = server(
      stub(
        `i=0; while [ $i -lt 60 ]; do echo "err $i" >&2; i=$((i+1)); done\n` +
          `echo "devc web: http://127.0.0.1:1/#token=${TOKEN}x"\nexit 3`
      )
    );
    const err = await rejection(s.url());
    assert.strictEqual(err.message, 'devc web exited (3) before it was ready');
    const lines = err.stderr.split('\n');
    assert.strictEqual(lines.length, 50);
    assert.strictEqual(lines[0], 'err 10');
    assert.strictEqual(lines[49], 'err 59');
    assert.ok(!err.stderr.includes(TOKEN));
    assert.ok(!err.message.includes(TOKEN));
    assert.strictEqual(s.state.kind, 'stopped');
  });

  test('gives up when no ready line comes in time', async () => {
    const s = server(stub('echo waiting >&2\nexec sleep 30'), [], {
      readyMs: 300,
      stopMs: 1000,
    });
    const err = await rejection(s.url());
    assert.match(err.message, /did not print its URL/);
    assert.strictEqual(err.stderr, 'waiting');
  });

  test('reports an exit after it was ready, and starts again', async () => {
    const s = server(stub(`echo "devc web: ${READY}"\nsleep 0.2\nexit 1`));
    const stopped = new Promise<string>(resolve =>
      s.onDidChangeState(state => {
        if (state.kind === 'stopped') {
          resolve(state.message);
        }
      })
    );
    await s.url();
    assert.strictEqual(await stopped, 'devc web exited (1)');
    assert.strictEqual(await s.url(), READY);
    await s.stop();
  });

  test('tries another port when the one picked is taken', async () => {
    const s = server(
      stub(
        `if [ ! -e "${dir}/tried" ]; then touch "${dir}/tried"; ` +
          `echo "devc web: port $3 is already in use" >&2; exit 1; fi\n` +
          `echo "devc web: ${READY}"\nexec sleep 30`
      )
    );
    assert.strictEqual(await s.url(), READY);
    await s.stop();
  });

  test('gives up after three taken ports', async () => {
    const s = server(
      stub('echo "devc web: port $3 is already in use" >&2\nexit 1')
    );
    const err = await rejection(s.url());
    assert.match(err.stderr, /already in use/);
    assert.strictEqual(s.state.kind, 'stopped');
  });

  test('keeps a --port from the settings, without retrying', async () => {
    const s = server(
      stub(
        `echo x >> "${dir}/runs"\necho "devc web: port $4 is already in use" >&2\nexit 1`
      ),
      ['--port', '48228']
    );
    const err = await rejection(s.url());
    assert.strictEqual(err.stderr, 'devc web: port 48228 is already in use');
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'args'), 'utf8').trim(),
      'web --no-open --port 48228'
    );
    assert.strictEqual(fs.readFileSync(path.join(dir, 'runs'), 'utf8'), 'x\n');
  });

  test('runs a multi-word command, such as $DEVC_BIN', async () => {
    const file = stub(`echo "devc web: ${READY}"\nexec sleep 30`);
    const s = server(['/bin/sh', file]);
    assert.strictEqual(await s.url(), READY);
    assert.match(
      fs.readFileSync(path.join(dir, 'args'), 'utf8').trim(),
      /^web --no-open --port \d+$/
    );
    await s.stop();
  });

  test('without devc, starts nothing', async () => {
    const s = new DevcWebServer(
      () =>
        Promise.reject(
          new DevcWebError('devc web needs devc: install it or put it on PATH', '')
        ),
      () => []
    );
    const err = await rejection(s.url());
    assert.strictEqual(
      err.message,
      'devc web needs devc: install it or put it on PATH'
    );
    assert.strictEqual(s.state.kind, 'stopped');
  });

  test('loginEnv reads PATH and $DEVC_BIN past rc output', async () => {
    const shell = path.join(dir, 'shell');
    fs.writeFileSync(
      shell,
      `#!/bin/sh\necho welcome\nPATH=/p1:/p2 DEVC_BIN='deno run x' exec /bin/sh -c "$2"\n`,
      { mode: 0o755 }
    );
    assert.deepStrictEqual(await loginEnv(shell), {
      path: '/p1:/p2',
      devcBin: 'deno run x',
    });
    assert.strictEqual(await loginEnv(path.join(dir, 'missing')), undefined);
  });
});

suite('devcChoice', () => {
  test('reads the setting', () => {
    assert.deepStrictEqual(devcChoice('devc2'), { kind: 'devc2' });
    assert.deepStrictEqual(devcChoice('/opt/devc'), { kind: 'path', path: '/opt/devc' });
    for (const v of ['installed', undefined, '', 'devc', 3]) {
      assert.deepStrictEqual(devcChoice(v), { kind: 'installed' });
    }
  });

  test('commandWords splits on whitespace', () => {
    assert.deepStrictEqual(commandWords('  deno run  -A /m.ts '), [
      'deno',
      'run',
      '-A',
      '/m.ts',
    ]);
    assert.deepStrictEqual(commandWords('  '), []);
  });
});

suite('resolveDevc', () => {
  const DEVC_BIN = 'deno run --allow-read /src/devc/main.ts';
  function deps(
    env: Record<string, string>,
    login: LoginEnv | undefined,
    installed?: string
  ): ResolveDevcDeps & { loginAsked: number } {
    const d = {
      loginAsked: 0,
      installed: async () => installed,
      env: (name: string) => env[name],
      loginEnv: async () => {
        d.loginAsked++;
        return login;
      },
      onPath: async (name: string, p: string) =>
        p.split(':').includes('/opt/deno') && name === 'deno'
          ? '/opt/deno/deno'
          : undefined,
    };
    return d;
  }

  test('installed: the devc findDevc finds, else an error', async () => {
    assert.deepStrictEqual(
      await resolveDevc({ kind: 'installed' }, deps({}, undefined, '/a/devc')),
      { cmd: ['/a/devc'] }
    );
    await assert.rejects(
      resolveDevc({ kind: 'installed' }, deps({}, undefined)),
      /devc web needs devc/
    );
  });

  test('a path is run as is', async () => {
    assert.deepStrictEqual(
      await resolveDevc({ kind: 'path', path: '/x/devc' }, deps({}, undefined)),
      { cmd: ['/x/devc'] }
    );
  });

  test("devc2: $DEVC_BIN from VS Code's environment first", async () => {
    const d = deps({ DEVC_BIN: ` ${DEVC_BIN} ` }, undefined);
    assert.deepStrictEqual(await resolveDevc({ kind: 'devc2' }, d), {
      cmd: ['deno', 'run', '--allow-read', '/src/devc/main.ts'],
    });
    assert.strictEqual(d.loginAsked, 0);
  });

  test("devc2: else the login shell's, resolved on its PATH", async () => {
    assert.deepStrictEqual(
      await resolveDevc(
        { kind: 'devc2' },
        deps({}, { path: '/usr/bin:/opt/deno', devcBin: DEVC_BIN })
      ),
      {
        cmd: ['/opt/deno/deno', 'run', '--allow-read', '/src/devc/main.ts'],
        path: '/usr/bin:/opt/deno',
      }
    );
  });

  test('devc2: not found says to source bash_aliases.sh', async () => {
    for (const login of [
      undefined,
      { path: '/usr/bin' },
      { path: '/usr/bin', devcBin: DEVC_BIN },
    ]) {
      await assert.rejects(
        resolveDevc({ kind: 'devc2' }, deps({}, login)),
        (err: Error) =>
          err instanceof DevcWebError && /bash_aliases\.sh/.test(err.message)
      );
    }
  });
});
