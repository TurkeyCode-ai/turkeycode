/**
 * Godot as a first-class project type.
 *
 * The trap this exists to avoid is the one `legacy` was added for: a project
 * that carries a package.json for tooling gets read as a Node project and
 * QA'd as a WEBSITE — headless Chromium pointed at a game that has no URL,
 * producing confident nonsense. Detection order is the whole fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectProjectType } from '../detect-project-type';
import { VISUAL_PROJECT_TYPES, shouldSkipVisualQA } from '../types';

const made: string[] = [];
function dir(): string {
  const d = join(tmpdir(), 'godot-t-' + Date.now() + Math.random().toString(36).slice(2, 7));
  mkdirSync(d, { recursive: true });
  made.push(d);
  return d;
}
afterEach(() => { while (made.length) { try { rmSync(made.pop()!, { recursive: true, force: true }); } catch {} } });

describe('Godot detection', () => {
  it('recognises a project by project.godot', () => {
    const d = dir();
    writeFileSync(join(d, 'project.godot'), '[application]\nconfig/name="Wichita Guild"\n');
    expect(detectProjectType(d)).to.equal('game-godot');
  });

  it('finds a game kept in a subdirectory', () => {
    const d = dir();
    mkdirSync(join(d, 'game'));
    writeFileSync(join(d, 'game', 'project.godot'), '[application]\n');
    expect(detectProjectType(d)).to.equal('game-godot');
  });

  it('wins over package.json — a game with tooling is still a game', () => {
    // The actual bug being prevented: Godot projects routinely carry a
    // package.json for asset scripts or CI. Read as Node, the QA agent
    // points a browser at a game and reports on a blank page.
    const d = dir();
    writeFileSync(join(d, 'project.godot'), '[application]\n');
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      name: 'game-tooling',
      dependencies: { vite: '^5.0.0', react: '^18.0.0' },
    }));
    expect(detectProjectType(d)).to.equal('game-godot');
  });

  it('does not claim a project that merely mentions godot', () => {
    const d = dir();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'godot-docs-site' }));
    writeFileSync(join(d, 'README.md'), 'A site about godot');
    expect(detectProjectType(d)).to.not.equal('game-godot');
  });
});

describe('Godot gets the visual pass', () => {
  it('is a visual project type', () => {
    // A game is judged on how it LOOKS more than anything else here.
    expect(VISUAL_PROJECT_TYPES).to.include('game-godot');
    expect(shouldSkipVisualQA('game-godot')).to.equal(false);
  });

  it('non-visual types still skip it', () => {
    expect(shouldSkipVisualQA('cli')).to.equal(true);
    expect(shouldSkipVisualQA('library')).to.equal(true);
    expect(shouldSkipVisualQA('embedded')).to.equal(true);
  });
});
