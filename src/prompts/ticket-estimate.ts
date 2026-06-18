/**
 * Ticket estimate prompt.
 * Job: turn a plain-language request into a well-formed Jira ticket — classify it
 * as Bug vs Story (unless forced), write a crisp title + description with acceptance
 * criteria, and assign a Fibonacci story-point estimate. Output a single JSON file
 * and STOP. The orchestrator creates the real Jira ticket from this.
 */

export interface EstimatePromptInput {
  /** The user's plain-language request. */
  description: string;
  /** Force the issue type instead of letting the model classify. */
  forceType?: 'Bug' | 'Story';
  /** Optional repo/codebase context the session may read for sizing. */
  repoContext?: string;
  /** File the session must write the estimate JSON to. */
  outputPath: string;
  /** File the session must touch when done. */
  doneFile: string;
}

export function buildTicketEstimatePrompt(input: EstimatePromptInput): string {
  const { description, forceType, repoContext, outputPath, doneFile } = input;

  const typeRule = forceType
    ? `The issue type is FIXED as **${forceType}** — set "issueType" to "${forceType}" and do not reclassify.`
    : `Classify "issueType" as **"Bug"** if the request describes something broken/incorrect that should already work, otherwise **"Story"** for new capability or improvement.`;

  const contextBlock = repoContext
    ? `\n## CODEBASE CONTEXT\nUse this to size the work realistically:\n${repoContext}\n`
    : '';

  return `
# TICKET ESTIMATE

## YOUR SINGLE JOB
Turn the request below into one well-formed Jira ticket and a story-point estimate.
Write a JSON file and STOP. Do NOT write code, run builds, or change any files other
than the output file.

## REQUEST
<request>
${description}
</request>
${contextBlock}
## TYPE
${typeRule}

## ESTIMATE SCALE (Fibonacci — pick ONE)
- 1: trivial, one obvious change, no unknowns.
- 2: small, well-understood, touches one place.
- 3: moderate, a few moving parts, low risk.
- 5: substantial, multiple files/areas or some unknowns.
- 8: large, cross-cutting or meaningful unknowns.
- 13: very large or poorly understood — consider that it may need splitting (still pick 13).
Pick the value that matches the work, biased toward the smaller option when torn.

## OUTPUT
Write EXACTLY ONE JSON file to: ${outputPath}

Schema:
\`\`\`json
{
  "issueType": "Bug" | "Story",
  "title": "concise imperative summary (<= 12 words, no trailing period)",
  "description": "what to do and why, then an 'Acceptance criteria:' section as plain-text bullet lines starting with '- '",
  "points": 1 | 2 | 3 | 5 | 8 | 13,
  "rationale": "one sentence on why this size"
}
\`\`\`

Rules for the fields:
- "title" is the ticket summary line — sharp and specific, not a restatement of the whole request.
- "description" must be plain text (no markdown headers). Include acceptance criteria as '- ' bullet lines so the ticket is actionable.
- "points" MUST be exactly one of 1, 2, 3, 5, 8, 13.

Then create ${doneFile} with any content to signal completion.

STOP after writing the done file.
`.trim();
}
