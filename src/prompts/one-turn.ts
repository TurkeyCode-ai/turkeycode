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

/**
 * @param artifact what this session must write before it stops
 *   (e.g. "the verdict file", ".turkey/phases/phase-4/build.done")
 */
export function oneTurnRule(artifact: string): string {
  return `
## YOU GET ONE TURN — READ THIS BEFORE STARTING ANYTHING

This session is non-interactive. You get **one response**. There is no next
turn, nobody reads a message saying you are waiting, and when this response
ends every process you started is killed.

So:

- **Never start something in the background and wait for it.** No \`cmd &\`,
  no \`nohup\`, no "waiting for X to finish; will continue once it completes".
  That sentence ends the session having produced nothing, and the phase then
  fails on a gate that cannot tell the difference between "still thinking"
  and "gave up".
- **Run long work in the foreground, bounded.** \`timeout 120 <command>\`, or
  shrink the job until it fits. If a thorough check wants 10,000 iterations,
  run 200 and say so.
- **Never defer work to "after" something finishes.** If it cannot complete
  inside this turn, make it smaller.
- **Write ${artifact} before you stop — ALWAYS.** Even if something failed,
  hung, or you ran out of room. A missing artifact is not read as "still
  working"; it is read as a failure, and it costs a full rebuild cycle to
  discover. Partial results with an honest note beat silence every time.

If you catch yourself about to explain what you are waiting for: stop, write
${artifact} with what you already have, and put the explanation in it.
`.trim();
}
