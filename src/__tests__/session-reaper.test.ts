/**
 * Killing turkeycode must kill the sessions turkeycode started.
 *
 * Sessions spawn `detached: true` so a timeout can reap the whole tree —
 * claude plus the dev server and headless Chrome it backgrounds. The cost is
 * that those groups outlive their parent: kill turkeycode and its timeout
 * never fires, the children reparent to init, and they keep talking to the
 * API with nobody reading the answer.
 *
 * That is not theoretical. Two QA sessions were found still running 5h32m
 * after the builds that started them were dead, one still spawning playwright
 * shells, and every retry stacked another pair.
 *
 * These tests use real detached process groups, because the behaviour is
 * about real process groups — asserting on anything else asserts on nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';

import { _reaperInternals } from '../spawner';

const { liveGroups, reapAllGroups } = _reaperInternals;

const spawned: ChildProcess[] = [];

/** A detached group: a shell that itself backgrounds a child, like a session does. */
function spawnGroup(): ChildProcess {
  const proc = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(proc);
  return proc;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const p of spawned) {
    if (p.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  spawned.length = 0;
  liveGroups.clear();
});

describe('session reaper', () => {
  it('kills a registered group', async () => {
    const proc = spawnGroup();
    expect(proc.pid).to.not.equal(undefined);
    liveGroups.add(proc.pid!);

    expect(alive(proc.pid!)).to.equal(true);
    reapAllGroups('SIGKILL');
    await settle();

    expect(alive(proc.pid!)).to.equal(false);
  });

  it('kills every registered group, not just the first', async () => {
    const a = spawnGroup();
    const b = spawnGroup();
    liveGroups.add(a.pid!);
    liveGroups.add(b.pid!);

    reapAllGroups('SIGKILL');
    await settle();

    expect(alive(a.pid!)).to.equal(false);
    expect(alive(b.pid!)).to.equal(false);
  });

  it('leaves unregistered groups alone', async () => {
    const registered = spawnGroup();
    const stranger = spawnGroup();          // someone else's process
    liveGroups.add(registered.pid!);

    reapAllGroups('SIGKILL');
    await settle();

    expect(alive(registered.pid!)).to.equal(false);
    expect(alive(stranger.pid!)).to.equal(true);
  });

  it('reaps the whole group, including what the session backgrounded', async () => {
    // The `sleep 30 &` inside the shell is the stand-in for a dev server or
    // headless Chrome — a bare kill(pid) would leave it running.
    const proc = spawnGroup();
    liveGroups.add(proc.pid!);
    await settle(150);

    reapAllGroups('SIGKILL');
    await settle();

    // Signalling the GROUP (negative pid) must find nothing left in it.
    let groupStillThere = true;
    try { process.kill(-proc.pid!, 0); } catch { groupStillThere = false; }
    expect(groupStillThere).to.equal(false);
  });

  it('does not throw when a group is already gone', async () => {
    const proc = spawnGroup();
    liveGroups.add(proc.pid!);
    process.kill(-proc.pid!, 'SIGKILL');
    await settle();

    // A finished session that was never deregistered must not break shutdown.
    expect(() => reapAllGroups('SIGKILL')).to.not.throw();
  });

  it('does nothing when nothing is registered', () => {
    expect(liveGroups.size).to.equal(0);
    expect(() => reapAllGroups('SIGKILL')).to.not.throw();
  });
});
