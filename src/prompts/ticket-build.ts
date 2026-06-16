/**
 * Ticket-driven build prompt.
 * Job: implement a Jira ticket across one or more repos listed in the manifest.
 * The session may touch any repo; turkeycode detects touched repos post-build
 * and pushes each one's branch separately.
 */

import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';

export interface TicketBuildPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  /** Branch name that has ALREADY been checked out in each repo. */
  branchName: string;
  /** Paths of downloaded image attachments. */
  imagePaths: string[];
  /** Optional one-paragraph restatement of the ticket from the triage step. */
  triageSummary?: string;
  /** File the session must touch when the build is done. */
  doneFile: string;
}

export function buildTicketBuildPrompt(input: TicketBuildPromptInput): string {
  const { ticket, manifest, branchName, imagePaths, triageSummary, doneFile } = input;

  const imageBlock = imagePaths.length > 0
    ? `\n## IMAGE ATTACHMENTS\nRead these with the Read tool when they're relevant to what you're building:\n${imagePaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const repoLines = manifest.repos.map((r) => {
    const parts = [`- ${r.path}`];
    if (r.role) parts.push(`(${r.role})`);
    parts.push(`[base: ${r.base}]`);
    if (r.start) parts.push(`[start: ${r.start}]`);
    return parts.join(' ');
  }).join('\n');

  return `
# TICKET BUILD

## YOUR SINGLE JOB
Implement Jira ticket **${ticket.key}** across the repos listed below. The ticket branch \`${branchName}\` has ALREADY been created and checked out in every repo — you only need to make code changes and commit them.

${triageSummary ? `## TICKET (triage summary)\n${triageSummary}\n` : ''}
## TICKET
- Key: ${ticket.key}
- Type: ${ticket.issueType}
- Priority: ${ticket.priority ?? 'unspecified'}
- Labels: ${ticket.labels.join(', ') || '(none)'}

<ticket_summary>
${ticket.summary}
</ticket_summary>

<ticket_description>
${ticket.description || '(no description)'}
</ticket_description>

${ticket.comments.length > 0 ? `<ticket_comments>\n${ticket.comments.map((c) => `[${c.author} @ ${c.created}]\n${c.body}`).join('\n---\n')}\n</ticket_comments>` : ''}
${imageBlock}
## REPOS IN SCOPE
${repoLines}

All repos are on branch \`${branchName}\` (cut off their configured base branch). You may \`cd\` between them with the Bash tool as needed. Use aimem (MCP) for cross-repo understanding before making changes.

## PROCESS
1. **Understand** the ticket: re-read description and comments. Consult aimem for repo context, conventions, and related prior work.
2. **Plan** which repos must change and roughly what in each. Keep the plan in your head — don't write a separate plan file.
3. **Implement** the change. Follow each repo's existing conventions (imports, error handling, tests). Touch only repos that genuinely need changes.
4. **Commit per repo**: in each repo you modify, stage the changes and make one or more coherent commits. Commit messages should reference ${ticket.key} in the first line (e.g. \`${ticket.key}: add foo handler\`). Do NOT push — turkeycode handles pushing.
5. **Tests**: if the repo has tests covering the change area, run them and make sure they pass. Add new tests when they're a natural fit. Do not fabricate passing tests.
6. **Don't touch unrelated repos.** If aimem suggests a repo isn't affected, skip it entirely.

## RULES
- Do NOT switch branches. Do NOT delete branches. Do NOT push.
- Do NOT modify repos that aren't in the list above.
- Do NOT create new branches.
- All commits must land on \`${branchName}\` in their respective repos.
- If the ticket turns out to be unbuildable as specified (missing info, blocked by external dependency), STOP, write a short explanation to ${doneFile}, and exit. Do not push broken code just to satisfy the done signal.

## DONE SIGNAL
When you're finished, create ${doneFile} with a short summary:
\`\`\`
Touched repos: <list>
Summary: <2-3 sentence description of what you changed>
Follow-ups: <anything left for the reviewer to verify, or 'none'>
\`\`\`

Then STOP.
`.trim();
}
