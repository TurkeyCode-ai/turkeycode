/**
 * The one-turn rule: every session that must leave an artifact gets it, and the
 * sessions whose artifact is a completion gate are not told to write it on failure.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { oneTurnRule } from '../prompts/one-turn';
import { buildBuildPhasePrompt } from '../prompts/build';

const PROMPTS = join(__dirname, '..', 'prompts');

describe('oneTurnRule', () => {
  it('tells a report session to write the artifact no matter what', () => {
    expect(oneTurnRule('the verdict file')).to.contain('ALWAYS');
  });

  it('never tells a completion gate to write on failure', () => {
    const rule = oneTurnRule('build.done', { completionGate: true, partialNotes: 'partial.md' });
    expect(rule).to.not.contain('ALWAYS');
    expect(rule).to.contain('stop WITHOUT writing build.done');
    expect(rule).to.contain('partial.md');
  });

  it('allows a polled service, which QA setup requires', () => {
    const rule = oneTurnRule('the verdict file');
    expect(rule).to.contain('long-lived service');
    expect(rule).to.not.match(/No \\`cmd &\\`/);
  });
});

describe('build prompt', () => {
  it('does not let a partial build pass the gate', () => {
    const p = buildBuildPhasePrompt(
      { projectType: 'web-fullstack', tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], completedPhases: [] } as any,
      { number: 1, name: 'Core', scope: 's', deliverables: ['a'], acceptanceCriteria: ['b'], prerequisites: [] } as any
    );
    expect(p).to.contain('stop WITHOUT writing');
    expect(p).to.contain('build-partial.md');
  });
});

describe('rule coverage', () => {
  // Helpers, not session prompts.
  const NOT_SESSIONS = new Set(['index.ts', 'one-turn.ts', 'ticket-common.ts', 'persona.ts']);

  it('reaches every session prompt', () => {
    const missing = readdirSync(PROMPTS)
      .filter(f => f.endsWith('.ts') && !NOT_SESSIONS.has(f))
      .filter(f => !readFileSync(join(PROMPTS, f), 'utf-8').includes('oneTurnRule('));
    expect(missing).to.deep.equal([]);
  });

  it('has one source: no hand-edited copies', () => {
    const copies = readdirSync(PROMPTS)
      .filter(f => f.endsWith('.ts') && f !== 'one-turn.ts')
      .filter(f => readFileSync(join(PROMPTS, f), 'utf-8').includes('YOU GET ONE TURN'));
    expect(copies).to.deep.equal([]);
  });
});
