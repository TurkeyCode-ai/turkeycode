/**
 * A Node service with no build script must not fail the pre-QA check.
 *
 * Regression seen on two client services (plain Node, `node --test`): the
 * check ran `npm run build`, got "Missing script: build", and fix sessions
 * added a build script the spec had forbidden. When the script was removed
 * again the run ended "QUICK SMOKE CHECK FAILED" with all its work done.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasNpmScript } from '../quick-check';

describe('hasNpmScript', () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-no-build-'))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = (value: unknown) => writeFileSync(join(dir, 'package.json'), JSON.stringify(value));

  it('is true when the script is defined', () => {
    pkg({ scripts: { build: 'tsc', test: 'node --test' } });
    expect(hasNpmScript(dir, 'build')).toBe(true);
  });
  it('is false when the script is absent, empty or there are no scripts', () => {
    pkg({ scripts: { test: 'node --test' } });
    expect(hasNpmScript(dir, 'build')).toBe(false);
    pkg({ scripts: { build: '  ' } });
    expect(hasNpmScript(dir, 'build')).toBe(false);
    pkg({ name: 'x' });
    expect(hasNpmScript(dir, 'build')).toBe(false);
  });
  it('is false when package.json is missing or unreadable', () => {
    expect(hasNpmScript(dir, 'build')).toBe(false);
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(hasNpmScript(dir, 'build')).toBe(false);
  });
});
