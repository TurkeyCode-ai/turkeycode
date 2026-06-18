import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { detectProjectType, detectProjectTypeStrict, inferProjectTypeFromDescription } from '../detect-project-type';

const testDir = join('/tmp', `.test-detect-type-${Date.now()}`);

describe('greenfield (empty dir) detection', () => {
  const empty = join('/tmp', `.test-detect-empty-${Date.now()}`);
  beforeEach(() => { mkdirSync(empty, { recursive: true }); });
  afterEach(() => { rmSync(empty, { recursive: true, force: true }); });

  it('detectProjectType defaults an empty dir to web-fullstack (backwards compatible)', () => {
    expect(detectProjectType(empty)).toBe('web-fullstack');
  });

  it('detectProjectTypeStrict returns unknown for an empty dir (no web fallback)', () => {
    expect(detectProjectTypeStrict(empty)).toBe('unknown');
  });
});

describe('inferProjectTypeFromDescription', () => {
  it('infers cli from terminal/command-line language', () => {
    expect(inferProjectTypeFromDescription('a CLI that prints a random dad joke')).toBe('cli');
    expect(inferProjectTypeFromDescription('DadJoke Terminal')).toBe('cli');
    expect(inferProjectTypeFromDescription('a command-line tool to rename files')).toBe('cli');
  });

  it('infers desktop / mobile / library', () => {
    expect(inferProjectTypeFromDescription('an Electron desktop app for notes')).toBe('desktop');
    expect(inferProjectTypeFromDescription('a React Native mobile app')).toBe('mobile');
    expect(inferProjectTypeFromDescription('a published npm package for date math')).toBe('library');
  });

  it('infers web-api only when there is no frontend/UI signal', () => {
    expect(inferProjectTypeFromDescription('a REST API for inventory management')).toBe('web-api');
    // A dashboard is a web app, not a bare API — should NOT be web-api
    expect(inferProjectTypeFromDescription('a REST API plus an admin dashboard')).toBeNull();
  });

  it('returns null for a plain web app (caller defaults to web-fullstack)', () => {
    expect(inferProjectTypeFromDescription('a recipe sharing web app with login')).toBeNull();
    expect(inferProjectTypeFromDescription('a SaaS dashboard with Stripe billing')).toBeNull();
  });

  it('does not match cli inside unrelated words', () => {
    expect(inferProjectTypeFromDescription('a client portal for a web app')).toBeNull();
  });
});

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ==================== Explicit Metadata ====================

describe('explicit metadata', () => {
  it('reads .turkey/project-type file', () => {
    mkdirSync(join(testDir, '.turkey'), { recursive: true });
    writeFileSync(join(testDir, '.turkey', 'project-type'), 'cli');
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { next: '14' } }));
    expect(detectProjectType(testDir)).toBe('cli');
  });

  it('reads turkey.type from package.json', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'test',
      turkey: { type: 'library' },
      dependencies: { next: '14' }
    }));
    expect(detectProjectType(testDir)).toBe('library');
  });
});

// ==================== Node.js Detection ====================

describe('node.js detection', () => {
  it('detects web-fullstack for Next.js', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      dependencies: { next: '14', react: '18' }
    }));
    expect(detectProjectType(testDir)).toBe('web-fullstack');
  });

  it('detects web-frontend for React + Vite (no server)', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      dependencies: { react: '18', 'react-dom': '18' },
      devDependencies: { vite: '5' }
    }));
    expect(detectProjectType(testDir)).toBe('web-frontend');
  });

  it('detects web-api for Express (no frontend)', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-api',
      dependencies: { express: '4' }
    }));
    expect(detectProjectType(testDir)).toBe('web-api');
  });

  it('detects cli for bin field + commander', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-cli',
      bin: { 'my-cli': './dist/index.js' },
      dependencies: { commander: '11' }
    }));
    expect(detectProjectType(testDir)).toBe('cli');
  });

  it('detects desktop for Electron', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      dependencies: { electron: '28' }
    }));
    expect(detectProjectType(testDir)).toBe('desktop');
  });

  it('detects mobile for React Native', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      dependencies: { 'react-native': '0.73' }
    }));
    expect(detectProjectType(testDir)).toBe('mobile');
  });

  it('detects library for main/exports only', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-lib',
      main: 'dist/index.js',
      exports: { '.': './dist/index.js' },
      types: 'dist/index.d.ts'
    }));
    expect(detectProjectType(testDir)).toBe('library');
  });
});

// ==================== Rust Detection ====================

