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
    ? `\n## AVAILABLE REPOS (writable — these are the only candidates for the \`repos\` output field)\nThese are every git repo this user can change. Each \`role\` describes what that repo owns. If you classify the ticket as **coding**, you must also pick the SUBSET of these repos whose source code actually needs to change to deliver the ticket. Use aimem (MCP) for repo context if you want to confirm. List repos by their EXACT path string from below — do not paraphrase.\n${manifest.repos.map((r) => `- ${r.path}${r.role ? ` — ${r.role}` : ''}`).join('\n')}\n`
    : '';

  const referenceBlock = manifest.references.length > 0
    ? `\n## REFERENCE FILES (read-only — DO NOT include in \`repos\` output)\nThese paths exist for research only (e.g. legacy code being ported). They may not even be git repos. The build session can read from them, but they are NEVER targets for change. Do not list any of these paths in your \`repos\` field.\n${manifest.references.map((r) => `- ${r.path}${r.role ? ` — ${r.role}` : ''}`).join('\n')}\n`
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
${imageBlock}${repoBlock}${referenceBlock}
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
  "summary": "one-paragraph restatement of what this ticket is asking for, in your own words",
  "repos": ["/exact/path/from/list/above", "..."]
}
\`\`\`

For \`repos\`:
- If \`classification\` is **coding**: list ONLY the repos whose source code must change. Tickets typically touch a single service. Be conservative — do not include a repo "just in case".
- If \`classification\` is **non-coding**: use \`[]\`.
- Use the exact path strings shown in the AVAILABLE REPOS list. The orchestrator matches by string equality and will fail the run if any path doesn't match.

Then create ${doneFile} with any content to signal completion.

## RULES
- Do NOT edit any source files.
- Do NOT run any build/test commands.
- Do NOT read repo contents in detail — aimem is sufficient if you need context.
- Only output the verdict JSON and the done signal.

STOP after writing the done file.
`.trim();
}
