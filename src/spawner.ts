/**
 * Claude Code session runner for turkeycode
 * Spawns claude --print sessions with proper timeout handling
 * v3: Adds runParallel() for concurrent session execution
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { SpawnOptions, SpawnResult } from './types';
import { DEFAULT_TIMEOUT_MS } from './constants';

const DEFAULT_MAX_CONCURRENT = 3;

const TRANSIENT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
];

// Markers that the text is an actual Anthropic API error (not application content).
// Credit wording only counts as exhaustion when it co-occurs with one of these — this
// is the guardrail: the build/QA agents work on real apps, and finance/fintech domains
// are saturated with "credit", "balance", "billing cycle", "monthly", "insufficient
// funds". Without requiring API context, those false-trip exhaustion and kill the build.
const API_ERROR_CONTEXT: RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /rate_limit_error/i,
  /x-ratelimit/i,
  /anthropic/i,
];

// Credit/usage-exhaustion wording. Deliberately omits bare "balance"/"funds"/"billing
// cycle"/"monthly" — those are ordinary domain words. Even these only fire alongside
// API_ERROR_CONTEXT (see detectRateLimitSignals).
const CREDIT_EXHAUSTED_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient credit/i,
  /out of credit/i,
  /credit[^.\n]{0,30}exhaust/i,
  /usage limit reached/i,
  /monthly credit/i,
  /extra usage/i,
  /purchase (more )?credit/i,
];

/**
 * Classify a chunk of CLI output for rate-limit signals. Credit exhaustion is only
 * declared when credit/usage wording co-occurs with an actual API-error marker —
 * otherwise application-domain text (e.g. a banking app's "insufficient credit") would
 * false-trip it and the orchestrator would fail the build for a non-existent rate limit.
 */
export function detectRateLimitSignals(text: string): { rateLimited: boolean; creditExhausted: boolean } {
  const hasApiContext = API_ERROR_CONTEXT.some(p => p.test(text));
  const hasCreditWording = CREDIT_EXHAUSTED_PATTERNS.some(p => p.test(text));
  const creditExhausted = hasCreditWording && hasApiContext;
  const rateLimited = creditExhausted || TRANSIENT_RATE_LIMIT_PATTERNS.some(p => p.test(text));
  return { rateLimited, creditExhausted };
}

/**
 * Spawner class for running Claude Code sessions
 * Each session gets ONE job and exits when done
 */
export class Spawner {
  private verbose: boolean;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose ?? false;
  }

  /**
   * Run a Claude Code session with the given prompt
   * Returns when the session completes or times out
   */
  async run(options: {
    cwd: string;
    prompt: string;
    timeoutMs?: number;
    sessionName?: string;
    doneFile?: string;
    model?: string;
    /** Path to an MCP config JSON (e.g. for aimem). Defaults to TURKEYCODE_MCP_CONFIG env var. */
    mcpConfig?: string;
  }): Promise<SpawnResult> {
    const {
      cwd,
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      sessionName = 'claude-session',
      doneFile,
      model,
      mcpConfig = process.env.TURKEYCODE_MCP_CONFIG,
    } = options;

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
        const signal = detectRateLimitSignals(text);
        if (signal.creditExhausted && !creditExhausted) {
          creditExhausted = true;
          this.log(`[${sessionName}] Credit/usage exhaustion detected in output (will not retry)`);
        }
        if (signal.rateLimited && !rateLimited) {
          rateLimited = true;
          this.log(`[${sessionName}] Rate limit detected in output`);
        }
      };

      // Spawn claude directly, write prompt to stdin
      // Pass through all env vars including ANTHROPIC_API_KEY
      // On droplets: API key is required (no login session available)
      // On server with Max login: Claude CLI prefers login over API key automatically
      const cleanEnv = { ...process.env };

      // Safety net: strip dangerous env vars even if caller forgot to
      const NEVER_PASS_VARS = [
        'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
        'SENDGRID_API_KEY', 'NEXTAUTH_SECRET', 'SESSION_SECRET',
        'CLAUDECODE',  // Prevent "nested session" error when run inside Claude Code
      ];
      // By default strip ANTHROPIC_API_KEY so the CLI uses the Max login session.
      // In headless / API-key mode (no login session — e.g. a CI or other
      // non-interactive environment) set TURKEYCODE_USE_API_KEY=1 to KEEP the
      // key as the auth source.
      if (process.env.TURKEYCODE_USE_API_KEY !== '1') {
        NEVER_PASS_VARS.push('ANTHROPIC_API_KEY');
      }
      for (const key of NEVER_PASS_VARS) {
        delete cleanEnv[key];
      }

      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--verbose',
        '--input-format', 'text'
      ];

      if (model) {
        args.push('--model', model);
        this.log(`[${sessionName}] Using model: ${model}`);
      }

      if (mcpConfig) {
        if (!existsSync(mcpConfig)) {
          this.log(`[${sessionName}] WARNING: mcpConfig path not found: ${mcpConfig} — skipping`);
        } else {
          args.push('--mcp-config', mcpConfig);
          this.log(`[${sessionName}] MCP config: ${mcpConfig}`);
        }
      }

      const proc: ChildProcess = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'], // stdin piped for prompt, stdout/stderr piped for capture
        // Own process group so we can reap the WHOLE tree. A QA/fix session
        // backgrounds a dev server and (for visual QA) headless Chrome with `&`;
        // those outlive the claude process and, across a multi-phase build, pile
        // up until the jail OOMs. detached:true puts them in claude's group.
        detached: true,
        env: {
          ...cleanEnv,
          CI: 'true' // Prevent interactive prompts
        }
      });

      // Kill claude AND everything it backgrounded (dev servers, Chrome) by
      // signalling the process group (negative pid). Safe to call repeatedly.
      const reapGroup = (signal: NodeJS.Signals = 'SIGKILL'): void => {
        if (!proc.pid) return;
        try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
      };

      // Write prompt directly to stdin and close it
      if (proc.stdin) {
        proc.stdin.write(prompt);
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
        // Reap any dev server / Chrome the session backgrounded and left running —
        // this is what otherwise accumulates across phases until the jail OOMs.
        reapGroup();
        const durationMs = Date.now() - startTime;

        // Exit code: 0 if done file was detected (task succeeded), 124 for timeout, otherwise actual code
        const exitCode = doneFileDetected ? 0 : killed ? 124 : (code ?? 1);

        this.log(`[${sessionName}] Session completed`);
        this.log(`[${sessionName}] Exit code: ${exitCode}${doneFileDetected ? ' (done file detected)' : ''}`);
        this.log(`[${sessionName}] Duration: ${durationMs}ms`);
        this.log(`[${sessionName}] Output length: ${stdout.length} chars`);

        // Warn if output is suspiciously short (< 100 chars usually means Claude didn't execute)
        if (stdout.length < 100 && exitCode === 0 && !doneFileDetected) {
          this.log(`[${sessionName}] WARNING: Suspiciously short output - Claude may not have executed the task`);
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
  async runSequence(sessions: Array<{
    cwd: string;
    prompt: string;
    timeoutMs?: number;
    sessionName?: string;
    doneFile?: string;
    model?: string;
    mcpConfig?: string;
  }>): Promise<SpawnResult[]> {
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
    sessions: Array<{
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      sessionName?: string;
      doneFile?: string;
      model?: string;
      mcpConfig?: string;
    }>,
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
 * Create a spawner instance
 */
export function createSpawner(options?: { verbose?: boolean }): Spawner {
  return new Spawner(options);
}
