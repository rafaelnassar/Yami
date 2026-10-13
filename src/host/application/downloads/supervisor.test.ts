import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TickActivity } from './run-monitor.ts';
import { Supervisor, type TickOutcome } from './supervisor.ts';
import { ManualClock, ManualTimers } from './testing/fake-system.ts';

function setup(script: TickOutcome[]) {
  const timers = new ManualTimers(new ManualClock(0));
  let ticks = 0;
  const supervisor = new Supervisor(timers, { minMs: 300, maxMs: 1000 }, async () => {
    ticks += 1;
    return script.shift() ?? { activity: 'idle', active: false };
  });
  return { timers, supervisor, ticks: () => ticks };
}

const idle = (active = true): TickOutcome => ({ activity: 'idle', active });
const busy = (activity: TickActivity): TickOutcome => ({ activity, active: true });

describe('Supervisor', () => {
  it('backs off while idle and returns to the fast cadence after activity', async () => {
    const { timers, supervisor } = setup([idle(), idle(), busy('progress'), idle()]);
    supervisor.ensureRunning();
    for (let i = 0; i < 4; i += 1) await timers.runNext();
    assert.deepEqual(timers.delays, [300, 400, 500, 300, 400]);
  });

  it('never exceeds the max interval', async () => {
    const { timers, supervisor } = setup(Array.from({ length: 12 }, () => idle()));
    supervisor.ensureRunning();
    for (let i = 0; i < 12; i += 1) await timers.runNext();
    assert.equal(Math.max(...timers.delays), 1000);
  });

  it('stops when nothing is active and keeps a single pending timer', async () => {
    const { timers, supervisor, ticks } = setup([idle(false)]);
    supervisor.ensureRunning();
    supervisor.ensureRunning();
    assert.equal(timers.pending, 1);
    await timers.runNext();
    assert.equal(ticks(), 1);
    assert.equal(timers.pending, 0);
  });

  it('wake runs a pass immediately; stop cancels everything', async () => {
    const { timers, supervisor } = setup([busy('structural'), idle()]);
    supervisor.ensureRunning();
    supervisor.wake();
    assert.equal(timers.pending, 1);
    assert.equal(timers.delays.at(-1), 0);
    await timers.runNext();
    supervisor.stop();
    assert.equal(timers.pending, 0);
    supervisor.ensureRunning();
    supervisor.wake();
    assert.equal(timers.pending, 0);
  });

  it('a run started during a pass keeps the loop alive', async () => {
    const timers = new ManualTimers(new ManualClock(0));
    let supervisor: Supervisor | null = null;
    supervisor = new Supervisor(timers, { minMs: 300, maxMs: 1000 }, async () => {
      supervisor?.ensureRunning(); // launch happened while this pass sampled "nothing running"
      return idle(false);
    });
    supervisor.ensureRunning();
    await timers.runNext();
    assert.equal(timers.pending, 1);
  });
});
