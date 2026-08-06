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

import { detectProjectType, inferProjectTypeFromDescription } from '../detect-project-type';
import { buildQaCombinedPrompt } from '../prompts/qa-combined';
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

describe('Godot QA instructions', () => {
  const render = (type: string) => {
    return buildQaCombinedPrompt(
      {
        projectType: type,
        buildPhases: [{ number: 1, name: 'Combat', deliverables: ['a'], acceptanceCriteria: ['b'] }],
        completedPhases: [],
      } as any,
      1, 1, '', 'main'
    ) as string;
  };

  it('reaches all three sections — no duplicate cases in one switch', () => {
    // These blocks were first written into the SAME switch, so two of the
    // three were unreachable: JS takes the first matching case and the rest
    // is dead code that still greps as present.
    const p = render('game-godot');
    expect(p, 'setup').to.contain('Import and build the project');
    expect(p, 'smoke').to.contain('Failed loading resource');
    expect(p, 'functional').to.contain('judged on whether it can be PLAYED');
  });

  it('captures frames WINDOWED — headless cannot render', () => {
    // Measured on macOS + Godot 4.7: `--headless --write-movie` crashes and
    // leaves a 332-byte stub that reads as success; windowed writes 592KB.
    // Telling the agent to capture headlessly means visual QA passes on an
    // empty file forever, which is worse than not looking.
    const p = render('game-godot');
    expect(p).to.not.contain('--headless --write-movie');
    expect(p).to.contain('--write-movie');
    expect(p).to.contain('WINDOWED');
  });

  it('still runs script and import checks headless', () => {
    // Those read errors, not pixels — no GPU needed.
    expect(render('game-godot')).to.contain('--headless --import');
  });

  it('never tells a game to open a web server', () => {
    const p = render('game-godot');
    expect(p).to.not.contain('localhost:5123');
  });
});

describe('Greenfield Godot — inferred from the description', () => {
  it('infers game-godot when the spec names the engine', () => {
    // A greenfield build starts in an EMPTY directory: there is no
    // project.godot to detect yet, so the description is the only signal.
    // Without this the build falls through to web-fullstack and gets QA'd
    // as a website — headless Chromium pointed at a 3D game.
    expect(inferProjectTypeFromDescription('A 3D vertical slice in Godot 4.7')).to.equal('game-godot');
    expect(inferProjectTypeFromDescription('build it with godot')).to.equal('game-godot');
  });

  it('does NOT steal every game into an engine project', () => {
    // The last game built here was a turn-based squad RPG that was
    // correctly a web frontend. "Game" alone must not mean Godot.
    expect(inferProjectTypeFromDescription('a turn-based squad combat RPG with companions')).to.not.equal('game-godot');
    expect(inferProjectTypeFromDescription('gamify the onboarding flow')).to.not.equal('game-godot');
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
