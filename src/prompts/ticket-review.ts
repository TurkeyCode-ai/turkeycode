/**
 * Deep-tier ticket review prompt.
 * Job: independently and adversarially review the ticket branch(es) against
 * the ticket, the references and the related repos; write cited findings as
 * JSON. No edits.
 *
 * The reviewer deliberately does NOT get the build session's transcript or its
 * build.done rationale — only the plan, framed as the builder's intent to be
 * challenged — so it can't be anchored by the builder's account of the work.
 */

import { oneTurnRule } from './one-turn';
import { TicketDetail } from '../jira';
import { RepoManifest, effectiveReviewChecklist } from '../repos';
import { renderReferenceBlock, renderRelatedBlock, renderTicketBlock, TICKET_PREMISE_CHECK } from './ticket-common';

export interface TicketReviewRepo {
  path: string;
  /** Base SHA the ticket branch was cut from; review `git diff <baseSha>..HEAD`. */
  baseSha: string;
  /** Set when the run used --base-local: the local ref this branch is intentionally built on. */
  localBase?: string;
}

export interface TicketReviewPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  repos: TicketReviewRepo[];
  branchName: string;
  planPath?: string;
  /** Prior round's findings (already handed to a fix session), if any. */
  priorFindingsPath?: string;
  /** The fix session's own report on the prior findings (\`fixed:\` / \`rejected: … — why\` lines), when it wrote one. */
  priorFixReportPath?: string;
  /** Set when the fix session for the prior findings did not finish (timed out or crashed). */
  priorFixIncomplete?: boolean;
  findingsPath: string;
  doneFile: string;
  /** 1-based review round; selects the lens (see reviewLens). Default 1. */
  round?: number;
  /** Total review rounds configured. With a single round the reviewer gets both lenses. */
  totalRounds?: number;
  /** Set when a previous attempt at this round produced nothing cited (treated as "not reviewed"). */
  uncitedRetry?: boolean;
}

export type ReviewLens = 'fidelity' | 'integration' | 'combined';

/**
 * Odd rounds: ticket + reference fidelity. Even rounds: integration, re-entry,
 * concurrency, bypass paths. Running the same brief twice finds the same
 * nothing, so consecutive rounds look through different lenses. A single-round
 * run gets both.
 */
export function reviewLens(round: number, totalRounds: number): ReviewLens {
  if (totalRounds <= 1) return 'combined';
  return round % 2 === 1 ? 'fidelity' : 'integration';
}

const FIDELITY_LENS = `### Lens: ticket + reference fidelity
- ${TICKET_PREMISE_CHECK}
- Does the change do what the (correct) requirement asks, completely? Missing pieces count.
- Fidelity to the read-only references: conditions, rounding, ordering, defaults, which records are read, when things recalculate. Open the cited code and compare line by line; don't trust comments, the ticket's paraphrase or the plan's.`;

const INTEGRATION_LENS = `### Lens: integration, re-entry, concurrency, bypass paths
- Every boundary the change crosses (bridge, API, queue, shared table): open the other side and check the contract both ways — what we send vs what it reads, what it sends vs what we read. A field one side has no slot for is a defect.
- Re-entry: the same message twice, out of order, a soft-deleted row coming back (revive vs re-insert), absent vs empty list, stale data reused on re-add.
- Concurrency: two messages or requests for the same record at once.
- Bypass paths: can the new rule be skipped by editing a different field or via another entry point?
- Callers: every caller and test that constructs or calls what changed.`;

const GENERAL_CHECKS = `### Always
- Real bugs: wrong logic, null/edge cases, transactions, broken callers, migrations that won't apply.
- Tests: do they exercise the behaviour with realistic data, and do they pass? A fixture that encodes the premise under review proves nothing.
- House-rule violations (scope creep, forbidden files committed, conventions).`;

function lensBlock(lens: ReviewLens): string {
  if (lens === 'fidelity') return FIDELITY_LENS;
  if (lens === 'integration') return INTEGRATION_LENS;
  return `${FIDELITY_LENS}\n\n${INTEGRATION_LENS}`;
}

/**
 * What the reviewer is told about the previous round. The fix session's report
 * is handed over so a finding it declined on purpose is judged on its reason,
 * not raised again as if nobody had looked.
 */
function priorRoundBlock(priorFindingsPath: string, fixReportPath: string | undefined, fixIncomplete: boolean): string {
  const report = fixReportPath
    ? ` Its own report is \`${fixReportPath}\`: each finding is listed as \`fixed:\` or \`rejected: <summary> — <why>\`.`
    : '';
  const state = fixIncomplete
    ? `The fix session that followed did NOT finish (it ran out of time or crashed), so some of those findings may be untouched or half done, and anything it had not committed was set aside.${report ? `${report} Treat it as partial.` : ''} Check every prior finding against the code as it is now and report the ones that still hold.`
    : `A fix session has since worked through it.${report} Verify the fixes (cite the fixed lines), then challenge them: a fix can be incomplete, inconsistent with the rest of the module, or introduce a new problem of its own.`;
  return `
## PREVIOUS ROUND
A previous review round produced \`${priorFindingsPath}\`. ${state}

A finding the fix session **rejected** was declined on purpose. Read its reason and check it against the code before doing anything with it:
- The reason is wrong: report the finding again as \`bug\` or \`should-fix\`, and say in \`fix\` what the rejection got wrong, with evidence.
- The reason holds, but the problem is real and a code session cannot settle it (it needs a person's decision, an identifier only a person can assign, access a session does not have): report it once with severity \`needs-human\` and put what the person must decide in \`fix\`. It goes into the final report for a person and is NOT sent to another fix session.
- The reason holds and nothing is left to do: record that under \`verified\`.
Do not raise a rejected finding again just because the code still looks the way it did.

Then look for anything new.
`;
}

