import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Spike: what can a stable-API extension observe of a TUI agent running in a
 * terminal it created? Run with SPIKE=1; prints findings rather than asserting
 * much, because the point is to learn VS Code's behaviour.
 */
const FAKE_AGENT = path.resolve(__dirname, '../../spike/fake-agent.sh');
const CONTAINER = process.env.SPIKE_CONTAINER;

function waitFor<T>(
  event: vscode.Event<T>,
  pred: (e: T) => boolean,
  ms: number
): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, ms);
    const sub = event(e => {
      if (pred(e)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e);
      }
    });
  });
}

async function observe(label: string, name: string | undefined, cmd: string) {
  const terminal = vscode.window.createTerminal({ name, cwd: process.cwd() });
  terminal.show();
  const integrated =
    terminal.shellIntegration ??
    (
      await waitFor(
        vscode.window.onDidChangeTerminalShellIntegration,
        e => e.terminal === terminal,
        15000
      )
    )?.shellIntegration;
  console.log(`[${label}] shell integration: ${integrated ? 'yes' : 'NO'}`);

  // Titles as the extension host sees them, sampled every 100ms.
  const names: string[] = [terminal.name];
  const sampler = setInterval(() => {
    if (names[names.length - 1] !== terminal.name) {
      names.push(terminal.name);
    }
  }, 100);

  // Raw data of a command the user "typed" (sendText), not executeCommand.
  let raw = '';
  const t0 = Date.now();
  const arrivals: string[] = [];
  const started = waitFor(
    vscode.window.onDidStartTerminalShellExecution,
    e => e.terminal === terminal,
    15000
  );
  terminal.sendText(cmd);
  const exec = await started;
  console.log(
    `[${label}] execution seen: ${exec ? exec.execution.commandLine.value : 'NO'}`
  );
  if (exec) {
    const reading = (async () => {
      for await (const chunk of exec.execution.read()) {
        raw += chunk;
        arrivals.push(`${Date.now() - t0}ms:${chunk.length}`);
      }
    })();
    await Promise.race([reading, new Promise(r => setTimeout(r, 12000))]);
  } else {
    await new Promise(r => setTimeout(r, 8000));
  }
  clearInterval(sampler);
  console.log(`[${label}] terminal.name sequence: ${JSON.stringify(names)}`);
  console.log(`[${label}] raw bytes read: ${raw.length}`);
  console.log(`[${label}] chunk arrivals: ${arrivals.join(' ')}`);
  console.log(`[${label}] has OSC title: ${raw.includes('\x1b]0;')}`);
  console.log(`[${label}] has alt screen: ${raw.includes('\x1b[?1049h')}`);
  console.log(`[${label}] raw sample: ${JSON.stringify(raw.slice(0, 300))}`);
  terminal.dispose();
  return { raw, names };
}

(process.env.SPIKE ? suite : suite.skip)(
  'terminal observation spike',
  function () {
    this.timeout(60000);

    test('local fake agent, named terminal', async () => {
      const { raw } = await observe('local/named', 'devcontainer', FAKE_AGENT);
      assert.ok(raw.length >= 0);
    });

    test('local fake agent, unnamed terminal', async () => {
      await observe('local/unnamed', undefined, FAKE_AGENT);
    });

    (CONTAINER ? test : test.skip)(
      'fake agent through docker exec -it',
      async () => {
        await observe(
          'docker/named',
          'devcontainer',
          `docker exec -it ${CONTAINER} sh -c "$(cat ${FAKE_AGENT})"`
        );
      }
    );
  }
);

(process.env.SPIKE && CONTAINER ? suite : suite.skip)(
  'terminal agent tracker end to end',
  function () {
    this.timeout(60000);

    test('fake claude in a container terminal is classified live', async () => {
      const { TerminalAgentTracker, probeAgents, classifyScreen } =
        await import('../terminalAgents.js');
      const container = CONTAINER!;
      const t0 = Date.now();
      const seen: string[] = [];
      const tracker = new TerminalAgentTracker({
        isContainerTerminal: t => t.name === 'spike-agent',
        resolveContainer: async () => ({ id: container, user: 'vscode' }),
        probe: (id, user) => probeAgents(id, user, 'docker'),
        classify: (id, user, agents, screen) =>
          classifyScreen(id, user, agents, screen, 'docker'),
        report: (_t, _id, agent) => {
          const entry = `${Date.now() - t0}ms ${agent ? `${agent.agent}:${agent.status}` : 'none'}`;
          if (seen[seen.length - 1]?.split(' ')[1] !== entry.split(' ')[1]) {
            seen.push(entry);
          }
        },
      });
      const terminal = vscode.window.createTerminal({
        name: 'spike-agent',
        cwd: process.cwd(),
      });
      terminal.show();
      if (!terminal.shellIntegration) {
        await waitFor(
          vscode.window.onDidChangeTerminalShellIntegration,
          e => e.terminal === terminal,
          15000
        );
      }
      terminal.sendText(
        `docker exec -it -u vscode ${container} sh -c 'PATH=/tmp/spikebin:$PATH; claude'`
      );
      await new Promise(r => setTimeout(r, 14000));
      console.log(`[e2e] reports: ${seen.join(' | ')}`);
      tracker.dispose();
      terminal.dispose();
      const states = seen.map(s => s.split(' ')[1]);
      assert.ok(states.includes('claude:working'), 'saw working');
      assert.ok(states.includes('claude:blocked'), 'saw blocked');
      assert.ok(states.includes('claude:idle'), 'saw idle');
    });
  }
);
