import * as assert from 'assert';
import { AGENT_STATES_KEY, AgentObservation, AgentStates, displayedStatus, formatElapsed, parsePersisted } from '../agentState';
import { SessionModel, withDisplayedStatus } from '../sessions';
import { AgentStatus } from '../status';
import { snapshot } from './fixtures';

const S = 'host/s';
const KEY = 'host/s|p1';

function tracker(start = 1000) {
	const clock = { t: start };
	const states = new AgentStates({ now: () => clock.t });
	const shown = (raw: AgentStatus) => states.displayed(KEY, raw);
	const apply = (status: AgentStatus, extra: Partial<AgentObservation> = {}, first = false) =>
		states.update(S, [{ paneId: 'p1', status, ...extra }], first);
	return { clock, states, shown, apply };
}

/** A memento backed by a plain object. */
function memento(initial?: unknown) {
	const data = new Map<string, unknown>(initial === undefined ? [] : [[AGENT_STATES_KEY, initial]]);
	return {
		data,
		get: <T>(key: string) => data.get(key) as T,
		update: (key: string, value: unknown) => {
			data.set(key, JSON.parse(JSON.stringify(value)));
			return Promise.resolve();
		},
	};
}

suite('agent state tracker', () => {
	test('first sight: a baseline completion is not done; observed only after the first snapshot', () => {
		const { states, apply, shown } = tracker();
		apply('idle', { completionSeq: 3 }, true);
		assert.deepStrictEqual(shown('idle'), { status: 'idle' }, 'baseline, and no time on a first snapshot');
		assert.strictEqual(states.record(KEY)?.token, 'c:3');
		assert.strictEqual(states.record(KEY)?.observed, false);

		const later = tracker();
		later.apply('working', {}, false);
		assert.deepStrictEqual(later.shown('working'), { status: 'working', since: 1000 }, 'first sight on a later snapshot is observed');
	});

	test('working → idle with completion_seq is done; seen clears it', () => {
		const { clock, states, apply, shown } = tracker();
		apply('working', { completionSeq: 1 }, true);
		clock.t = 5000;
		apply('idle', { completionSeq: 2 });
		assert.deepStrictEqual(shown('idle'), { status: 'done', since: 5000 });
		assert.strictEqual(states.record(KEY)?.token, 'c:2');
		assert.strictEqual(states.markSeen(KEY), true);
		assert.deepStrictEqual(shown('idle'), { status: 'idle', since: 5000 });
		assert.strictEqual(states.markSeen(KEY), false, 'already seen');
	});

	test('working → idle without completion_seq is done (l: token)', () => {
		const { states, apply, shown } = tracker();
		apply('working', { stateChangeSeq: 4 }, true);
		apply('idle', { stateChangeSeq: 5 });
		assert.strictEqual(shown('idle').status, 'done');
		assert.strictEqual(states.record(KEY)?.token, 'l:5');
		const noSeq = tracker(42);
		noSeq.apply('working', {}, true);
		noSeq.apply('idle');
		assert.strictEqual(noSeq.states.record(KEY)?.token, 'l:42');
	});

	test('blocked → idle without completion_seq is not done', () => {
		const { apply, shown } = tracker();
		apply('blocked', {}, true);
		apply('idle');
		assert.strictEqual(shown('idle').status, 'idle');
	});

	test('the same status with a changed state_change_seq resets since', () => {
		const { clock, apply, shown, states } = tracker();
		apply('working', { stateChangeSeq: 1 }, true);
		clock.t = 9000;
		apply('working', { stateChangeSeq: 1 });
		assert.strictEqual(states.record(KEY)?.since, 1000, 'unchanged');
		apply('working', { stateChangeSeq: 2 });
		assert.deepStrictEqual(shown('working'), { status: 'working', since: 9000 });
	});

	test('a late completion_seq makes done', () => {
		const { apply, shown } = tracker();
		apply('blocked', {}, true);
		apply('idle');
		assert.strictEqual(shown('idle').status, 'idle');
		apply('idle', { completionSeq: 7 });
		assert.strictEqual(shown('idle').status, 'done');
	});

	test('working again after done shows working; raw done passes through', () => {
		const { apply, shown } = tracker();
		apply('working', {}, true);
		apply('idle', { completionSeq: 1 });
		assert.strictEqual(shown('idle').status, 'done');
		apply('working');
		assert.strictEqual(shown('working').status, 'working');
		assert.strictEqual(displayedStatus('done', undefined), 'done');
		apply('done');
		assert.strictEqual(shown('done').status, 'done');
	});

	test('records of gone panes are pruned; stale ones of disconnected sessions after 7 days', () => {
		const { clock, states, apply } = tracker();
		apply('working', {}, true);
		states.update('host/other', [{ paneId: 'q', status: 'idle' }], true);
		states.update(S, [], false);
		assert.strictEqual(states.record(KEY), undefined);
		clock.t += 8 * 24 * 3600 * 1000;
		states.pruneStale(new Set(['host/other']));
		assert.ok(states.record('host/other|q'), 'its session is connected');
		states.pruneStale(new Set());
		assert.strictEqual(states.record('host/other|q'), undefined);
	});

	test('herdr focus moving to a pane marks it seen, not on a first snapshot', () => {
		const states = new AgentStates({ now: () => 1 });
		const s = snapshot();
		// w2:p1 working → idle with a completion, while herdr's focus is on it already.
		states.apply(S, s, true);
		const done = { ...s, panes: s.panes.map((p) => (p.pane_id === 'w2:p1' ? { ...p, raw_status: 'idle' as const, completion_seq: 9 } : p)) };
		states.apply(S, done, false);
		assert.strictEqual(states.displayed(`${S}|w2:p1`, 'idle').status, 'done', 'focus did not change');
		states.apply(S, { ...done, focusedPaneId: 'w1:p1' }, false);
		assert.strictEqual(states.displayed(`${S}|w2:p1`, 'idle').status, 'done');
		states.apply(S, { ...done, focusedPaneId: 'w2:p1' }, false);
		assert.strictEqual(states.displayed(`${S}|w2:p1`, 'idle').status, 'idle', 'focus moved to it');
	});

	test('the snapshot shows the displayed status; raw kept', () => {
		const states = new AgentStates({ now: () => 1 });
		const s = snapshot();
		states.apply(S, s, true);
		const done = { ...s, panes: s.panes.map((p) => (p.pane_id === 'w2:p1' ? { ...p, raw_status: 'idle' as const, completion_seq: 9 } : p)) };
		states.apply(S, done, false);
		const shown = withDisplayedStatus(done, S, states);
		const p1 = shown.panes.find((p) => p.pane_id === 'w2:p1')!;
		assert.deepStrictEqual([p1.agent_status, p1.raw_status, p1.state_since], ['done', 'idle', 1]);
		assert.strictEqual(shown.panes.find((p) => p.pane_id === 'w1:p1')!.state_since, undefined, 'first sight on a first snapshot');
	});

	test('persistence round-trip keeps since and observed; malformed values are ignored', async () => {
		const store = memento();
		const clock = { t: 1000 };
		const a = new AgentStates({ now: () => clock.t, store });
		a.update(S, [{ paneId: 'p1', status: 'working', stateChangeSeq: 1 }], false);
		a.update(S, [{ paneId: 'p1', status: 'idle', stateChangeSeq: 2, completionSeq: 3 }], false);
		a.dispose();
		assert.deepStrictEqual(store.data.get(AGENT_STATES_KEY), {
			v: 1,
			panes: { [KEY]: { status: 'idle', seq: 2, since: 1000, observed: true, token: 'c:3', seen: false } },
		});
		clock.t = 99000;
		const b = new AgentStates({ now: () => clock.t, store });
		b.update(S, [{ paneId: 'p1', status: 'idle', stateChangeSeq: 2, completionSeq: 3 }], true);
		assert.deepStrictEqual(b.displayed(KEY, 'idle'), { status: 'done', since: 1000 }, 'unchanged across the reload');

		for (const bad of [undefined, 'x', { v: 2, panes: {} }, { v: 1, panes: [] }, { v: 1 }]) {
			assert.strictEqual(parsePersisted(bad).size, 0);
		}
		const mixed = parsePersisted({ v: 1, panes: { a: { status: 'nope', since: 1, observed: true, seen: true }, b: { status: 'idle', since: 1, observed: false, seen: true } } });
		assert.deepStrictEqual([...mixed.keys()], ['b']);
	});

	test('the model re-applies on a seen mark', () => {
		const states = new AgentStates({ now: () => 1 });
		const fakeModel = Object.create(SessionModel.prototype) as SessionModel;
		const s = snapshot();
		states.update(S, [{ paneId: 'w2:p1', status: 'working' }], true);
		states.update(S, [{ paneId: 'w2:p1', status: 'idle', completionSeq: 1 }], false);
		const conn = { snapshot: withDisplayedStatus({ ...s, panes: s.panes.map((p) => (p.pane_id === 'w2:p1' ? { ...p, raw_status: 'idle' as const } : p)) }, S, states) };
		assert.strictEqual(conn.snapshot.panes[0].agent_status, 'done');
		let fired = 0;
		Object.assign(fakeModel, { agentStates: states, conns: new Map([[S, conn]]), fireChanged: () => fired++ });
		fakeModel.markSeen(S, 'w2:p1');
		assert.strictEqual(conn.snapshot.panes[0].agent_status, 'idle');
		assert.strictEqual(fired, 1);
	});
});

suite('elapsed format', () => {
	test('minutes, hours, days', () => {
		const s = 1000;
		assert.deepStrictEqual(
			[0, 59 * s, 60 * s, 125 * s, 3599 * s, 3600 * s, 61 * 60 * s, 26 * 3600 * s].map(formatElapsed),
			['<1m', '<1m', '1m', '2m', '59m', '1h', '1h', '1d'],
		);
	});
});
