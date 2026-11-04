/**
 * Deep-tier ticket fix prompt.
 * Job: fix every review finding on the ticket branch(es) and commit.
 */

import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';
import { renderReferenceBlock } from './ticket-common';

export interface TicketFixPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  branchName: string;
  findingsPath: string;
  planPath?: string;
  doneFile: string;
}

export function buildTicketFixPrompt(input: TicketFixPromptInput): string {
  const { ticket, manifest, branchName, findingsPath, planPath, doneFile } = input;
  const repos = manifest.repos.map((r) => `- ${r.path}`).join('\n');

  return `
# TICKET REVIEW FIXES

## YOUR SINGLE JOB
A reviewer found problems with the work for **${ticket.key}** (${ticket.summary}). The findings are in \`${findingsPath}\`. Fix every one on branch \`${branchName}\`, run the affected tests, commit, and STOP.

## REPOS
${repos}
${planPath ? `\nThe original plan is at \`${planPath}\`.\n` : ''}${renderReferenceBlock(manifest)}
Each repo's CLAUDE.md / CLAUDE.local.md house rules apply.

## PROCESS
1. Read each finding and check it against the code (and the references, when it is a fidelity finding). If a finding is wrong, don't change code for it; say why in the done file.
2. Fix the real ones. Update or add tests so each fix is covered.
3. Run the tests for every area you touched; they must pass.
4. Commit per repo with a message starting \`${ticket.key}:\` (stage explicit paths only).

## RULES
- Do NOT switch, create or delete branches. Do NOT push. Stay on \`${branchName}\`.
- Do NOT modify repos outside the list above or anything in the reference paths.

## DONE SIGNAL
Create ${doneFile} listing each finding as \`fixed: <summary>\` or \`rejected: <summary> — <why>\`. Then STOP.
`.trim();
}
