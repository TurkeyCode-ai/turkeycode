/**
 * Deep-tier ticket fix prompt.
 * Job: fix every review finding on the ticket branch(es) and commit.
 */

import { oneTurnRule } from './one-turn';
import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';
import { renderReferenceBlock, renderRelatedBlock } from './ticket-common';

export interface TicketFixPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  branchName: string;
  findingsPath: string;
  planPath?: string;
  doneFile: string;
  /** --base-local runs: repo path -> the local ref the branch is intentionally built on. */
  localBases?: Record<string, string>;
}

export function buildTicketFixPrompt(input: TicketFixPromptInput): string {
  const { ticket, manifest, branchName, findingsPath, planPath, doneFile, localBases } = input;
  const repos = manifest.repos
    .map((r) => `- ${r.path}${localBases?.[r.path] ? ` (built on the local ref \`${localBases[r.path]}\` on purpose)` : ''}`)
    .join('\n');

  return `
# TICKET REVIEW FIXES

## YOUR SINGLE JOB
A reviewer found problems with the work for **${ticket.key}** (${ticket.summary}). The findings are in \`${findingsPath}\`. Fix every one on branch \`${branchName}\`, run the affected tests, commit, and STOP.

## REPOS
${repos}
${planPath ? `\nThe original plan is at \`${planPath}\`.\n` : ''}${renderReferenceBlock(manifest)}${renderRelatedBlock(manifest)}
Each repo's CLAUDE.md / CLAUDE.local.md house rules apply.

## PROCESS
1. Read each finding and open its \`evidence\` citations; check it against the code (and the references, when it is a fidelity finding). If a finding is wrong, don't change code for it; say why in the done file.
2. Fix the real ones, one finding at a time. Update or add tests so each fix is covered.
3. Run the tests for the area you touched; they must pass.
4. Commit each finished fix before starting the next, with a message starting \`${ticket.key}:\` (stage explicit paths only). The session has a time limit, and only committed work survives it.

## RULES
- Do NOT switch, create or delete branches. Do NOT push. Stay on \`${branchName}\`.
- Do NOT rebase, reset or move the branch onto another base; the orchestrator rebases at the end. A finding that asks for a different base is not a code fix: reject it in the done file.
- A finding with severity \`needs-human\` has already been judged to need a person. Do not attempt it; list it as rejected with the same reason.
- If a real finding cannot be fixed by a code session (it needs a person's decision, an identifier only a person can assign, or access you don't have), do not improvise around it: reject it and say exactly what the person has to decide or supply. The next reviewer reads your reasons.
- Do NOT modify repos outside the list above or anything in the reference or related-repo paths.

${oneTurnRule(doneFile)}

## DONE SIGNAL
Create ${doneFile} listing each finding as \`fixed: <summary>\` or \`rejected: <summary> — <why>\`. Then STOP.
`.trim();
}