describe('rust detection', () => {
  it('detects cli for Clap dependency', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), `[package]\nname = "my-cli"\n[dependencies]\nclap = "4"`);
    expect(detectProjectType(testDir)).toBe('cli');
  });

  it('detects web-api for Axum dependency', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), `[package]\nname = "my-api"\n[dependencies]\naxum = "0.7"`);
    expect(detectProjectType(testDir)).toBe('web-api');
  });

  it('detects library for [lib] only', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), `[package]\nname = "my-lib"\n[lib]\nname = "my_lib"`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'lib.rs'), 'pub fn hello() {}');
    expect(detectProjectType(testDir)).toBe('library');
  });
});

// ==================== Python Detection ====================

describe('python detection', () => {
  it('detects web-fullstack for Django', () => {
    writeFileSync(join(testDir, 'requirements.txt'), 'django==5.0\npsycopg2==2.9');
    expect(detectProjectType(testDir)).toBe('web-fullstack');
  });

  it('detects web-api for FastAPI', () => {
    writeFileSync(join(testDir, 'requirements.txt'), 'fastapi==0.109\nuvicorn==0.27');
    expect(detectProjectType(testDir)).toBe('web-api');
  });

  it('detects cli for Click', () => {
    writeFileSync(join(testDir, 'requirements.txt'), 'click==8.1\nrich==13.7');
    expect(detectProjectType(testDir)).toBe('cli');
  });
});

// ==================== Go Detection ====================

describe('go detection', () => {
  it('detects web-api for Gin', () => {
    writeFileSync(join(testDir, 'go.mod'), 'module myapp\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9');
    expect(detectProjectType(testDir)).toBe('web-api');
  });

  it('detects cli for Cobra', () => {
    writeFileSync(join(testDir, 'go.mod'), 'module myapp\ngo 1.22\nrequire github.com/spf13/cobra v1.8');
    expect(detectProjectType(testDir)).toBe('cli');
  });
});

// ==================== Ruby Detection ====================

describe('ruby detection', () => {
  it('detects web-fullstack for Rails', () => {
    writeFileSync(join(testDir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'");
    expect(detectProjectType(testDir)).toBe('web-fullstack');
  });
});

// ==================== Monorepo Detection ====================

describe('monorepo detection', () => {
  it('detects monorepo for pnpm-workspace.yaml', () => {
    writeFileSync(join(testDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*');
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    expect(detectProjectType(testDir)).toBe('monorepo');
  });

  it('detects monorepo for npm workspaces', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*']
    }));
    expect(detectProjectType(testDir)).toBe('monorepo');
  });
});

// ==================== Legacy / Mainframe Detection ====================

describe('legacy detection', () => {
  it('detects legacy for COBOL sources in the root', () => {
    writeFileSync(join(testDir, 'POSTINT.cbl'), 'IDENTIFICATION DIVISION.');
    expect(detectProjectType(testDir)).toBe('legacy');
  });

  it('detects legacy for COBOL copybooks', () => {
    writeFileSync(join(testDir, 'ACCTMAST.cpy'), '01 ACCT-REC.');
    expect(detectProjectType(testDir)).toBe('legacy');
  });

  it('detects legacy for JCL', () => {
    writeFileSync(join(testDir, 'RUNJOB.jcl'), '//RUNJOB JOB');
    expect(detectProjectType(testDir)).toBe('legacy');
  });

  it('detects legacy for RPG (IBM i)', () => {
    writeFileSync(join(testDir, 'INVUPD.rpgle'), '**FREE');
    expect(detectProjectType(testDir)).toBe('legacy');
  });

  it('detects legacy when COBOL lives one level deep (src/, cobol/)', () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'GENSTMT.cob'), 'IDENTIFICATION DIVISION.');
    expect(detectProjectType(testDir)).toBe('legacy');
  });

  it('does not misclassify a modern project with no legacy files', () => {
    writeFileSync(join(testDir, 'go.mod'), 'module x\n');
    writeFileSync(join(testDir, 'main.go'), 'package main');
    expect(detectProjectType(testDir)).toBe('cli');
  });

  it('does NOT flag ambiguous extensions as legacy (asm/mac/dds/rpg false positives)', () => {
    // These appear in modern/non-mainframe projects (assembly, macros, textures, RPG Maker)
    // and previously misdetected greenfield apps as `legacy`.
    for (const f of ['boot.asm', 'build.mac', 'sprite.dds', 'Actor.rpg']) {
      writeFileSync(join(testDir, f), 'x');
    }
    expect(detectProjectType(testDir)).not.toBe('legacy');
  });
});

// ==================== Fallback ====================

describe('fallback', () => {
  it('defaults to web-fullstack for unknown projects', () => {
    // Empty directory — no project files
    expect(detectProjectType(testDir)).toBe('web-fullstack');
  });
});
