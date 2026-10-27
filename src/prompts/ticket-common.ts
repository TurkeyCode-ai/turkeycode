/**
 * Shared blocks for the deep-tier ticket prompts (plan, review, fix).
 */

import { TicketDetail } from '../jira';
import { RepoManifest } from '../repos';

export function renderTicketBlock(ticket: TicketDetail): string {
  const comments = ticket.comments.length > 0
    ? `\n<ticket_comments>\n${ticket.comments.map((c) => `[${c.author} @ ${c.created}]\n${c.body}`).join('\n---\n')}\n</ticket_comments>`
    : '';
  return `## TICKET
- Key: ${ticket.key}
- Type: ${ticket.issueType}

<ticket_summary>
${ticket.summary}
</ticket_summary>

<ticket_description>
${ticket.description || '(no description)'}
</ticket_description>${comments}`;
}

export function renderReferenceBlock(manifest: RepoManifest): string {
  if (manifest.references.length === 0) return '';
  return `\n## READ-ONLY REFERENCE FILES\nResearch only (e.g. legacy code being ported). Do NOT modify, \`git\` against, or commit anything inside these paths.\n${manifest.references.map((r) => `- ${r.path}${r.role ? ` — ${r.role}` : ''}`).join('\n')}\n`;
}
