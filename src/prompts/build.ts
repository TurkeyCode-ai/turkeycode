/**
 * Build phase prompt builder
 * Job: Build EVERYTHING in this phase's scope, commit, write build.done, STOP
 */

import { ProjectState, BuildPhase } from '../types';
import { PHASES_DIR } from '../constants';

export function buildBuildPhasePrompt(
  state: ProjectState,
  phase: BuildPhase
): string {
  // Build tech context
  const techContext = Object.keys(state.tech).length > 0
    ? JSON.stringify(state.tech, null, 2)
    : 'No tech context established yet';

  // Build what exists from prior phases
  const existingContext = [
    state.entities.length > 0 ? `Entities: ${state.entities.join(', ')}` : null,
    state.endpoints.length > 0 ? `Endpoints: ${state.endpoints.join(', ')}` : null,
    state.uiPages.length > 0 ? `UI Pages: ${state.uiPages.join(', ')}` : null
  ].filter(Boolean).join('\n') || 'Nothing built yet';

  // Build known issues
  const issuesContext = state.knownIssues.length > 0
    ? state.knownIssues.map(i => `- ${i}`).join('\n')
    : 'No known issues';

  // Build prerequisites context
  const prereqContext = phase.prerequisites.length > 0
    ? phase.prerequisites.map(p => `- ${p}`).join('\n')
    : 'None - this is the first phase';

  // Build deliverables list
  const deliverablesList = phase.deliverables
    .map((d, i) => `${i + 1}. ${d}`)
    .join('\n');

  // Build acceptance criteria
  const acList = phase.acceptanceCriteria
    .map((ac, i) => `${i + 1}. [ ] ${ac}`)
    .join('\n');

  // Build completed phases summary
  const completedSummary = state.completedPhases.length > 0
    ? state.completedPhases.map(p => `- Phase ${p.number}: ${p.name} (completed ${p.completedAt})`).join('\n')
    : 'No phases completed yet';

  // Phase artifacts path
  const phaseDoneDir = `${PHASES_DIR}/phase-${phase.number}`;
  const buildDone = `${phaseDoneDir}/build.done`;

  return `
# BUILD PHASE ${phase.number}: ${phase.name}

## YOUR SINGLE JOB
Build EVERYTHING in this phase. This is a full build session - implement all deliverables, run tests, commit, and write the done signal.

---

## PHASE SCOPE

${phase.scope}

---

## DELIVERABLES (build ALL of these)

${deliverablesList}

---

## ACCEPTANCE CRITERIA (must ALL pass)

${acList}

---

## SPEC CONTEXT (from specifications)

${phase.specContext}

---

## PREREQUISITES (what exists from prior phases)

${prereqContext}

---

## EXISTING CONTEXT

### Completed Phases
${completedSummary}

### Tech Stack
\`\`\`json
${techContext}
\`\`\`

### What Already Exists
${existingContext}

### Known Issues
${issuesContext}

---

## IMPLEMENTATION APPROACH

This is a FULL BUILD SESSION. You have 60-90 minutes. Work through deliverables systematically:

1. **Read existing code** - Understand what's already built
2. **Plan your approach** - Think through the deliverables before coding
3. **Build incrementally** - Implement each deliverable, test as you go
4. **Commit often** - Multiple commits are encouraged
5. **Run tests** - Verify acceptance criteria are met
6. **Write done signal** - Only after everything works

### Commit Strategy
\`\`\`bash
# Commit after each major deliverable
git add -A
git commit -m "phase-${phase.number}: [deliverable description]"

# Final commit
git add -A
git commit -m "phase-${phase.number}: ${phase.name} - all deliverables complete"
\`\`\`

---

## DONE SIGNAL

When ALL deliverables are complete and ALL acceptance criteria pass:

\`\`\`bash
mkdir -p ${phaseDoneDir}
echo "DONE - Phase ${phase.number} build completed at $(date -Iseconds)" > ${buildDone}
\`\`\`

---

## RULES

1. **Build EVERYTHING in this phase** - All deliverables, not just some
2. **Follow existing patterns** - Match conventions from prior phases
3. **Test as you go** - Don't wait until the end to test
4. **Commit incrementally** - Multiple commits, not one giant commit
5. **Do NOT build ahead** - Only implement what's in this phase's scope
6. **Do NOT skip deliverables** - Every deliverable must be implemented
7. **Push when done** - Ensure code is pushed to the phase branch

---

## VERIFICATION

Before writing build.done, verify:
1. All deliverables are implemented
2. All acceptance criteria pass
3. Code compiles/builds without errors
4. All changes are committed and pushed
5. build.done file exists at ${buildDone}

Then STOP.
`.trim();
}
