import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  DevcWebError,
  DevcWebServer,
  DevcWebTimeouts,
  LoginEnv,
  RecordStore,
  ResolveDevcDeps,
  commandWords,
  devcChoice,
  isAlive,
  loginEnv,
  messageHtml,
  newViewId,
  pageUrl,
  devcWebZen,
  parseReadyLine,
  parseRecord,
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
      `http://127.0.0.1:41234/sidebar?zen=repo#token=${TOKEN}&view=vscode-0123456789ab`
    );
    assert.strictEqual(
      pageUrl(READY, 'main', 'vscode-0123456789ab'),
      `http://127.0.0.1:41234/main?zen=repo#token=${TOKEN}&view=vscode-0123456789ab`
    );
  });

  test('takes a mapped origin', () => {
    assert.strictEqual(
      pageUrl(READY, 'main', 'v', { origin: 'https://41234-x.example.dev/' }),
      `https://41234-x.example.dev/main?zen=repo#token=${TOKEN}&view=v`
    );
  });

  test('starts in the zen mode asked for', () => {
    assert.strictEqual(
      pageUrl(READY, 'sidebar', 'v', { zen: 'container' }),
      `http://127.0.0.1:41234/sidebar?zen=container#token=${TOKEN}&view=v`
    );
    assert.strictEqual(
      pageUrl(READY, 'main', 'v', { zen: 'off' }),
      `http://127.0.0.1:41234/main?zen=off#token=${TOKEN}&view=v`
    );
  });
});

