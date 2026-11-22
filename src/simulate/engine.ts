/**
 * Runs the SDD engine. It is a separate program (`sdd`, from the sdd-engine
 * package), found on PATH the way agent CLIs are. turkeycode never bundles it.
 */

import { execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseSimReport, type SimReport } from './schemas';

/**
 * The engine needs Node 24 or later. turkeycode looks for the `sdd` command on
 * PATH, so it has to be installed, not run through npx.
 */
export const ENGINE_INSTALL_HINT = 'npm install -g sdd-engine && sdd setup (needs Node 24 or later; if the install fails with EACCES, use a Node version manager or sudo)';

/** Set to use an engine that is not on PATH. */
export const ENGINE_BIN_ENV = 'TURKEYCODE_SDD_BIN';

export interface Engine {
  bin: string;
  version: string;
}

/** The engine, or null when it is not installed. */
export function findEngine(env: NodeJS.ProcessEnv = process.env): Engine | null {
  const bin = env[ENGINE_BIN_ENV]?.trim() || 'sdd';
  try {
    const version = execFileSync(bin, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
    return version ? { bin, version } : null;
  } catch {
    return null;
  }
}

const PASSED_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  // Where the claude CLI keeps its login, and where Playwright keeps browsers.
  'CLAUDE_CONFIG_DIR', 'PLAYWRIGHT_BROWSERS_PATH',
  // Networks that need a proxy or their own certificates.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
];

/**
 * The engine's environment: a short allowlist. The project's secrets have no
 * business in a process that drives a browser. The API key follows the same
 * rule as agent sessions: only passed when TURKEYCODE_USE_API_KEY is set, so a
 * run uses the CLI login otherwise.
 */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of PASSED_THROUGH) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('SDD_MODEL_') && value !== undefined) out[key] = value;
  }
  if (env.TURKEYCODE_USE_API_KEY && env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  return out;
}

export interface EngineRunOptions {
  workdir: string;
  /** http://127.0.0.1:PORT of the throwaway copy. */
  target: string;
  entry?: string;
  run: string;
  runsPerPersona: number;
  budgetUsd: number;
}

export function engineArgs(options: EngineRunOptions): string[] {
  return [
    'simulate',
    '--workdir', options.workdir,
    '--target', options.target,
    '--entry', options.entry ?? '/',
    '--run', options.run,
    '--runs', String(options.runsPerPersona),
    '--budget-usd', options.budgetUsd.toFixed(2),
    // Built apps load fonts and scripts from elsewhere. Those requests are
    // refused and listed; they do not fail the simulation.
    '--outside-requests', 'block',
  ];
}

export interface EngineResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Null when the engine left no readable report. */
  report: SimReport | null;
  /** Why there is no report, or the engine's own error. */
  error?: string;
  reportPath: string;
  markdownPath: string;
}

export const ENGINE_TIMEOUT_MS = 45 * 60 * 1000;

export function readEngineReport(workdir: string, run: string): { report: SimReport | null; error?: string } {
  const reportPath = join(workdir, 'reports', `${run}.json`);
  if (!existsSync(reportPath)) return { report: null, error: 'the engine wrote no report' };
  try {
    const report = parseSimReport(JSON.parse(readFileSync(reportPath, 'utf-8')));
    return { report, error: report.error };
  } catch (err) {
    return { report: null, error: (err as Error).message };
  }
}

/** Runs one engine pass and reads its report. Never throws for an engine failure. */
export function runEngine(
  engine: Engine,
  options: EngineRunOptions,
  hooks: { onLine?: (line: string) => void; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<EngineResult> {
  const reportPath = join(options.workdir, 'reports', `${options.run}.json`);
  const markdownPath = join(options.workdir, 'reports', `${options.run}.md`);
  const timeoutMs = hooks.timeoutMs ?? ENGINE_TIMEOUT_MS;

  return new Promise(resolve => {
    const child = spawn(engine.bin, engineArgs(options), {
      env: engineEnv(hooks.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    let tail = '';
    const onData = (chunk: Buffer) => {
      const lines = (tail + chunk.toString()).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) hooks.onLine?.(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (exitCode: number | null, spawnError?: string) => {
      clearTimeout(timer);
      if (tail.trim()) hooks.onLine?.(tail);
      const read = spawnError ? { report: null, error: spawnError } : readEngineReport(options.workdir, options.run);
      const error = timedOut
        ? `the engine was stopped after ${Math.round(timeoutMs / 60_000)} minutes`
        : read.error;
      resolve({ exitCode, timedOut, report: read.report, error, reportPath, markdownPath });
    };
    child.on('error', err => finish(null, `could not start the engine: ${err.message}`));
    child.on('close', code => finish(code));
  });
}
