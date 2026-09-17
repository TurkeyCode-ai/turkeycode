/**
 * Agent session runner for turkeycode
 * Spawns print-mode agent CLI sessions (claude/codex/gemini/opencode/custom)
 * with proper timeout handling. Which CLI is decided by the active backend
 * spec (src/agents/) — everything here is backend-neutral process plumbing.
 * v3: Adds runParallel() for concurrent session execution
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { SpawnResult } from './types';
import { DEFAULT_TIMEOUT_MS } from './constants';
import {
  AgentBackendSpec,
  SpawnSessionOptions,
  buildAgentArgs,
  buildAgentEnv,
  detectAgentSignals,
  getActiveBackend,
  CLAUDE_BACKEND,
} from './agents';

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Every live session's process GROUP, so turkeycode can take them with it.
 *
 * Sessions spawn with `detached: true` so a timeout can reap the whole tree —
 * claude plus the dev server and headless Chrome it backgrounds. The cost of
 * detaching is that those groups SURVIVE turkeycode's own death: kill the
 * parent and its timeout never fires, the children reparent to init, and they
 * keep talking to the API with nobody left to read the answer.
 *
 * Seen in the wild: two QA sessions still running 5h32m after the builds that
 * started them were dead, one still spawning playwright shells, and every
 * retry stacked another pair. Killing turkeycode has to mean killing what
 * turkeycode started.
 *
 * SIGKILL to turkeycode itself remains unstoppable — nothing can trap it, and
 * those orphans still have to be reaped by hand.
 */
const liveGroups = new Set<number>();
let reaperInstalled = false;
let shuttingDown = false;

/** How long sessions get to exit on SIGTERM before the 'exit' handler SIGKILLs them. */
const REAP_GRACE_MS = 3000;

/** Conventional 128+n, so callers can tell which signal stopped the run. */
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

function anyGroupAlive(): boolean {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch { /* group gone */ }
  }
  return false;
}

/**
 * Track a detached process group this process started, so it dies with us.
 * For anything spawned outside the session path (quick-check's dev servers).
 */
export function trackProcessGroup(pid: number): void {
  liveGroups.add(pid);
  installReaper();
}

export function untrackProcessGroup(pid: number): void {
  liveGroups.delete(pid);
}

function reapAllGroups(signal: NodeJS.Signals): void {
  for (const pid of liveGroups) {
    try { process.kill(-pid, signal); } catch { /* group already gone */ }
  }
}

function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;

  // 'exit' handlers must be synchronous — process.kill is, so this is fine.
  process.on('exit', () => reapAllGroups('SIGKILL'));

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(sig, () => {
      const code = exitCodeForSignal(sig);
      // A second signal means stop waiting.
      if (shuttingDown) process.exit(code);
      shuttingDown = true;
      reapAllGroups('SIGTERM');
      // Give sessions the grace period instead of exiting in this tick, which
      // would SIGKILL them immediately. Anything that ignores SIGTERM is caught
      // by the 'exit' handler above.
      const deadline = Date.now() + REAP_GRACE_MS;
      const poll = setInterval(() => {
        if (anyGroupAlive() && Date.now() < deadline) return;
        clearInterval(poll);
        process.exit(code);
      }, 100);
    });
  }
}

/**
 * Classify a chunk of CLI output for rate-limit signals using a backend's
 * classifiers (defaults to Claude Code's — the historical behavior and the
 * signature the existing tests lock). Credit exhaustion is only declared when
 * credit/usage wording co-occurs with an actual API-error marker — otherwise
 * application-domain text (e.g. a banking app's "insufficient credit") would
 * false-trip it and the orchestrator would fail the build for a non-existent
 * rate limit.
 */
export function detectRateLimitSignals(
  text: string,
  spec: AgentBackendSpec = CLAUDE_BACKEND
): { rateLimited: boolean; creditExhausted: boolean } {
  return detectAgentSignals(spec, text);
}

