/**
 * Research phase prompt builder
 * Job: Read spec, write research.md, write research.done, STOP
 */

import { ProjectState } from '../types';
import { REFERENCE_DIR, RESEARCH_DONE, SPECS_FILE } from '../constants';

export function buildResearchPrompt(state: ProjectState, specContent?: string): string {
  const spec = specContent || state.projectDescription;

  return `
# RESEARCH PHASE

## YOUR SINGLE JOB
Research and document requirements for: ${state.projectDescription}

## CONTEXT
${spec ? `### Spec Content\n${spec}` : 'No spec file provided - research based on project description above.'}

## OUTPUT YOU MUST PRODUCE

### 1. ${SPECS_FILE}
Create this file with comprehensive specifications:

\`\`\`markdown
# ${state.projectDescription} Specifications

## Description
[One paragraph describing what this project is]

## Source URLs
- [url1] - [what it provided]
- [url2] - [what it provided]

## Core Features
1. [Feature name]: [expected behavior]
2. [Feature name]: [expected behavior]
3. [Feature name]: [expected behavior]

## Core Flows (numbered for QA testing)
Flow 1: [name] - [input] -> [expected output]
Flow 2: [name] - [input] -> [expected output]
Flow 3: [name] - [input] -> [expected output]

## Technical Requirements
- [requirement 1]
- [requirement 2]

## Constraints
- [constraint 1]
- [constraint 2]

## UI/UX Requirements (if applicable)
- [layout requirement]
- [responsive requirement]
- [accessibility requirement]
\`\`\`

### 2. Reference Images (if this is a visual project)
Save reference images to: ${REFERENCE_DIR}/
- Use descriptive names: layout-desktop.png, component-button.png, etc.

### 3. ${RESEARCH_DONE}
When research is complete, create this file with content:
\`\`\`
DONE - Research completed at [timestamp]
\`\`\`

## PROCESS
1. Use WebSearch to find official documentation, specifications, best practices
2. Use WebFetch to get specific pages and save images
3. Document EVERYTHING in specs.md - this is the source of truth for all future phases
4. Verify files exist: \`ls -la ${REFERENCE_DIR}/\`
5. Write the done signal

## RULES
- Do NOT write any code
- Do NOT set up the project
- ONLY research and document
- Be thorough - QA will test against this spec
- Number all flows explicitly for testability

Then STOP.
`.trim();
}
