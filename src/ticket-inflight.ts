/**
 * Which tickets are being built on this machine right now.
 *
 * Several `run-ticket` processes can run at once (one per lane, terminal or
 * scheduler slot). Each knows nothing about the others, so two of them can
 * rewrite the same function and only find out at the final rebase. Each run
 * therefore leaves a small marker in its ticket directory while it works, and
 * reads the others' markers so its plan and build sessions can be told what
 * else is landing in the same repos.
 *
 * This is information for the sessions, not a lock: nothing waits and nothing
 * is refused. Whether two changes overlap, and what to do about it, is for the
 * session that reads both plans to judge.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const MARKER = 'in-flight.json';

export interface InFlightMarker {
  pid: number;
  key: string;
  summary: string;
  branch: string;
  /** Absolute repo paths this run is working in. */
  repos: string[];
  startedAt: string;
}

export interface InFlightTicket extends InFlightMarker {
  /** The ticket's plan, once its plan session has written one. */
  planPath?: string;
}

export function markInFlight(ticketsRoot: string, marker: Omit<InFlightMarker, 'pid' | 'startedAt'>): void {
  const dir = join(ticketsRoot, marker.key);
  mkdirSync(dir, { recursive: true });
  const full: InFlightMarker = { ...marker, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, MARKER), JSON.stringify(full, null, 2));
}

/** Remove this process's marker. A marker another live process owns (a rerun of the same ticket) is left alone. */
export function clearInFlight(ticketsRoot: string, key: string): void {
  const path = join(ticketsRoot, key, MARKER);
  const marker = readMarker(path);
  if (marker && marker.pid !== process.pid && isAlive(marker.pid)) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Other tickets being built right now in at least one of `repos`. A marker
 * whose process is gone (crash, kill, reboot) is stale: it is skipped and
 * removed, so a dead run never shows up as a neighbour.
 */
export function listInFlight(ticketsRoot: string, exceptKey: string, repos: string[]): InFlightTicket[] {
  let entries: string[];
  try {
    entries = readdirSync(ticketsRoot);
  } catch {
    return [];
  }
  const found: InFlightTicket[] = [];
  for (const entry of entries.sort()) {
    if (entry === exceptKey) continue;
    const path = join(ticketsRoot, entry, MARKER);
    const marker = readMarker(path);
    if (!marker) continue;
    if (!isAlive(marker.pid)) {
      try {
        unlinkSync(path);
      } catch {
        /* someone else removed it */
      }
      continue;
    }
    if (!marker.repos.some((r) => repos.includes(r))) continue;
    const planPath = join(ticketsRoot, entry, 'plan.md');
    found.push({ ...marker, planPath: existsSync(planPath) ? planPath : undefined });
  }
  return found;
}

function readMarker(path: string): InFlightMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<InFlightMarker>;
    if (typeof raw.pid !== 'number' || typeof raw.key !== 'string' || !Array.isArray(raw.repos)) return undefined;
    return {
      pid: raw.pid,
      key: raw.key,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      branch: typeof raw.branch === 'string' ? raw.branch : '',
      repos: raw.repos.filter((r): r is string => typeof r === 'string'),
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else. Anything else: it is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
