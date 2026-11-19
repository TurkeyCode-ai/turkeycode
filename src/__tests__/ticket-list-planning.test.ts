/**
 * Whether a spec is a ticket list is the planner's call, made from what the
 * spec says. turkeycode used to pattern-match it and told a greenfield planner
 * its numbered feature list was tickets in an existing codebase.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPlanPrompt } from '../prompts/plan';
import { ProjectState } from '../types';

const state = { projectDescription: 'A calculator' } as ProjectState;

describe('ticket-list planning', () => {
  it('never tells a greenfield planner about tickets or an existing codebase', () => {
    const prompt = buildPlanPrompt(state, false);
    expect(prompt).toContain('MODE: GREENFIELD');
    expect(prompt).not.toContain('ONE SPRINT PER TICKET');
    expect(prompt).not.toContain('MODE: ITERATE');
  });

  it('hands the iterate planner the rule and the judgement', () => {
    const prompt = buildPlanPrompt(state, true);
    expect(prompt).toContain('MODE: ITERATE');
    expect(prompt).toContain('ONE SPRINT PER TICKET');
    expect(prompt).toContain('You decide whether it is');
    expect(prompt).toContain('is NOT a ticket list');
  });

  it('leaves no spec pattern-matching in the orchestrator', () => {
    const src = readFileSync(join(__dirname, '..', 'orchestrator.ts'), 'utf-8');
    expect(src).not.toMatch(/detectTicketList|TICKET-LIST/);
  });
});
