/**
 * Claude Code session runner for turkey-enterprise-v3
 * Spawns claude --print sessions with proper timeout handling
 * v3: Adds runParallel() for concurrent session execution
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { SpawnOptions, SpawnResult } from './types';
import { DEFAULT_TIMEOUT_MS } from './constants';

const DEFAULT_MAX_CONCURRENT = 3;

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
  }): Promise<SpawnResult> {
    const {
      cwd,
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      sessionName = 'claude-session',
      doneFile
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

      // Spawn claude directly, write prompt to stdin
      const proc: ChildProcess = spawn('claude', [
        '--print',
        '--dangerously-skip-permissions',
        '--verbose',
        '--input-format', 'text'
      ], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'], // stdin piped for prompt, stdout/stderr piped for capture
        env: {
          ...process.env,
          CI: 'true' // Prevent interactive prompts
        }
      });

      // Write prompt directly to stdin and close it
      if (proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      // Helper to gracefully kill the process
      const killProcess = (reason: string) => {
        killed = true;
        this.log(`[${sessionName}] ${reason}, killing process...`);
        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore if already killed
        }
        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!proc.killed) {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Ignore if already killed
            }
          }
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

        // Detect rate limiting
        if (!rateLimited && (
          text.includes('rate limit') || text.includes('429') ||
          text.includes('too many requests') || text.includes('Rate limit')
        )) {
          this.log(`[${sessionName}] Rate limit detected in output`);
          rateLimited = true;
        }

        if (this.verbose) {
          process.stdout.write(text);
        }
      });

      // Collect stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        if (this.verbose) {
          process.stderr.write(text);
        }
      });

      // Handle process exit
      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        clearInterval(watchdog);
        if (doneFileInterval) clearInterval(doneFileInterval);
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
          rateLimited
        });
      });

      // Handle spawn errors
      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        clearInterval(watchdog);
        if (doneFileInterval) clearInterval(doneFileInterval);
        const durationMs = Date.now() - startTime;

        this.log(`[${sessionName}] Spawn error: ${err.message}`);

        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + '\n' + err.message,
          durationMs,
          rateLimited
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
