/**
 * Guards against work a run should never repeat: a second run in the same
 * folder, QA re-run on code a fix did not change, a polish pass with nothing
 * to polish, and startup probes that load a full session to say one word.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { acquireRunLock, releaseRunLock, RUN_LOCK_FILE } from '../run-lock';
import { isNoopFix, countFinalVerdictWarnings, noWarningsRecorded } from '../orchestrator';
import { preflightModels } from '../constants';
import { buildAgentArgs, CLAUDE_BACKEND, CODEX_BACKEND } from '../agents';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tc-waste-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('run lock', () => {
  const everyoneAlive = () => true;
  const nobodyAlive = () => false;

  it('the first run takes the lock and records who holds it', () => {
    const dir = tmp();
    const res = acquireRunLock(dir, 'run', everyoneAlive, 1111);
    expect(res).toMatchObject({ acquired: true, tookOverStale: false });
    const owner = JSON.parse(readFileSync(join(dir, RUN_LOCK_FILE), 'utf-8'));
    expect(owner).toMatchObject({ pid: 1111, command: 'run' });
    expect(owner.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a second run is refused while the first is alive, and is told who holds it', () => {
    const dir = tmp();
    acquireRunLock(dir, 'run', everyoneAlive, 1111);
    const second = acquireRunLock(dir, 'resume', everyoneAlive, 2222);
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.owner).toMatchObject({ pid: 1111, command: 'run' });
    // The holder's lock is untouched.
    expect(JSON.parse(readFileSync(join(dir, RUN_LOCK_FILE), 'utf-8')).pid).toBe(1111);
  });

  it('a lock left by a dead process is taken over', () => {
    const dir = tmp();
    acquireRunLock(dir, 'run', everyoneAlive, 1111);
    const next = acquireRunLock(dir, 'resume', nobodyAlive, 2222);
    expect(next).toMatchObject({ acquired: true, tookOverStale: true });
    expect(JSON.parse(readFileSync(join(dir, RUN_LOCK_FILE), 'utf-8')).pid).toBe(2222);
  });

  it('an unreadable lock file is treated as stale, not as a live run', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.turkey'), { recursive: true });
    writeFileSync(join(dir, RUN_LOCK_FILE), 'half-writ');
    expect(acquireRunLock(dir, 'run', everyoneAlive, 2222).acquired).toBe(true);
  });

  it('release removes only a lock this process holds', () => {
    const dir = tmp();
    acquireRunLock(dir, 'run', everyoneAlive, 1111);
    releaseRunLock(dir, 2222);
    expect(existsSync(join(dir, RUN_LOCK_FILE))).toBe(true);
    releaseRunLock(dir, 1111);
    expect(existsSync(join(dir, RUN_LOCK_FILE))).toBe(false);
    releaseRunLock(dir, 1111); // twice is fine
  });

  it('uses the real process table by default: this process is alive, pid 2^30 is not', () => {
    const dir = tmp();
    acquireRunLock(dir, 'run', undefined, process.pid);
    expect(acquireRunLock(dir, 'run', undefined, 2222).acquired).toBe(false);
    releaseRunLock(dir, process.pid);
    acquireRunLock(dir, 'run', everyoneAlive, 2 ** 30);
    expect(acquireRunLock(dir, 'run', undefined, 2222)).toMatchObject({ acquired: true, tookOverStale: true });
  });
});

describe('a fix that changed no files is a no-op, even if it committed', () => {
  const git = (dir: string, cmd: string) =>
    execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' }).toString().trim();
  const tree = (dir: string, ref: string) => git(dir, `rev-parse ${ref}^{tree}`);

  it('an empty commit moves HEAD but not the tree; a real edit moves both', () => {
    const dir = tmp();
    git(dir, 'init -q');
    git(dir, 'config user.email t@example.com');
    git(dir, 'config user.name t');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add -A');
    git(dir, 'commit -q -m first');
    const preFix = git(dir, 'rev-parse HEAD');

    git(dir, 'commit -q --allow-empty -m "fix: nothing really"');
    expect(git(dir, 'rev-parse HEAD')).not.toBe(preFix);
    // The old guard compared commit ids and let this through to another QA pass.
    expect(isNoopFix(git(dir, 'rev-parse HEAD'), preFix)).toBe(false);
    expect(isNoopFix(tree(dir, 'HEAD'), tree(dir, preFix))).toBe(true);

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add -A');
    git(dir, 'commit -q -m "fix: real"');
    expect(isNoopFix(tree(dir, 'HEAD'), tree(dir, preFix))).toBe(false);
  });
});

describe('polish runs only when a phase recorded warnings', () => {
  it('reads the warning count from the highest-numbered verdict', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'verdict-1.json'), JSON.stringify({ blockers: [{}], warnings: [{}, {}] }));
    writeFileSync(join(dir, 'verdict-2.json'), JSON.stringify({ blockers: [], warnings: [{}] }));
    writeFileSync(join(dir, 'verdict-10.json'), JSON.stringify({ blockers: [] }));
    writeFileSync(join(dir, 'visual-11.json'), JSON.stringify({ warnings: [{}, {}, {}] }));
    expect(countFinalVerdictWarnings(dir)).toBe(0);
    rmSync(join(dir, 'verdict-10.json'));
    expect(countFinalVerdictWarnings(dir)).toBe(1);
  });

  it('is unknown, not zero, when there is no verdict or it cannot be read', () => {
    const dir = tmp();
    expect(countFinalVerdictWarnings(join(dir, 'missing'))).toBeUndefined();
    expect(countFinalVerdictWarnings(dir)).toBeUndefined();
    writeFileSync(join(dir, 'verdict-1.json'), '{not json');
    expect(countFinalVerdictWarnings(dir)).toBeUndefined();
  });

  it('skips only when every phase recorded zero from both QA and the code review', () => {
    const clean = { qaWarnings: 0, reviewWarnings: 0 };
    expect(noWarningsRecorded([clean, clean])).toBe(true);
    expect(noWarningsRecorded([clean, { qaWarnings: 2, reviewWarnings: 0 }])).toBe(false);
    // A review warning is a warning: polish runs.
    expect(noWarningsRecorded([clean, { qaWarnings: 0, reviewWarnings: 1 }])).toBe(false);
    // A phase with no record keeps the polish pass.
    expect(noWarningsRecorded([clean, {}])).toBe(false);
    expect(noWarningsRecorded([clean, { qaWarnings: 0 }])).toBe(false);
    expect(noWarningsRecorded([])).toBe(false);
  });
});

describe('startup probes', () => {
  it('skipping the legacy QA phases drops the model only they use', () => {
    const all = preflightModels(new Set());
    expect(all.get('haiku')).toEqual(['qa-smoke']);
    const used = preflightModels(new Set(['qa-smoke', 'qa-verdict']));
    expect(used.has('haiku')).toBe(false);
    expect(used.get('sonnet')).not.toContain('qa-verdict');
    // The models real phases run on are still probed.
    expect(used.has('claude-fable-5')).toBe(true);
    expect(used.has('opus')).toBe(true);
    expect(used.has('sonnet')).toBe(true);
  });

  it('a probe session carries the backend probe args; an ordinary session never does', () => {
    const probe = buildAgentArgs(CLAUDE_BACKEND, { model: 'claude-fable-5', probe: true });
    const at = probe.indexOf('--tools');
    expect(at).toBeGreaterThan(-1);
    expect(probe[at + 1]).toBe(''); // no tools at all
    expect(probe).toContain('--system-prompt');
    expect(probe).toContain('--strict-mcp-config');
    expect(probe.slice(probe.indexOf('--model'), probe.indexOf('--model') + 2)).toEqual(['--model', 'claude-fable-5']);

    const normal = buildAgentArgs(CLAUDE_BACKEND, { model: 'claude-fable-5' });
    expect(normal).not.toContain('--tools');
    expect(normal).not.toContain('--system-prompt');
  });

  it('a backend with no probe args probes like any other session', () => {
    expect(buildAgentArgs(CODEX_BACKEND, { probe: true })).toEqual(buildAgentArgs(CODEX_BACKEND, {}));
  });
});
