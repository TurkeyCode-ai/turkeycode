/**
 * Interactive scope correction loop, extracted so both `turkeycode scope` and
 * `turkeycode run` (auto-scope on a bare description) drive the same engine.
 *
 * The loop re-spawns `claude --print` each turn with the transcript re-embedded
 * (the spawner has no session-resume), reads back the agent's working model to
 * show the human, and emits the spec on an explicit confirmation. See
 * `src/prompts/scope.ts` for the method/contract the agent follows.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from 'fs';
import { createInterface } from 'readline/promises';
import { Spawner } from './spawner';
import { buildScopePrompt, ScopeTurn } from './prompts/scope';
import {
  getModelForPhase,
  REFERENCE_DIR,
  SCOPE_DONE,
  SCOPE_WORKING_FILE,
  SCOPE_TURN_TIMEOUT_MS,
} from './constants';

// Color only when writing to an interactive terminal that hasn't opted out via
// NO_COLOR (https://no-color.org). Piped/redirected output stays plain so the
// working model reads cleanly in logs and the SaaS chat shell.
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open: string, text: string, close = '0'): string =>
  USE_COLOR ? `\x1b[${open}m${text}\x1b[${close}m` : text;

/**
 * Render the markdown subset the scope working-model emits (ATX headers,
 * **bold**, `code`, `-`/`*` bullets, `---` rules) as ANSI for the terminal.
 * Dependency-free and a no-op for color when output isn't a TTY.
 */