/**
 * Spawner class for running agent CLI sessions
 * Each session gets ONE job and exits when done
 */
export class Spawner {
  private verbose: boolean;
  private backend: AgentBackendSpec;

  constructor(options: { verbose?: boolean; backend?: AgentBackendSpec } = {}) {
    this.verbose = options.verbose ?? false;
    // Resolved at construction, not per-run: the active backend is set once
    // at CLI entry and a run never switches agents midway.
    this.backend = options.backend ?? getActiveBackend();
  }

  /**
   * Run one agent session with the given prompt
   * Returns when the session completes or times out
   */
  async run(options: SpawnSessionOptions): Promise<SpawnResult> {
    // Shutting down: the reaper exits this process within the grace period, and
    // anything started now would be killed mid-flight. Never resolving stops the
    // main loop here instead of letting it run the next session.
    if (shuttingDown) return new Promise<SpawnResult>(() => {});

    const {
      cwd,
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      sessionName = 'agent-session',
      doneFile,
      model,
      mcpConfig = process.env.TURKEYCODE_MCP_CONFIG,
    } = options;
    const backend = this.backend;

    const startTime = Date.now();

    this.log(`[${sessionName}] Starting session...`);
    this.log(`[${sessionName}] Timeout: ${timeoutMs}ms`);
    this.log(`[${sessionName}] Working dir: ${cwd}`);
    if (doneFile) {
      this.log(`[${sessionName}] Done file watch: ${doneFile}`);
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let doneFileDetected = false;
      let rateLimited = false;
      let creditExhausted = false;

      // Scan a chunk of output for rate-limit / credit-exhaustion signals.
      const scanForLimits = (text: string) => {
        const signal = detectAgentSignals(backend, text);
        if (signal.creditExhausted && !creditExhausted) {
          creditExhausted = true;
          this.log(`[${sessionName}] Credit/usage exhaustion detected in output (will not retry)`);
        }
        if (signal.rateLimited && !rateLimited) {
          rateLimited = true;
          this.log(`[${sessionName}] Rate limit detected in output`);
        }
      };

      // Env policy lives in the backend spec: global secret strip, vendor
      // API-key handling (login session vs TURKEYCODE_USE_API_KEY=1), and
      // nested-session guards. CI=true prevents interactive prompts.
      const cleanEnv = buildAgentEnv(backend);

      if (model) {
        if (backend.modelFlag) {
          this.log(`[${sessionName}] Using model: ${model}`);
        } else {
          this.log(`[${sessionName}] WARNING: backend '${backend.id}' has no model flag — ignoring model '${model}'`);
        }
      }

      // Validate the MCP config before it reaches the argv: the file must
      // exist and the backend must take one on the command line.
      let usableMcpConfig: string | undefined;
      if (mcpConfig) {
        if (!backend.mcpConfigFlag) {
          this.log(`[${sessionName}] WARNING: backend '${backend.id}' has no MCP config flag — skipping ${mcpConfig}`);
        } else if (!existsSync(mcpConfig)) {
          this.log(`[${sessionName}] WARNING: mcpConfig path not found: ${mcpConfig} — skipping`);
        } else {
          usableMcpConfig = mcpConfig;
          this.log(`[${sessionName}] MCP config: ${mcpConfig}`);
        }
      }

      const args = buildAgentArgs(backend, { model, mcpConfig: usableMcpConfig, prompt });

      const proc: ChildProcess = spawn(backend.binary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'], // stdin piped for prompt, stdout/stderr piped for capture
        // Own process group so we can reap the WHOLE tree. A QA/fix session
        // backgrounds a dev server and (for visual QA) headless Chrome with `&`;
        // those outlive the agent process and, across a multi-phase build, pile
        // up until the jail OOMs. detached:true puts them in the agent's group.
        detached: true,
        env: cleanEnv
      });

      // Kill claude AND everything it backgrounded (dev servers, Chrome) by
      // signalling the process group (negative pid). Safe to call repeatedly.
      const reapGroup = (signal: NodeJS.Signals = 'SIGKILL'): void => {
        if (!proc.pid) return;
        try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
      };

      // Register for the process-wide reaper: if turkeycode is killed before
      // this session's own timeout fires, the session goes down with it
      // instead of running on for hours as an orphan.
      if (proc.pid) {
        liveGroups.add(proc.pid);
        installReaper();
      }

      // Deliver the prompt: write to stdin for stdin-mode backends (arg-mode
      // backends already carry it in argv); close stdin either way so the CLI
      // sees EOF and stays non-interactive.
      if (proc.stdin) {
        if (backend.promptDelivery === 'stdin') {
          proc.stdin.write(prompt);
        }
        proc.stdin.end();
      }

      // Helper to gracefully kill the process
      const killProcess = (reason: string) => {
        killed = true;
        this.log(`[${sessionName}] ${reason}, killing process group...`);
        reapGroup('SIGTERM');
        // Force-kill the whole group after 2 seconds if anything is still alive
        setTimeout(() => {
          if (!proc.killed) reapGroup('SIGKILL');
        }, 2000);
      };

      // Primary timeout
      const timeoutHandle = setTimeout(() => {
        killProcess('Timeout reached');
      }, timeoutMs);

      // Watchdog: check elapsed time every 30s in case setTimeout drifts under load
      const watchdog = setInterval(() => {
        if (Date.now() - startTime > timeoutMs + 30000) {
          killProcess('Watchdog timeout reached');
        }
      }, 30000);

      // Set up done-file watcher: poll every 5s, give 15s grace after detection
      let doneFileInterval: ReturnType<typeof setInterval> | null = null;
      if (doneFile) {
        const doneFilePath = join(cwd, doneFile);
        doneFileInterval = setInterval(() => {
          if (existsSync(doneFilePath)) {
            if (!doneFileDetected) {
              doneFileDetected = true;
              this.log(`[${sessionName}] Done file detected: ${doneFile}`);
              this.log(`[${sessionName}] Giving 15s grace period for cleanup...`);
              // Give the session 15s to exit naturally, then kill
              setTimeout(() => {
                if (!proc.killed && proc.exitCode === null) {
                  killProcess('Done file detected, grace period expired');
                }
              }, 15000);
            }
          }
        }, 5000);
      }

      // Collect stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        scanForLimits(text);

        if (this.verbose) {
          process.stdout.write(text);
        }
      });

      // Collect stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;

        // CLI errors (including credit/rate-limit rejections) often land on stderr.
        scanForLimits(text);

        if (this.verbose) {
          process.stderr.write(text);
        }
      });

      // Handle process exit
      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        clearInterval(watchdog);
        if (doneFileInterval) clearInterval(doneFileInterval);
        if (proc.pid) liveGroups.delete(proc.pid);   // no longer ours to reap
        // Reap any dev server / Chrome the session backgrounded and left running —
        // this is what otherwise accumulates across phases until the jail OOMs.
        reapGroup();
        // A session we killed on the way out is not a finished session. Resolving
        // would let the caller commit its half-edited tree or fail a gate and
        // exit with the wrong code, so leave it pending; the reaper exits next.
        if (shuttingDown) return;
        const durationMs = Date.now() - startTime;

        // Exit code: 0 if done file was detected (task succeeded), 124 for timeout, otherwise actual code
        const exitCode = doneFileDetected ? 0 : killed ? 124 : (code ?? 1);

        this.log(`[${sessionName}] Session completed`);
        this.log(`[${sessionName}] Exit code: ${exitCode}${doneFileDetected ? ' (done file detected)' : ''}`);
        this.log(`[${sessionName}] Duration: ${durationMs}ms`);
        this.log(`[${sessionName}] Output length: ${stdout.length} chars`);

        // Warn if output is suspiciously short (< 100 chars usually means the agent didn't execute)
        if (stdout.length < 100 && exitCode === 0 && !doneFileDetected) {
          this.log(`[${sessionName}] WARNING: Suspiciously short output - ${backend.displayName} may not have executed the task`);
          this.log(`[${sessionName}] stdout: ${stdout.substring(0, 200)}`);
          if (stderr.length > 0) {
            this.log(`[${sessionName}] stderr: ${stderr.substring(0, 500)}`);
          }
        }

        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs,
          rateLimited,
          creditExhausted
        });
      });

      // Handle spawn errors
      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        clearInterval(watchdog);
        if (doneFileInterval) clearInterval(doneFileInterval);
        reapGroup();
        // A session we killed on the way out is not a finished session. Resolving
        // would let the caller commit its half-edited tree or fail a gate and
        // exit with the wrong code, so leave it pending; the reaper exits next.
        if (shuttingDown) return;
        const durationMs = Date.now() - startTime;

        this.log(`[${sessionName}] Spawn error: ${err.message}`);

        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + '\n' + err.message,
          durationMs,
          rateLimited,
          creditExhausted
        });
      });
    });
  }

  /**
   * Run multiple sessions sequentially
   */
  async runSequence(sessions: SpawnSessionOptions[]): Promise<SpawnResult[]> {
    const results: SpawnResult[] = [];

    for (const session of sessions) {
      const result = await this.run(session);
      results.push(result);

      // Stop if a session failed
      if (result.exitCode !== 0) {
        break;
      }
    }

    return results;
  }

  /**
   * Run multiple sessions in parallel with a concurrency cap (v3)
   * Worker-pool pattern: N workers pulling from a shared queue.
   * Returns results in the same order as the input array.
   */
  async runParallel(
    sessions: SpawnSessionOptions[],
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT
  ): Promise<SpawnResult[]> {
    if (sessions.length === 0) return [];
    if (sessions.length === 1) return [await this.run(sessions[0])];

    const cap = Math.min(maxConcurrent, sessions.length);
    this.log(`[parallel] Running ${sessions.length} sessions with concurrency ${cap}`);

    // Pre-allocate results array to preserve input order
    const results: SpawnResult[] = new Array(sessions.length);

    // Shared queue index (workers pull next index atomically)
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= sessions.length) break;

        const session = sessions[idx];
        this.log(`[parallel] Worker starting session ${idx + 1}/${sessions.length}: ${session.sessionName || 'unnamed'}`);
        results[idx] = await this.run(session);
        this.log(`[parallel] Worker finished session ${idx + 1}/${sessions.length}: exit=${results[idx].exitCode}`);
      }
    };

    // Launch N workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < cap; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    this.log(`[parallel] All ${sessions.length} sessions complete`);
    return results;
  }

  private log(message: string): void {
    // Honor the verbose flag (it was previously a dead field — every session printed its
    // internal logs, which cluttered the interactive scope loop with "Starting session",
    // "Exit code", "Output length", and a false "suspiciously short output" warning every
    // turn). Behavior is driven by result flags (creditExhausted, exit codes), and
    // user-facing messages live in the callers, so gating these debug lines hides nothing
    // important. Run with -v / --verbose to see them.
    if (!this.verbose) return;
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} ${message}`);
  }
}

/**
 * Create a spawner instance bound to the active backend (or an explicit one).
 */
export function createSpawner(options?: { verbose?: boolean; backend?: AgentBackendSpec }): Spawner {
  return new Spawner(options);
}

/**
 * Reaper internals, exported for tests only. The behaviour under test is
 * "killing turkeycode kills its sessions", which needs real process groups —
 * asserting on it any other way asserts on nothing.
 */
export const _reaperInternals = { liveGroups, reapAllGroups, installReaper, exitCodeForSignal };