suite('devcWebZen', () => {
  test('takes repo, container or off; anything else is repo', () => {
    assert.strictEqual(devcWebZen('container'), 'container');
    assert.strictEqual(devcWebZen('off'), 'off');
    assert.strictEqual(devcWebZen('repo'), 'repo');
    for (const v of [undefined, null, '', 'on', 'terminal', true, 3]) {
      assert.strictEqual(devcWebZen(v), 'repo', String(v));
    }
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

/** A port free on 127.0.0.1 now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      );
    });
  });
}

suite('parseRecord', () => {
  test('reads a record', () => {
    assert.deepStrictEqual(parseRecord(JSON.stringify({ pid: 12, url: READY })), {
      pid: 12,
      url: READY,
    });
  });

  test('rejects anything else', () => {
    for (const text of [
      undefined,
      '',
      'x',
      '{}',
      JSON.stringify({ pid: 0, url: READY }),
      JSON.stringify({ pid: 1.5, url: READY }),
      JSON.stringify({ pid: '12', url: READY }),
      JSON.stringify({ pid: 12, url: 'http://example.com/#token=x' }),
    ]) {
      assert.strictEqual(parseRecord(text), undefined, String(text));
    }
  });
});

suite('DevcWebServer', function () {
  this.timeout(20000);
  if (process.platform === 'win32') {
    return;
  }

  let dir: string;
  let port: number;
  /** The secret store every "window" of a test shares. */
  let secret: string | undefined;
  const store: RecordStore = {
    get: async () => secret,
    store: async v => {
      secret = v;
    },
    delete: async () => {
      secret = undefined;
    },
  };
  let servers: DevcWebServer[];
  let sleepers: cp.ChildProcess[];

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-web-test-'));
    port = await freePort();
    secret = undefined;
    servers = [];
    sleepers = [];
  });
  teardown(() => {
    for (const s of servers) {
      s.dispose();
    }
    const pid = parseRecord(secret)?.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const p of sleepers) {
      p.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Another live pid, standing for another window's extension host. */
  function otherPid(): number {
    const p = cp.spawn('sleep', ['60'], { stdio: 'ignore' });
    sleepers.push(p);
    return p.pid!;
  }

  /**
   * A `devc` stub in Node: records its arguments in `args` and each run in
   * `runs`, then runs `body`; `serve()` listens on `--port` and prints the
   * ready line with a fresh token.
   */
  function stub(body = 'serve();'): string {
    const file = path.join(dir, 'devc');
    fs.writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('fs'), net = require('net'), crypto = require('crypto');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(dir)} + '/args', args.join(' '));
fs.appendFileSync(${JSON.stringify(dir)} + '/runs', 'x\\n');
const port = Number(args[args.indexOf('--port') + 1]);
function serve() {
  const srv = net.createServer(s => s.destroy());
  srv.on('error', () => {
    console.error('devc web: port ' + port + ' is already in use');
    process.exit(1);
  });
  srv.listen(port, '127.0.0.1', () => console.log(
    'devc web: http://127.0.0.1:' + port + '/#token=' + crypto.randomBytes(32).toString('hex')));
}
${body}
`,
      { mode: 0o755 }
    );
    return file;
  }

  function server(
    command: string | string[],
    options: {
      args?: string[];
      pid?: number;
      timeouts?: Partial<DevcWebTimeouts>;
    } = {}
  ): DevcWebServer {
    const cmd = typeof command === 'string' ? [command] : command;
    const s = new DevcWebServer({
      command: async () => ({ cmd }),
      args: () => options.args ?? [],
      port: () => port,
      dir: path.join(dir, 'shared'),
      store,
      pid: options.pid,
      timeouts: {
        readyMs: 3000,
        stopMs: 1000,
        pollMs: 100,
        graceMs: 300,
        watchdogPollMs: 100,
        ...options.timeouts,
      },
    });
    servers.push(s);
    return s;
  }

  function runs(): number {
    return fs.readFileSync(path.join(dir, 'runs'), 'utf8').split('\n').length - 1;
  }

  async function until(what: string, f: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!(await f())) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  function listening(): Promise<boolean> {
    return new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
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

  test('starts on the port, stores its record, and stops on SIGTERM', async () => {
    const s = server(stub(), { args: ['--live'] });
    const states: string[] = [];
    s.onDidChangeState(state => states.push(state.kind));
    const url = await s.url();
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=[0-9a-f]{64}$`));
    assert.strictEqual(await s.url(), url);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'args'), 'utf8'),
      `web --no-open --port ${port} --live`
    );
    const record = parseRecord(secret)!;
    assert.strictEqual(record.url, url);
    assert.ok(isAlive(record.pid));
    assert.ok(fs.existsSync(path.join(dir, 'shared', 'clients', String(process.pid))));
    await s.stop();
    assert.ok(!isAlive(record.pid));
    assert.strictEqual(await listening(), false);
    assert.strictEqual(secret, undefined);
    assert.deepStrictEqual(states, ['starting', 'ready', 'idle']);
  });

  test('windows share one server', async () => {
    const file = stub();
    const a = server(file);
    const b = server(file, { pid: otherPid() });
    const [ua, ub] = await Promise.all([a.url(), b.url()]);
    assert.strictEqual(ua, ub);
    assert.strictEqual(runs(), 1);
    const c = server(file, { pid: otherPid() });
    assert.strictEqual(await c.url(), ua);
    assert.strictEqual(runs(), 1);
  });

  test('stops once no client window is alive', async () => {
    const other = cp.spawn('sleep', ['60'], { stdio: 'ignore' });
    sleepers.push(other);
    const a = server(stub());
    const b = server(stub(), { pid: other.pid });
    await a.url();
    await b.url();
    const { pid } = parseRecord(secret)!;
    a.dispose();
    // b's window still lives.
    await new Promise(r => setTimeout(r, 800));
    assert.ok(isAlive(pid));
    // b's window crashes: its client file stays, its pid dies.
    other.kill('SIGKILL');
    await until('the watchdog to exit', () => !isAlive(pid));
    assert.strictEqual(await listening(), false);
  });

  test('a restart in one window is followed by the others', async () => {
    const file = stub();
    const a = server(file);
    const b = server(file, { pid: otherPid() });
    const first = await a.url();
    assert.strictEqual(await b.url(), first);
    await a.stop();
    const second = await a.url();
    assert.notStrictEqual(second, first);
    await until('b to follow', () => b.state.kind === 'ready' && b.state.url === second);
  });

  test('shows stopped when the server goes, then adopts the next one', async () => {
    const file = stub();
    const a = server(file);
    const b = server(file, { pid: otherPid() });
    await a.url();
    await b.url();
    process.kill(parseRecord(secret)!.pid, 'SIGTERM');
    await until('b to stop', () => b.state.kind === 'stopped');
    assert.strictEqual(b.state.kind === 'stopped' && b.state.message, 'devc web stopped');
    const url = await b.url();
    await until('a to adopt', () => a.state.kind === 'ready' && a.state.url === url);
  });

  test('replaces a stale record', async () => {
    secret = JSON.stringify({ pid: 999999, url: `http://127.0.0.1:${port}/#token=${TOKEN}` });
    const s = server(stub());
    const url = await s.url();
    assert.notStrictEqual(url, `http://127.0.0.1:${port}/#token=${TOKEN}`);
    assert.strictEqual(runs(), 1);
  });

  test('waits while another window holds the start lock', async () => {
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'start.lock'), String(otherPid()));
    setTimeout(() => fs.rmSync(path.join(shared, 'start.lock')), 400);
    const s = server(stub());
    const started = Date.now();
    await s.url();
    assert.ok(Date.now() - started >= 400);
    assert.ok(!fs.existsSync(path.join(shared, 'start.lock')));
  });

  test('takes over a lock left by a dead window', async () => {
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'start.lock'), '999999');
    const s = server(stub());
    const started = Date.now();
    await s.url();
    assert.ok(Date.now() - started < 2000);
  });

  test('kills one that ignores SIGTERM after the stop timeout', async () => {
    const s = server(stub(`process.on('SIGTERM', () => {});\nserve();`), {
      timeouts: { stopMs: 1500 },
    });
    await s.url();
    const started = Date.now();
    await s.stop();
    const took = Date.now() - started;
    assert.ok(took >= 1400 && took < 5000, `took ${took} ms`);
    assert.strictEqual(await listening(), false);
  });

  test('reports the stderr tail when it exits before its ready line', async () => {
    const s = server(
      stub(
        `for (let i = 0; i < 60; i++) console.error('err ' + i);\n` +
          `console.log('devc web: http://127.0.0.1:1/#token=${TOKEN}x');\n` +
          `process.exitCode = 3;`
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
    assert.strictEqual(secret, undefined);
  });

  test('gives up when no ready line comes in time', async () => {
    const s = server(stub(`console.error('waiting');\nsetInterval(() => {}, 1000);`), {
      timeouts: { readyMs: 500 },
    });
    const err = await rejection(s.url());
    assert.match(err.message, /did not print its URL/);
    assert.strictEqual(err.stderr, 'waiting');
  });

  test('names the port setting when the port is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>(r => taken.listen(port, '127.0.0.1', r));
    try {
      const s = server(stub());
      const err = await rejection(s.url());
      assert.strictEqual(
        err.message,
        `devc web's port ${port} is in use: free it or set devc-vscode.devcWebPort`
      );
      assert.match(err.stderr, /already in use/);
      assert.strictEqual(runs(), 1);
    } finally {
      taken.close();
    }
  });

  test('keeps a --port from the settings', async () => {
    const own = await freePort();
    const s = server(stub(), { args: ['--port', String(own)] });
    assert.match(await s.url(), new RegExp(`^http://127\\.0\\.0\\.1:${own}/`));
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'args'), 'utf8'),
      `web --no-open --port ${own}`
    );
  });

  test('runs a multi-word command, such as $DEVC_BIN', async () => {
    const s = server([process.execPath, stub()]);
    await s.url();
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'args'), 'utf8'),
      `web --no-open --port ${port}`
    );
  });

  test('without devc, starts nothing', async () => {
    const s = new DevcWebServer({
      command: () =>
        Promise.reject(
          new DevcWebError('devc web needs devc: install it or put it on PATH', '')
        ),
      args: () => [],
      port: () => port,
      dir: path.join(dir, 'shared'),
      store,
    });
    servers.push(s);
    const err = await rejection(s.url());
    assert.strictEqual(
      err.message,
      'devc web needs devc: install it or put it on PATH'
    );
    assert.strictEqual(s.state.kind, 'stopped');
    assert.ok(!fs.existsSync(path.join(dir, 'shared', 'start.lock')));
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