export function renderScopeMarkdown(md: string): string {
  // Inline spans: bold (**x**) then code (`x`). Order matters so backticks
  // inside bold still render. Bold uses 1m/22m so it nests inside a colored line.
  const inline = (s: string): string =>
    s
      .replace(/\*\*(.+?)\*\*/g, (_m, t) => sgr('1', t, '22'))
      .replace(/`([^`]+?)`/g, (_m, t) => sgr('36', t)); // cyan for code

  return md
    .split('\n')
    .map((line) => {
      const header = line.match(/^(#{1,6})\s+(.*)$/);
      if (header) {
        const text = inline(header[2].trim());
        // h1 = bold underline, h2+ = bold. Keeps the hierarchy without color noise.
        return header[1].length === 1 ? sgr('1;4', text) : sgr('1', text);
      }
      // Horizontal rule (--- / *** / ___) → a dim divider.
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        return sgr('2', '─'.repeat(40));
      }
      const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (bullet) {
        return `${bullet[1]}${sgr('2', '•')} ${inline(bullet[2])}`;
      }
      return inline(line);
    })
    .join('\n');
}

export interface ScopeSessionOptions {
  description: string;
  /** Seed spec/notes content to start the working model from. */
  seedSpec?: string;
  /** Override the model used for the scoping agent. */
  model?: string;
  /** Stream the underlying session output. */
  verbose?: boolean;
}

export interface ScopeSessionResult {
  /** A fresh spec was confirmed and written this session. */
  emitted: boolean;
  /** The human aborted (typed "abort"/"/quit") or closed stdin (Ctrl-D/EOF). */
  aborted: boolean;
  /** The session stopped because credit/usage was exhausted. */
  creditExhausted: boolean;
}

/**
 * Run the interactive scope loop to convergence. Prints restatements and reads
 * corrections from stdin; on explicit confirmation the agent writes the spec
 * artifacts (specs.md, scope-decisions.md, scope.done) and we return emitted.
 *
 * Does NOT print a banner or do the final gate check — callers own that framing.
 */
export async function runScopeSession(opts: ScopeSessionOptions): Promise<ScopeSessionResult> {
  const { description, seedSpec, verbose } = opts;

  mkdirSync(REFERENCE_DIR, { recursive: true });

  // Start a fresh session by clearing only our display scratch file. We do NOT delete
  // a prior scope.done/specs.md here: if this session is aborted, a previously-confirmed
  // scope must survive intact (otherwise a later `run` would clobber specs.md). Emit
  // detection below uses mtime, so a stale scope.done from a prior run is ignored without
  // being destroyed.
  if (existsSync(SCOPE_WORKING_FILE)) rmSync(SCOPE_WORKING_FILE);

  // Snapshot a prior confirmed marker so we can restore it if this session ends without
  // a fresh emit (e.g. abort, or a misbehaving agent that overwrote it pre-confirmation).
  const priorScopeDone = existsSync(SCOPE_DONE) ? readFileSync(SCOPE_DONE, 'utf-8') : null;

  const spawner = new Spawner({ verbose: verbose === true });
  const model = opts.model || getModelForPhase('scope');
  const transcript: ScopeTurn[] = [];
  let workingModel = '';
  const MAX_TURNS = 50; // backstop against a runaway loop

  // Buffered line reader: lines typed/piped while a turn's session is running are
  // queued (not lost), so both interactive TTY and piped stdin work. nextLine()
  // resolves null on EOF.
  const rl = createInterface({ input: process.stdin });
  const lineQueue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let stdinClosed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  const nextLine = (): Promise<string | null> => {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
    if (stdinClosed) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  };

  let emitted = false;
  let aborted = false;
  let creditExhausted = false;
  let emptyStreak = 0; // consecutive turns the agent produced no working model
  const MAX_EMPTY_STREAK = 3;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Timestamp before the spawn so we can tell a scope.done written BY THIS turn
      // apart from a stale one left by a prior run (which we must not honor or destroy).
      const turnStartMs = Date.now();
      const prompt = buildScopePrompt({ description, seedSpec, transcript, workingModel });
      const result = await spawner.run({
        cwd: process.cwd(),
        prompt,
        timeoutMs: SCOPE_TURN_TIMEOUT_MS,
        sessionName: 'scope',
        doneFile: SCOPE_DONE,
        model,
      });

      if (result.creditExhausted) {
        console.error('\nCredit/usage exhausted — stopping. Re-run when credit is available.');
        creditExhausted = true;
        break;
      }

      // The agent rewrites the working model every turn; read it back to show the human.
      if (existsSync(SCOPE_WORKING_FILE)) {
        workingModel = readFileSync(SCOPE_WORKING_FILE, 'utf-8');
      }

      // Emit only when scope.done was written by THIS turn AND a human has actually
      // spoken (a real confirmation). On the opening turn no human input exists yet, so
      // a scope.done is necessarily premature — discard it rather than emit unconfirmed.
      // The mtime check ignores (and preserves) any stale scope.done from a prior run.
      const humanSpoke = transcript.some((t) => t.role === 'human');
      const doneThisTurn =
        existsSync(SCOPE_DONE) && statSync(SCOPE_DONE).mtimeMs >= turnStartMs;
      if (doneThisTurn && humanSpoke) {
        emitted = true;
        break;
      }
      if (doneThisTurn && !humanSpoke) {
        rmSync(SCOPE_DONE, { force: true }); // premature emit with no confirmation — drop it
        console.log('\n(Ignoring a spec emitted before any confirmation — keep going.)');
      }

      if (!workingModel.trim()) {
        if (++emptyStreak >= MAX_EMPTY_STREAK) {
          console.log(`\nThe session produced no working model ${MAX_EMPTY_STREAK} times running — stopping.`);
          console.log('Check your Claude CLI/auth, then re-run.');
          break;
        }
        console.log('\n(The session produced no working model this turn. Retrying — rephrase if this repeats.)');
        if (result.exitCode !== 0) {
          console.log(`(session exit code ${result.exitCode})`);
        }
        continue;
      }
      emptyStreak = 0;

      console.log('\n────────────────────────────────────────────────────────────');
      console.log(renderScopeMarkdown(workingModel.trim()));
      console.log('────────────────────────────────────────────────────────────');

      // The final allowed turn is reserved for processing the last input (the spawn
      // above), so don't solicit a new correction we'd have no turn left to act on.
      if (turn === MAX_TURNS - 1) {
        console.log(`\nReached the maximum of ${MAX_TURNS} scoping turns without a confirmation — stopping.`);
        break;
      }

      process.stdout.write('\nYou › ');
      const raw = await nextLine();
      if (raw === null) {
        aborted = true; // Ctrl-D / EOF / closed stream
        break;
      }
      const answer = raw.trim();

      if (answer.toLowerCase() === 'abort' || answer.toLowerCase() === '/quit') {
        aborted = true;
        break;
      }

      // Empty input is not confirmation — record it as "no change" and keep refining.
      transcript.push({ role: 'human', content: answer || '(no change — keep refining)' });
    }
  } finally {
    rl.close();
  }

  // If we didn't emit a fresh spec, make sure a prior confirmed marker survives this
  // session intact (it may have been dropped as a premature emit, or overwritten).
  if (!emitted && priorScopeDone !== null && !existsSync(SCOPE_DONE)) {
    writeFileSync(SCOPE_DONE, priorScopeDone);
  }

  return { emitted, aborted, creditExhausted };
}
