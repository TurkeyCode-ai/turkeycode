/**
 * Merge-conflict resolution prompt.
 * Job: resolve conflicts in a single repo, complete the integration, and STOP.
 * Two modes:
 *  - 'rebase' (default): invoked after `git rebase origin/<base>` fails (ticket flow).
 *  - 'merge': invoked after a local `git merge <branch>` fails (phase-build flow).
 */

export interface MergeFixPromptInput {
  /** Absolute path of the repo where the integration is in progress. */
  repoPath: string;
  /** Branch being integrated (rebased / merged in). */
  branchName: string;
  /** Base branch being integrated into / onto. */
  baseBranch: string;
  /** Paths (relative to repoPath) that currently have unresolved conflicts. */
  conflictedPaths: string[];
  /** File the session must touch when done. */
  doneFile: string;
  /** Integration strategy in progress. Defaults to 'rebase'. */
  mode?: 'rebase' | 'merge';
  /** Optional context key (ticket key or phase id) so the session understands intent. */
  contextKey?: string;
  /** Optional one-line context summary. */
  contextSummary?: string;
}

export function buildMergeFixPrompt(input: MergeFixPromptInput): string {
  const {
    repoPath, branchName, baseBranch, conflictedPaths, doneFile,
    mode = 'rebase', contextKey, contextSummary,
  } = input;

  const isRebase = mode === 'rebase';
  const baseRef = isRebase ? `origin/${baseBranch}` : baseBranch;
  const headMeaning = isRebase
    ? 'the `HEAD` side is what the base branch looks like now; the other side is your branch\'s change'
    : `the \`HEAD\` side is the base branch (\`${baseBranch}\`); the \`${branchName}\` side is the branch being merged in`;
  // How to finish the integration once all files are staged.
  const continueStep = isRebase
    ? '`git rebase --continue` (set GIT_EDITOR=true so commit messages pass through unchanged)'
    : '`git commit --no-edit` to complete the merge (the merge commit message is fine as-is)';
  const inProgressName = isRebase ? 'rebase' : 'merge';
  const inProgressCheck = isRebase
    ? '`git status` shows no "rebase in progress"'
    : '`git status` shows no "All conflicts fixed but you are still merging" and no MERGE_HEAD remains';
  const abortCmd = isRebase ? '`git rebase --abort`' : '`git merge --abort`';
  const newConflictNote = isRebase
    ? 'If the next commit raises a NEW conflict, repeat for the new conflicted files.'
    : 'A merge produces a single conflict set — once it is resolved and committed you are done.';

  const contextBlock = (contextKey || contextSummary)
    ? `## CONTEXT
${contextKey ? `- Context: ${contextKey}\n` : ''}${contextSummary ? `- Summary: ${contextSummary}\n` : ''}- Repo: ${repoPath}
- Branch: ${branchName}
- Base: ${baseRef}
`
    : `## CONTEXT
- Repo: ${repoPath}
- Branch: ${branchName}
- Base: ${baseRef}
`;

  const title = isRebase
    ? `A rebase of \`${branchName}\` onto \`${baseRef}\` in the repo at \`${repoPath}\` hit merge conflicts.`
    : `A merge of \`${branchName}\` into \`${baseBranch}\` in the repo at \`${repoPath}\` hit merge conflicts.`;

  return `
# ${isRebase ? 'REBASE' : 'MERGE'} CONFLICT RESOLUTION

## YOUR SINGLE JOB
${title} Resolve them, complete the ${inProgressName}, and STOP.

${contextBlock}- Conflicted paths (as of when this session started):
${conflictedPaths.map((p) => `  - ${p}`).join('\n')}

## PROCESS
1. \`cd ${repoPath}\`
2. For each conflicted file:
   - Read the file. Find all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
   - Understand both sides: ${headMeaning}.
   - Resolve semantically — keep the intent of the branch's change **and** whatever the base branch added. Do NOT just pick one side unless you're certain the other is superseded.
   - For mechanical conflicts (imports, lockfiles, import order, formatting): regenerate / re-sort rather than hand-pick.
   - For lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, Gemfile.lock, Cargo.lock): prefer running the package manager's install command to regenerate cleanly.
   - For genuinely conflicting logic: keep both intents if possible. If truly impossible, prefer the branch's change and leave a short code comment noting the tradeoff.
3. After each file: \`git add <file>\`.
4. When all files are resolved: ${continueStep}.
5. ${newConflictNote}
6. Continue until \`git status\` shows no ${inProgressName} in progress and the working tree is clean.

## VERIFY
Before writing the done file, verify:
- ${inProgressCheck}
- No conflict markers remain anywhere: \`git grep -n '<<<<<<< '\` returns nothing

## WHEN YOU CAN'T RESOLVE
If a conflict is genuinely unresolvable (a semantic conflict you can't reconcile without a human decision):
1. Run ${abortCmd} to restore the repo to its pre-${inProgressName} state
2. Write a short explanation of the conflict to ${doneFile} starting with \`ABORTED:\`
3. STOP

## RULES
- Do NOT force-push. Do NOT push at all. Do NOT delete the branch.
- Do NOT skip conflicts. Resolve them.
- Do NOT modify files that aren't part of conflict resolution.

## DONE SIGNAL
On success, create ${doneFile} with:
\`\`\`
OK: ${isRebase ? `rebased cleanly onto ${baseRef}` : `merged ${branchName} into ${baseBranch}`}
Resolved: <comma-separated list of file paths>
\`\`\`

On abort, create ${doneFile} with \`ABORTED: <reason>\`.

Then STOP.
`.trim();
}
