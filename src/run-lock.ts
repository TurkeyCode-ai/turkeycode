/**
 * One run per project folder.
 *
 * Two orchestrators in the same folder share one state file, one git working
 * tree and one set of QA folders. They do every session twice, overwrite each
 * other's reports and end in a merge error: a watchdog once restarted a run
 * that was still alive and a whole sprint ran doubled for hours. The lock is
 * taken at the source, so it holds whatever started the second process.
 *
 * The lock is a file holding the owner's pid. A lock whose owner is no longer
 * running (a crash, a kill -9) is stale and is taken over.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { STATE_DIR } from './constants';

export const RUN_LOCK_FILE = `${STATE_DIR}/run.lock`;

export interface RunLockOwner {
  pid: number;
  startedAt: string;
  command: string;
}

export type RunLockResult =
  | { acquired: true; path: string; tookOverStale: boolean }
  | { acquired: false; path: string; owner: RunLockOwner };

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else. Still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(path: string): RunLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        command: typeof parsed.command === 'string' ? parsed.command : '',
      };
    }
  } catch {
    // Unreadable or half-written: treated as stale below.
  }
  return null;
}

/**
 * Take the run lock for a project folder. Never throws for a held lock: the
 * caller decides what to tell the user. `alive` is injectable for tests.
 */
export function acquireRunLock(
  workDir: string,
  command: string,
  alive: (pid: number) => boolean = isAlive,
  pid: number = process.pid
): RunLockResult {
  const path = join(workDir, RUN_LOCK_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const mine = JSON.stringify({ pid, startedAt: new Date().toISOString(), command }) + '\n';

  let tookOverStale = false;
  // Two tries: the second follows the removal of a stale lock. 'wx' fails if
  // the file exists, so two processes racing here cannot both win.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, mine, { flag: 'wx' });
      return { acquired: true, path, tookOverStale };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = readOwner(path);
    if (owner && owner.pid !== pid && alive(owner.pid)) {
      return { acquired: false, path, owner };
    }
    // Our own pid (a re-entrant call) or a dead owner: clear it and retry.
    try { unlinkSync(path); } catch { /* someone else cleared it */ }
    tookOverStale = owner !== null && owner.pid !== pid;
  }
  // Lost the race for a stale lock to another process that is now the owner.
  const owner = readOwner(path);
  return { acquired: false, path, owner: owner ?? { pid: 0, startedAt: '', command: '' } };
}

/** Release the lock if this process holds it. Safe to call more than once. */
export function releaseRunLock(workDir: string, pid: number = process.pid): void {
  const path = join(workDir, RUN_LOCK_FILE);
  if (!existsSync(path)) return;
  const owner = readOwner(path);
  if (owner && owner.pid !== pid) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Take the lock for this process or exit with a message naming the run that
 * holds it. The lock is released when the process exits, however it exits.
 */
export function holdRunLockOrExit(workDir: string, command: string): void {
  const result = acquireRunLock(workDir, command);
  if (!result.acquired) {
    const { owner } = result;
    console.error('');
    console.error('❌ Another turkeycode run is already working in this folder.');
    console.error(`   pid ${owner.pid}${owner.command ? ` (turkeycode ${owner.command})` : ''}` +
      `${owner.startedAt ? `, started ${owner.startedAt}` : ''}`);
    console.error('   Two runs in one folder repeat every session and overwrite each other.');
    console.error(`   Wait for it to finish, or stop it first. Lock file: ${result.path}`);
    console.error('');
    process.exit(1);
  }
  if (result.tookOverStale) {
    console.log('Note: took over a run lock left by a process that is no longer running.');
  }
  // 'exit' handlers must be synchronous; unlinkSync is.
  process.on('exit', () => releaseRunLock(workDir));
}
