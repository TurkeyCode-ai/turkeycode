import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadRepoManifest,
  renderBranchName,
  preflightRepos,
  DEFAULT_BASE,
  DEFAULT_BRANCH_PATTERN,
} from '../repos';

let TEST_ROOT: string;

function writeYaml(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function initRepo(path: string, base: string = 'develop'): void {
  mkdirSync(path, { recursive: true });
  execSync('git init -q', { cwd: path });
  execSync('git config user.email test@test.com', { cwd: path });
  execSync('git config user.name test', { cwd: path });
  writeFileSync(join(path, 'README.md'), '# test\n');
  execSync('git add .', { cwd: path });
  execSync('git commit -q -m init', { cwd: path });
  execSync(`git checkout -q -b ${base}`, { cwd: path });
  // Create a fake origin remote pointing at a second clone so origin/<base> resolves
  const remotePath = path + '.origin';
  execSync(`git clone -q --bare ${path} ${remotePath}`, { cwd: path });
  execSync(`git remote add origin ${remotePath}`, { cwd: path });
  execSync('git fetch -q origin', { cwd: path });
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'turkeycode-repos-'));
}

describe('repos manifest', () => {
  beforeEach(() => {
    TEST_ROOT = freshRoot();
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns null when manifest does not exist', () => {
    expect(loadRepoManifest(join(TEST_ROOT, 'nope.yaml'))).toBeNull();
  });

  it('loads a minimal manifest with defaults', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
`);
    const m = loadRepoManifest(path)!;
    expect(m.defaultBase).toBe(DEFAULT_BASE);
    expect(m.branchPattern).toBe(DEFAULT_BRANCH_PATTERN);
    expect(m.repos).toHaveLength(1);
    expect(m.repos[0].path).toBe('/tmp/api');
    expect(m.repos[0].base).toBe(DEFAULT_BASE);
  });

  it('expands ~ in repo paths and applies per-repo base override', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
defaultBase: main
repos:
  - path: ~/work/api
    base: develop
  - path: /abs/path/web
    role: frontend
`);
    const m = loadRepoManifest(path)!;
    expect(m.defaultBase).toBe('main');
    expect(m.repos[0].path).toMatch(/\/work\/api$/);
    expect(m.repos[0].path.startsWith('~')).toBe(false);
    expect(m.repos[0].base).toBe('develop');
    expect(m.repos[1].base).toBe('main');
    expect(m.repos[1].role).toBe('frontend');
  });

  it('throws on empty repos array', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), 'repos: []\n');
    expect(() => loadRepoManifest(path)).toThrow(/non-empty array/);
  });

  it('throws on missing path', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - role: backend
`);
    expect(() => loadRepoManifest(path)).toThrow(/missing required 'path'/);
  });
});

describe('renderBranchName', () => {
  it('substitutes {key}', () => {
    expect(renderBranchName('ticket/{key}', { key: 'PROJ-123' })).toBe('ticket/PROJ-123');
  });

  it('substitutes {slug} when provided', () => {
    expect(renderBranchName('ticket/{key}-{slug}', { key: 'PROJ-1', slug: 'add thing' }))
      .toBe('ticket/PROJ-1-add-thing');
  });

  it('strips illegal branch characters', () => {
    expect(renderBranchName('feat/{key}', { key: 'PROJ:1 2' })).toBe('feat/PROJ-1-2');
  });
});

describe('preflightRepos', () => {
  beforeEach(() => {
    TEST_ROOT = freshRoot();
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('flags missing path', () => {
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: '/nope/does/not/exist', base: 'develop' }] },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('path-missing');
  });

  it('flags non-git directory', () => {
    const dir = join(TEST_ROOT, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }] },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('not-a-repo');
  });

  it('passes a clean repo with origin/base present', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }] },
      { skipFetch: true },
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('flags dirty tree when allowDirty is false', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n');
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }] },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('dirty-tree');
  });

  it('allows dirty tree when allowDirty is true', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n');
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }] },
      { skipFetch: true, allowDirty: true },
    );
    expect(result.ok).toBe(true);
  });

  it('flags missing base branch on origin', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    const result = preflightRepos(
      { defaultBase: 'no-such-branch', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'no-such-branch' }] },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('base-missing');
  });
});
