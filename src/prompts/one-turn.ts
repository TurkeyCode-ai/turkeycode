/**
 * The constraint every artifact-producing session needs, in one place.
 *
 * A 21-phase build stalled twice on the same thing. First the QA agent:
 * its ENTIRE output was one sentence — "Waiting for the background
 * fight-loop script to finish; will resume analysis once it completes." —
 * exit 0, no verdict, forever. `claude --print` has no next turn, so the
 * session ended there. Three overnight cycles died on it.
 *
 * That was fixed in qa-combined.ts. Then the FINAL phase's build gate
 * failed with an empty phase directory: same shape, different prompt.
 *
 * Which is the lesson — it was never a QA problem. Any session that must
 * leave an artifact behind has to be told it gets one turn, so the rule
 * lives here and every such prompt includes it.
 */

export interface OneTurnOptions {
  /**
   * The artifact IS the completion gate: writing it tells the orchestrator the
   * work is finished, and the gate only checks that it exists. These sessions
   * must NOT write it on failure, or a half-finished build passes the gate and
   * skips its retry. Reports and verdicts leave this off: there a partial
   * artifact with an honest note beats silence.
   */
  completionGate?: boolean;
  /** Where a completionGate session records unfinished work. Pass it only where a retry follows. */
  partialNotes?: string;
  /** Where the explanation goes when it isn't the artifact itself (e.g. the `notes` field). */
  explainIn?: string;
}

/**
 * @param artifact what this session must write before it stops
 *   (e.g. "the verdict file", ".turkey/phases/phase-4/build.done")
 */
export function oneTurnRule(artifact: string, options: OneTurnOptions = {}): string {
  const { completionGate = false, partialNotes, explainIn = 'it' } = options;

  const deliverRule = completionGate
    ? `- **Write ${artifact} only when the work is actually finished.** It is the
  gate: writing it says this is complete, and nothing re-checks that claim.
  ${partialNotes
    ? `If you cannot finish, commit what works, record what is left in ${partialNotes},
  and stop WITHOUT writing ${artifact}, so the orchestrator retries.`
    : `If you cannot finish, stop WITHOUT writing ${artifact} and say why. The run
  stops there so a human can look. That is better than passing on bad work.`}`
    : `- **Write ${artifact} before you stop — ALWAYS.** Even if something failed,
  hung, or you ran out of room. A missing artifact is not read as "still
  working"; it is read as a failure, and it costs a full rebuild cycle to
  discover. Partial results with an honest note beat silence every time.`;

  const closing = completionGate
    ? `If you catch yourself about to explain what you are waiting for: stop. Finish
something smaller, or leave ${artifact} unwritten${partialNotes ? ` and say why in ${partialNotes}` : ' and say why'}.`
    : `If you catch yourself about to explain what you are waiting for: stop, write
${artifact} with what you already have, and put the explanation in ${explainIn}.`;

  return `
## YOU GET ONE TURN — READ THIS BEFORE STARTING ANYTHING

This session is non-interactive. You get **one response**. There is no next
turn, nobody reads a message saying you are waiting, and when this response
ends every process you started is killed.

So:

- **Never wait on a background job to finish.** No \`nohup\`, no "waiting for X
  to finish; will continue once it completes". That sentence ends the session
  having produced nothing, and the phase then fails on a gate that cannot tell
  the difference between "still thinking" and "gave up".
- **The one exception is a long-lived service this task needs** (a dev server,
  a database). Start it with \`&\` as your instructions say, then poll it inside
  this same turn (\`sleep\`, \`curl\`). Never run a server under \`timeout\` in the
  foreground: that blocks, then kills it.
- **Run every other long job in the foreground, bounded.** \`timeout 120 <command>\`,
  or shrink the job until it fits. If a thorough check wants 10,000 iterations,
  run 200 and say so.
- **Never defer work to "after" something finishes.** If it cannot complete
  inside this turn, make it smaller.
${deliverRule}

${closing}
`.trim();
}
