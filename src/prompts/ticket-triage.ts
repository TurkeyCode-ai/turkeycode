/**
 * Ticket triage prompt.
 * Job: classify a Jira ticket as 'coding' or 'non-coding' based on the ticket
 * content and available repo context. Output a single JSON verdict file and STOP.
 */

import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';

export interface TriagePromptInput {
  ticket: TicketDetail;
  manifest: RepoManifest;
  /** Absolute paths of downloaded image attachments, if any. */
  imagePaths: string[];
  /** File the session must write the verdict JSON to. */
  verdictPath: string;
  /** File the session must touch when done. */
  doneFile: string;
}

export function buildTicketTriagePrompt(input: TriagePromptInput): string {
  const { ticket, manifest, imagePaths, verdictPath, doneFile } = input;

  const imageBlock = imagePaths.length > 0
    ? `\n## IMAGE ATTACHMENTS\nThe following images are attached to this ticket. Read them with the Read tool if they help you classify the work:\n${imagePaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const repoBlock = manifest.repos.length > 0
    ? `\n## REPOS ON DISK\nThese are the repos in scope for this user's work. You do NOT need to read them in detail — use aimem (MCP) for repo context if you want to confirm whether this ticket would touch code:\n${manifest.repos.map((r) => `- ${r.path}${r.role ? ` (${r.role})` : ''}`).join('\n')}\n`
    : '';

  return `
# TICKET TRIAGE

## YOUR SINGLE JOB
Classify the Jira ticket below as either **coding** or **non-coding**, and write a JSON verdict.

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
## CLASSIFICATION RULES
- **coding** = the ticket's acceptance criteria require changes to source code, tests, build config, or infrastructure-as-code files in one or more of the listed repos.
- **non-coding** = research, investigation, documentation, process, planning, stakeholder questions, access requests, meeting prep, spikes with no code deliverable, or anything that can be resolved with a written response rather than a code change.

Ambiguous tickets that *might* need code should be classified as **coding**.

## OUTPUT
Write EXACTLY ONE JSON file to: ${verdictPath}

Schema:
\`\`\`json
{
  "classification": "coding" | "non-coding",
  "confidence": "high" | "medium" | "low",
  "reason": "one-sentence rationale",
  "summary": "one-paragraph restatement of what this ticket is asking for, in your own words"
}
\`\`\`

Then create ${doneFile} with any content to signal completion.

## RULES
- Do NOT edit any source files.
- Do NOT run any build/test commands.
- Do NOT read repo contents in detail — aimem is sufficient if you need context.
- Only output the verdict JSON and the done signal.

STOP after writing the done file.
`.trim();
}