export function buildTicketReviewPrompt(input: TicketReviewPromptInput): string {
  const { ticket, manifest, repos, branchName, planPath, priorFindingsPath, findingsPath, doneFile } = input;
  const round = input.round ?? 1;
  const totalRounds = input.totalRounds ?? 1;
  const lens = reviewLens(round, totalRounds);
  const repoLines = repos.map((r) => `- ${r.path}: \`git -C ${r.path} diff ${r.baseSha}..HEAD\``).join('\n');
  const localBased = repos.filter((r) => r.localBase);
  const localBaseNote = localBased.length
    ? `\n**Intended base:** ${localBased.map((r) => `${r.path} is built on the local ref \`${r.localBase}\``).join('; ')} (run with --base-local). Commits below that base are other unpushed work by design: review only the diff above, and do not report the base, the stacking, or commits that aren't in the diff, and never ask for a rebase.\n`
    : '';
  const checklist = effectiveReviewChecklist(manifest);

  const checklistBlock = checklist.length > 0
    ? `\n## KNOWN FAILURE MODES — check each explicitly and state which apply\nFor every item: either report a cited finding, or add a \`verified\` entry saying whether it applies to this change and what you checked (with citations). "N/A" still needs a reason.\n${checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
    : '';

  return `
# TICKET REVIEW (round ${round}${totalRounds > 1 ? ` of ${totalRounds}` : ''})

## YOUR SINGLE JOB
Independently and adversarially review the work on branch \`${branchName}\` for Jira ticket **${ticket.key}** and write your findings to \`${findingsPath}\`. Assume it is wrong until the code shows otherwise. Do NOT edit, stage, commit, switch branches or push. You may run the repos' tests and builds to verify a suspicion.
${input.uncitedRetry ? `\n**A previous attempt at this round produced no cited findings and no cited verified claims, so it was discarded as "not reviewed".** Every finding and every verified claim needs \`file:line\` evidence this time.\n` : ''}
${renderTicketBlock(ticket)}

## CHANGES TO REVIEW
${repoLines}
${localBaseNote}${planPath ? `\n## BUILDER'S INTENT — to be challenged\nThe builder worked from \`${planPath}\`. Treat it as a claim, not as context: it can inherit a wrong ticket, misread a reference, or miss the other side of a boundary. Check it against the ticket, the references and the related repos; never cite the plan as evidence.\n` : ''}${priorFindingsPath ? priorRoundBlock(priorFindingsPath, input.priorFixReportPath, input.priorFixIncomplete ?? false) : ''}${renderReferenceBlock(manifest)}${renderRelatedBlock(manifest)}
Each repo's CLAUDE.md / CLAUDE.local.md house rules are part of the bar.

## WHAT TO LOOK FOR
${lensBlock(lens)}

${GENERAL_CHECKS}
- If the change crosses a boundary (bridge, API, queue, shared table), open the other side and check the contract both ways.
${checklistBlock}
Report only defects you'd block a merge on (\`bug\`) or would ask to change (\`should-fix\`). No style nits, no praise.
Use \`needs-human\` instead when the defect is real but no code session can settle it: it needs a person's decision, an identifier only a person can assign, or access a session does not have. Say in \`fix\` what the person must decide. Those go to the person in the final report, not to a fix session, so do not use it for anything a fix session could do.

## EVIDENCE RULE
Every finding and every verified claim must cite at least one \`file:line\` (or \`file:start-end\`) in the changed code, a reference or a related repo — use absolute paths or paths relative to the repo named in \`repo\`. **Uncited findings and uncited verified claims are discarded.** A review with no cited findings and no cited verified claims counts as "not reviewed", not as clean.

${oneTurnRule(doneFile, { completionGate: true })}

## OUTPUT
Write \`${findingsPath}\` as JSON:
\`\`\`json
{
  "findings": [
    { "severity": "bug" | "should-fix" | "needs-human", "repo": "<repo path>", "file": "<path in repo>", "line": 0,
      "summary": "<the defect>", "fix": "<what to change>", "evidence": ["<file>:<line>", "..."] }
  ],
  "verified": [
    { "claim": "<what you checked and found correct, or why a failure mode does not apply>", "evidence": ["<file>:<line>", "..."] }
  ]
}
\`\`\`
An empty \`findings\` array with cited \`verified\` entries means the branch is clean. Then create ${doneFile} containing \`<n> findings\`, and STOP.
`.trim();
}
