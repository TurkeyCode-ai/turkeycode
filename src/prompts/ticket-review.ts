/**
 * Deep-tier ticket review prompt.
 * Job: independently review the ticket branch(es) against the ticket, the
 * plan and the read-only references; write findings as JSON. No edits.
 */

import { oneTurnRule } from './one-turn';
import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';
import { renderReferenceBlock, renderTicketBlock } from './ticket-common';

export interface TicketReviewRepo {
  path: string;
  /** Base SHA the ticket branch was cut from; review `git diff <baseSha>..HEAD`. */
  baseSha: string;
}

export interface TicketReviewPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  repos: TicketReviewRepo[];
  branchName: string;
  planPath?: string;
  /** Prior round's findings (already handed to a fix session), if any. */
  priorFindingsPath?: string;
  findingsPath: string;
  doneFile: string;
}

export function buildTicketReviewPrompt(input: TicketReviewPromptInput): string {
  const { ticket, manifest, repos, branchName, planPath, priorFindingsPath, findingsPath, doneFile } = input;
  const repoLines = repos.map((r) => `- ${r.path}: \`git -C ${r.path} diff ${r.baseSha}..HEAD\``).join('\n');

  return `
# TICKET REVIEW

## YOUR SINGLE JOB
Independently review the work on branch \`${branchName}\` for Jira ticket **${ticket.key}** and write your findings to \`${findingsPath}\`. Do NOT edit, stage, commit, switch branches or push. You may run the repos' tests and builds to verify a suspicion.

${renderTicketBlock(ticket)}

## CHANGES TO REVIEW
${repoLines}
${planPath ? `\nThe builder worked from the plan at \`${planPath}\`. The plan can be wrong too — check it against the ticket and the references.\n` : ''}${priorFindingsPath ? `\nA previous review round produced \`${priorFindingsPath}\` and a fix session has since addressed it. Verify those fixes and look for anything new.\n` : ''}${renderReferenceBlock(manifest)}
Each repo's CLAUDE.md / CLAUDE.local.md house rules are part of the bar.

## WHAT TO LOOK FOR
- Does the change do what the ticket asks, completely? Missing pieces count.
- Fidelity to the read-only references (when present): conditions, rounding, ordering, defaults, when things recalculate. Open the cited code and compare; don't trust comments.
- Real bugs: wrong logic, null/edge cases, transactions, broken callers, migrations that won't apply, API/UI contract mismatches between repos.
- Tests: do they exercise the behaviour, and do they pass?
- House-rule violations (scope creep, forbidden files committed, conventions).

Report only defects you'd block a merge on (\`bug\`) or would ask to change (\`should-fix\`). No style nits, no praise.

${oneTurnRule(doneFile, { completionGate: true })}

## OUTPUT
Write \`${findingsPath}\` as JSON:
\`\`\`json
{ "findings": [ { "severity": "bug" | "should-fix", "repo": "<repo path>", "file": "<path in repo>", "line": 0, "summary": "<the defect>", "fix": "<what to change>" } ] }
\`\`\`
An empty \`findings\` array means the branch is clean. Then create ${doneFile} containing \`<n> findings\`, and STOP.
`.trim();
}
