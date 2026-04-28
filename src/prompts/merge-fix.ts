/**
 * Merge-conflict resolution prompt.
 * Job: resolve rebase conflicts in a single repo, continue the rebase, and STOP.
 * Invoked by turkeycode after `git rebase origin/<base>` fails.
 */

export interface MergeFixPromptInput {
  /** Absolute path of the repo where rebase is in progress. */
  repoPath: string;
  /** Branch being rebased. */
  branchName: string;
  /** Base branch the rebase is onto. */
  baseBranch: string;
  /** Paths (relative to repoPath) that currently have unresolved conflicts. */
  conflictedPaths: string[];
  /** Ticket context so the session understands intent. */
  ticketKey: string;
  ticketSummary: string;
  /** File the session must touch when done. */
  doneFile: string;
}

export function buildMergeFixPrompt(input: MergeFixPromptInput): string {
  const { repoPath, branchName, baseBranch, conflictedPaths, ticketKey, ticketSummary, doneFile } = input;

  return `
# REBASE CONFLICT RESOLUTION

## YOUR SINGLE JOB
A rebase of \`${branchName}\` onto \`origin/${baseBranch}\` in the repo at \`${repoPath}\` hit merge conflicts. Resolve them, continue the rebase to completion, and STOP.

## CONTEXT
- Ticket: ${ticketKey}
- Ticket summary: ${ticketSummary}
- Repo: ${repoPath}
- Branch: ${branchName}
- Base: origin/${baseBranch}
- Conflicted paths (as of when this session started):
${conflictedPaths.map((p) => `  - ${p}`).join('\n')}

## PROCESS
1. \`cd ${repoPath}\`
2. For each conflicted file:
   - Read the file. Find all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
   - Understand both sides: the \`HEAD\` side is what the base branch looks like now; the other side is the ticket's change.
   - Resolve semantically — keep the intent of the ticket **and** whatever the base branch added. Do NOT just pick one side unless you're certain the other is superseded.
   - For mechanical conflicts (imports, lockfiles, import order, formatting): regenerate / re-sort rather than hand-pick.
   - For lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, Gemfile.lock, Cargo.lock): prefer running the package manager's install command to regenerate cleanly.
   - For genuinely conflicting logic: keep both intents if possible. If truly impossible, prefer the ticket's change and leave a short code comment noting the tradeoff.
3. After each file: \`git add <file>\`.
4. When all files are resolved: \`git rebase --continue\` (set GIT_EDITOR=true so commit messages pass through unchanged).
5. If the next commit raises a NEW conflict, repeat steps 2-4 for the new conflicted files.
6. Continue until \`git status\` shows no rebase in progress and the working tree is clean.

## VERIFY
Before writing the done file, verify:
- \`git status\` shows no "rebase in progress"
- \`git log --oneline origin/${baseBranch}..HEAD\` shows your ticket commits rebased on top of base
- No conflict markers remain anywhere: \`git grep -n '<<<<<<< '\` returns nothing

## WHEN YOU CAN'T RESOLVE
If a conflict is genuinely unresolvable (semantic conflict where the ticket and base changes are incompatible and you can't reconcile them without a human decision):
1. Run \`git rebase --abort\` to restore the branch
2. Write a short explanation of the conflict to ${doneFile} starting with \`ABORTED:\`
3. STOP

## RULES
- Do NOT force-push. Do NOT push at all. Do NOT delete the branch.
- Do NOT skip conflicts with \`--skip\`. Resolve them.
- Do NOT amend commits other than through the normal rebase flow.
- Do NOT modify files that aren't part of conflict resolution.

## DONE SIGNAL
On successful rebase, create ${doneFile} with:
\`\`\`
OK: rebased cleanly onto origin/${baseBranch}
Resolved: <comma-separated list of file paths>
\`\`\`

On abort, create ${doneFile} with \`ABORTED: <reason>\`.

Then STOP.
`.trim();
}
