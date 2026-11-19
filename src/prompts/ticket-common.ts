/**
 * Shared blocks for the ticket prompts (plan, build, review, fix).
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

export function renderRelatedBlock(manifest: RepoManifest): string {
  const related = manifest.related ?? [];
  if (related.length === 0) return '';
  return `\n## RELATED REPOS — live code this change must stay compatible with; read-only\nThe other side of a bridge, API, queue or shared table. Unlike references, this is current production code: a change here that the other side can't read (or that ignores what it sends) is a defect. Read/Grep them freely. Do NOT modify, branch, \`git\` against, or commit anything inside these paths.\n${related.map((r) => `- ${r.path}${r.role ? ` — ${r.role}` : ''}`).join('\n')}\n`;
}

/** "The ticket may be wrong" — shared by plan and review so the build doesn't inherit a false premise. */
export const TICKET_PREMISE_CHECK =
  "Check the ticket's premise against the references. Does the cited program, field or behaviour actually exist as described? Is there a newer program, a different field, or a different meaning? A ticket that is wrong about the legacy system is a `bug` finding, not a pass.";

/**
 * --base-local runs: tell plan/build sessions which local ref each repo is built on, so they don't "fix" the branch
 * back onto the default base (a CLAUDE.local.md or house rule naming another base is superseded for this run).
 */
export function renderLocalBaseBlock(localBases?: Record<string, string>): string {
  const entries = Object.entries(localBases ?? {});
  if (entries.length === 0) return '';
  return `\n## BRANCH BASE (this run)\n${entries.map(([path, ref]) => `- ${path}: the branch is built on the local ref \`${ref}\` on purpose; it contains unpushed work your change builds on.`).join('\n')}\nRead and build against that code. Do NOT reset, rebase or check out the default base branch (e.g. develop / origin/<base>); any instruction elsewhere, including CLAUDE.local.md, that names a different base branch is superseded for this run.\n`;
}
