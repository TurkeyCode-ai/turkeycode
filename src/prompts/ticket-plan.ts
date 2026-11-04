/**
 * Deep-tier ticket plan prompt.
 * Job: research the ticket (repos + read-only references) and write a plan
 * the build session follows. No code changes.
 */

import { oneTurnRule } from './one-turn';
import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';
import { renderReferenceBlock, renderTicketBlock } from './ticket-common';

export interface TicketPlanPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  imagePaths: string[];
  triageSummary?: string;
  /** Where the plan must be written. */
  planPath: string;
  doneFile: string;
}

export function buildTicketPlanPrompt(input: TicketPlanPromptInput): string {
  const { ticket, manifest, imagePaths, triageSummary, planPath, doneFile } = input;
  const images = imagePaths.length > 0
    ? `\n## IMAGE ATTACHMENTS\n${imagePaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';
  const repos = manifest.repos.map((r) => `- ${r.path}${r.role ? ` (${r.role})` : ''} [base: ${r.base}]`).join('\n');

  return `
# TICKET PLAN

## YOUR SINGLE JOB
Research Jira ticket **${ticket.key}** and write an implementation plan to \`${planPath}\`. A separate build session will implement it. Do NOT edit, stage or commit anything in any repo.

${triageSummary ? `## TICKET (triage summary)\n${triageSummary}\n` : ''}
${renderTicketBlock(ticket)}
${images}
## REPOS IN SCOPE
${repos}
${renderReferenceBlock(manifest)}
Read each repo's CLAUDE.md / CLAUDE.local.md first; their house rules apply to the plan.

## WHAT THE PLAN MUST COVER
1. **Source of truth.** If reference paths exist, find the code there that this ticket ports or mirrors. Cite file + paragraph/function for every rule you take from it (conditions, rounding, ordering, which records are read, when recalculation happens). If the references are genuinely silent, say "references silent on X" explicitly.
2. **Current state.** The existing code paths the change touches (file:line), and existing tests around them.
3. **Changes per repo.** Files to add/modify and what changes in each. Migrations (with the exact version number the repo's local instructions give), DTO/API shape, UI changes.
4. **Tests.** The cases to add or update, including the edge cases the source of truth implies.
5. **Out of scope / follow-ups.** Anything related but not in the ticket.
6. **Open questions.** Only real gaps the ticket and references can't answer; for each, the default you recommend.

Keep it concrete and short: a builder should be able to follow it without re-researching.

${oneTurnRule(doneFile, { completionGate: true })}

## DONE SIGNAL
Write the plan to \`${planPath}\`, then create ${doneFile} containing one line: \`plan written\`. Then STOP.
`.trim();
}
