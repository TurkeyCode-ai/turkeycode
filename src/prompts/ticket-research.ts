/**
 * Non-coding ticket research prompt.
 * Job: investigate a non-coding Jira ticket using aimem + repo context,
 * produce a Markdown draft to be posted back as a Jira comment, then STOP.
 */

import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';

export interface TicketResearchPromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  imagePaths: string[];
  /** File the session must write the Markdown comment draft to. */
  commentDraftPath: string;
  /** File the session must touch when done. */
  doneFile: string;
  /** Optional classifier summary from the triage step, to orient the session. */
  triageSummary?: string;
}

export function buildTicketResearchPrompt(input: TicketResearchPromptInput): string {
  const { ticket, manifest, imagePaths, commentDraftPath, doneFile, triageSummary } = input;

  const imageBlock = imagePaths.length > 0
    ? `\n## IMAGE ATTACHMENTS\nRead any of these images with the Read tool if they clarify the request:\n${imagePaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const repoBlock = manifest.repos.length > 0
    ? `\n## REPOS AVAILABLE\nYou may inspect these repos directly if useful, and you SHOULD consult aimem (MCP) for cross-repo understanding:\n${manifest.repos.map((r) => `- ${r.path}${r.role ? ` (${r.role})` : ''}`).join('\n')}\n`
    : '';

  return `
# NON-CODING TICKET RESEARCH

## YOUR SINGLE JOB
This Jira ticket has been classified as **non-coding** — it doesn't require a code change. Investigate it and produce a helpful Markdown response that will be posted back to the ticket as a comment.

${triageSummary ? `## TRIAGE SUMMARY\n${triageSummary}\n` : ''}
## TICKET
- Key: ${ticket.key}
- Type: ${ticket.issueType}
- Status: ${ticket.status}
- Priority: ${ticket.priority ?? 'unspecified'}
- Labels: ${ticket.labels.join(', ') || '(none)'}

<ticket_summary>
${ticket.summary}
</ticket_summary>

<ticket_description>
${ticket.description || '(no description)'}
</ticket_description>

${ticket.comments.length > 0 ? `<ticket_comments>\n${ticket.comments.map((c) => `[${c.author} @ ${c.created}]\n${c.body}`).join('\n---\n')}\n</ticket_comments>` : ''}
${imageBlock}${repoBlock}
## WHAT TO DO
1. Understand what the ticket is actually asking — re-read description and comments carefully.
2. Use aimem (MCP) to pull relevant context about the repos, prior decisions, and related work.
3. If the ticket references specific files, configs, or behavior, verify by reading them directly from the repos listed above.
4. If images are attached, inspect them when they're likely to inform the answer.
5. Draft a reply that:
   - Answers the question or addresses the request directly
   - Cites specific file paths, functions, or commits when relevant
   - Flags uncertainty honestly — don't fabricate specifics
   - Suggests concrete next steps if the requester still has follow-up work
   - Stays tight: a short, accurate answer beats a long vague one

## OUTPUT
Write your final draft to: ${commentDraftPath}

The file is plain Markdown. It will be posted verbatim as a Jira comment. Do not include a greeting or signature — just the substantive reply.

Then create ${doneFile} with any content to signal completion.

## RULES
- Do NOT modify any source files.
- Do NOT run builds, tests, or migrations.
- It's fine to read files, run read-only git commands, and query aimem.
- If the ticket turns out to actually require code changes, say so explicitly in the draft and stop — the human will reroute it.

STOP after writing the done file.
`.trim();
}
