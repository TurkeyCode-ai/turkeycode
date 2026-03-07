import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '../../.test-audit');
const TEST_LOG = join(TEST_DIR, '.turkey/audit.log');

vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    AUDIT_LOG: join(__dirname, '../../.test-audit/.turkey/audit.log'),
  };
});

import { audit, auditGate, auditPhase, auditBuildPhase, auditQA } from '../audit';

describe('audit', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.turkey'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('creates audit log file on first write', () => {
    audit('orchestration_started', { details: { description: 'test' } });
    expect(existsSync(TEST_LOG)).toBe(true);
  });

  it('writes valid JSON lines', () => {
    audit('orchestration_started');
    audit('orchestration_completed');
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('event');
    }
  });

  it('includes timestamp in ISO format', () => {
    audit('orchestration_started');
    const entry = JSON.parse(readFileSync(TEST_LOG, 'utf-8').trim());
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('auditGate logs gate events', () => {
    auditGate('research', true, { specs: 'found' });
    auditGate('plan', false);
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).event).toBe('gate_passed');
    expect(JSON.parse(lines[0]).gate).toBe('research');
    expect(JSON.parse(lines[1]).event).toBe('gate_failed');
  });

  it('auditPhase logs phase transitions', () => {
    auditPhase('build', 'started');
    auditPhase('build', 'completed', { duration: 1000 });
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).event).toBe('phase_started');
    expect(JSON.parse(lines[1]).event).toBe('phase_completed');
  });

  it('auditBuildPhase logs build phase events', () => {
    auditBuildPhase(1, 'started');
    auditBuildPhase(1, 'completed', { files: 10 });
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).buildPhase).toBe(1);
    expect(JSON.parse(lines[1]).event).toBe('build_phase_completed');
  });

  it('auditQA logs QA lifecycle', () => {
    auditQA(1, 1, 'started');
    auditQA(1, 1, 'failed', { blockers: 3 });
    auditQA(1, 2, 'started');
    auditQA(1, 2, 'passed');
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]).event).toBe('qa_attempt_started');
    expect(JSON.parse(lines[1]).event).toBe('qa_failed');
    expect(JSON.parse(lines[3]).event).toBe('qa_passed');
  });

  it('appends to existing log', () => {
    audit('orchestration_started');
    audit('phase_started');
    audit('phase_completed');
    const lines = readFileSync(TEST_LOG, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
  });
});
