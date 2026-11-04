/**
 * Godot as a first-class project type.
 *
 * The trap this exists to avoid is the one `legacy` was added for: a project
 * that carries a package.json for tooling gets read as a Node project and
 * QA'd as a WEBSITE — headless Chromium pointed at a game that has no URL,
 * producing confident nonsense. Detection order is the whole fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildQaVisualPrompt, buildQaVisualReviewPrompt } from '../prompts/qa-visual';
import { buildQaFixPrompt } from '../prompts/qa-fix';
import { buildBuildPhasePrompt } from '../prompts/build';
import { GODOT_DIR_SHELL, PROJECT_TYPES } from '../detect-project-type';
import { detectProjectType as detectForQuickCheck, godotOutputErrors } from '../quick-check';
import { execSync } from 'child_process';
import { CLAUDE_BACKEND } from '../agents';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
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
  const state = {
    projectType: 'game-godot',
    projectDescription: 'A game',
    buildPhases: [{ number: 1, name: 'Combat', deliverables: ['a'], acceptanceCriteria: ['b'] }],
  } as any;

  it('never points the reviewer at a browser', () => {
    const p = buildQaVisualReviewPrompt(state, 1, 1, { ...CLAUDE_BACKEND.capabilities, subagents: false });
    expect(p).to.not.contain('localhost:5123');
    expect(p).to.not.contain('Capture FULL PAGE');
    expect(p).to.contain('frames from a running game');
  });

  it('makes the reviewer open every file and say what it opened', () => {
    const p = buildQaVisualReviewPrompt(state, 1, 1, { ...CLAUDE_BACKEND.capabilities, subagents: false });
    expect(p).to.contain('OPEN EVERY FILE');
    expect(p).to.contain('framesReviewed');
    expect(p).to.contain('not-shown');
  });

  it('leaves the web flow alone', () => {
    const p = buildQaVisualPrompt({ ...state, projectType: 'web-fullstack' }, 1, 1) as string;
    expect(p).to.contain('capture-screenshots.ts');
    expect(p).to.contain('Capture FULL PAGE');
    expect(p).to.not.contain('--write-movie');
  });

  it('tells a fix session to change the timeline, not the game', () => {
    const fix = buildQaFixPrompt(state, 1, 1);
    expect(fix).to.contain('capture-timeline.json');
    expect(buildQaFixPrompt({ ...state, projectType: 'web-fullstack' }, 1, 1)).to.not.contain('capture-timeline.json');
  });
});

describe('Godot build rules', () => {
  it('gets Godot rules, not the web fallback', () => {
    const p = buildBuildPhasePrompt(
      { projectType: 'game-godot', tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], completedPhases: [] } as any,
      { number: 1, name: 'Core', scope: 's', deliverables: ['a'], acceptanceCriteria: ['b'], prerequisites: [] } as any
    );
    expect(p).to.contain('GODOT RULES');
    expect(p).to.contain('capture-timeline.json');
    expect(p).to.contain('Never add capture, demo or autoplay code');
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

describe('Godot project location', () => {
  const repo = (files: string[]) => {
    const d = mkdtempSync(join(tmpdir(), 'tc-godot-'));
    for (const f of files) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), f.endsWith('package.json') ? '{"dependencies":{"express":"^4"}}' : '');
    }
    return d;
  };
  const shellDir = (cwd: string) =>
    execSync(`${GODOT_DIR_SHELL}; printf %s "$GODOT_DIR"`, { cwd, shell: '/bin/bash' }).toString();

  it('prefers the root, the same order detection uses', () => {
    expect(shellDir(repo(['project.godot', 'app/project.godot']))).to.equal('.');
  });

  it('finds a subdirectory', () => {
    expect(shellDir(repo(['game/project.godot']))).to.equal('game');
  });

  it("does not boot a Godot project's own .csproj as a backend", () => {
    expect(detectForQuickCheck(repo(['project.godot', 'Game.csproj'])).hasBackend).to.equal(false);
  });

  it('still finds a real backend past the Godot project', () => {
    const d = repo(['project.godot', 'Game.csproj', 'server/package.json']);
    const info = detectForQuickCheck(d);
    expect(info.hasBackend).to.equal(true);
    expect(info.backendDir).to.equal(join(d, 'server'));
  });
});
