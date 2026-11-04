/**
 * Godot as a first-class project type.
 *
 * The trap this exists to avoid is the one `legacy` was added for: a project
 * that carries a package.json for tooling gets read as a Node project and
 * QA'd as a WEBSITE — headless Chromium pointed at a game that has no URL,
 * producing confident nonsense. Detection order is the whole fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildQaVisualPrompt } from '../prompts/qa-visual';
import { buildBuildPhasePrompt } from '../prompts/build';
import { PROJECT_TYPES } from '../detect-project-type';
import { godotOutputErrors } from '../quick-check';
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

  it('leaves frame capture to the visual session', () => {
    expect(render('game-godot')).to.not.contain('--write-movie');
  });

  it('passes --path to every Godot command', () => {
    // From the repo root without --path, Godot prints an error and exits 0.
    const lines = render('game-godot').split('\n').filter(l => l.includes('godot --'));
    expect(lines.length).to.be.greaterThan(3);
    for (const line of lines) expect(line, line).to.contain('--path');
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

describe('Godot visual QA', () => {
  const render = (type: string) => buildQaVisualPrompt(
    {
      projectType: type,
      buildPhases: [{ number: 1, name: 'Combat', deliverables: ['a'], acceptanceCriteria: ['b'] }],
    } as any,
    1, 1
  ) as string;

  it('captures windowed PNG frames the reviewer can read', () => {
    const p = render('game-godot');
    expect(p).to.contain('--write-movie "$FRAMES/frame.png"');
    expect(p).to.not.contain('--headless --write-movie');
    expect(p).to.contain('xvfb-run');
  });

  it('never points a browser at a game', () => {
    const p = render('game-godot');
    expect(p).to.not.contain('localhost:5123');
    expect(p).to.not.contain('capture-screenshots.ts');
    expect(p).to.not.contain('Capture FULL PAGE');
  });

  it('leaves the web flow alone', () => {
    const p = render('web-fullstack');
    expect(p).to.contain('capture-screenshots.ts');
    expect(p).to.contain('Capture FULL PAGE');
    expect(p).to.not.contain('--write-movie');
  });
});

describe('Godot build rules', () => {
  it('gets Godot rules, not the web fallback', () => {
    const p = buildBuildPhasePrompt(
      { projectType: 'game-godot', tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], completedPhases: [] } as any,
      { number: 1, name: 'Core', scope: 's', deliverables: ['a'], acceptanceCriteria: ['b'], prerequisites: [] } as any
    );
    expect(p).to.contain('GODOT RULES');
    expect(p).to.not.contain('Logo & favicon');
  });
});

describe('Godot description inference', () => {
  it('leaves work that is only about Godot to the other types', () => {
    expect(inferProjectTypeFromDescription('CLI for exporting Godot scenes')).to.equal('cli');
    expect(inferProjectTypeFromDescription('a Godot docs site')).to.equal(null);
  });

  it('keeps real games, including ones that mention tooling', () => {
    expect(inferProjectTypeFromDescription('a Godot platformer')).to.equal('game-godot');
    expect(inferProjectTypeFromDescription('a Godot game with a CLI level exporter')).to.equal('game-godot');
  });
});

describe('--type accepts every project type', () => {
  it('includes game-godot', () => {
    expect(PROJECT_TYPES).to.include('game-godot');
  });
});

describe('Godot output parsing', () => {
  it('finds the errors Godot exits 0 on', () => {
    // Captured from Godot 4.7.1 on a script with a syntax error.
    const output = [
      'Godot Engine v4.7.1.stable.official',
      'SCRIPT ERROR: Parse Error: Expected parameter name.',
      '          at: GDScript::reload (res://main.gd:2)',
      'ERROR: Failed to load script "res://main.gd" with error "Parse error".',
    ].join('\n');
    expect(godotOutputErrors(output)).to.have.length(2);
  });

  it('passes a clean run', () => {
    expect(godotOutputErrors('Godot Engine v4.7.1\n\nhello\n')).to.deep.equal([]);
  });
});
