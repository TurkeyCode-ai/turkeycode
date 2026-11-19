import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadRepoManifest,
  renderBranchName,
  slugify,
  preflightRepos,
  DEFAULT_BASE,
  DEFAULT_BRANCH_PATTERN,
  DEFAULT_TRANSITION_AFTER_PUSH,
  DEFAULT_REVIEW_CHECKLIST,
  effectiveReviewChecklist,
  parseBaseLocalSpec,
  resolveLocalBases,
  refResolves,
  rebaseOntoBase,
  cutTicketBranch,
  RepoManifest,
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
    expect(m.references).toEqual([]);
    expect(m.transitionAfterPush).toBe(DEFAULT_TRANSITION_AFTER_PUSH);
  });

  it('honors a custom transitionAfterPush', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
transitionAfterPush: Code Review
repos:
  - path: /tmp/api
`);
    const m = loadRepoManifest(path)!;
    expect(m.transitionAfterPush).toBe('Code Review');
  });

  it('parses references with role and ~ expansion', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
references:
  - path: ~/legacy/code
    role: legacy reference
  - path: /abs/old-system
`);
    const m = loadRepoManifest(path)!;
    expect(m.references).toHaveLength(2);
    expect(m.references[0].path).toMatch(/\/legacy\/code$/);
    expect(m.references[0].path.startsWith('~')).toBe(false);
    expect(m.references[0].role).toBe('legacy reference');
    expect(m.references[1].path).toBe('/abs/old-system');
    expect(m.references[1].role).toBeUndefined();
  });

  it('throws when a reference is missing path', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
references:
  - role: nope
`);
    expect(() => loadRepoManifest(path)).toThrow(/references\[0\] is missing required 'path'/);
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

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add new login flow')).toBe('add-new-login-flow');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('Fix:  bug!! in   API///handler')).toBe('fix-bug-in-api-handler');
  });

  it('trims leading/trailing separators', () => {
    expect(slugify('  ---hello world---  ')).toBe('hello-world');
  });

  it('truncates to maxLen and trims trailing dash', () => {
    const out = slugify('one two three four five six seven eight nine ten', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!---!!!')).toBe('');
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
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: '/nope/does/not/exist', base: 'develop' }], references: [], transitionAfterPush: 'In Review' },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('path-missing');
  });

  it('flags non-git directory', () => {
    const dir = join(TEST_ROOT, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }], references: [], transitionAfterPush: 'In Review' },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('not-a-repo');
  });

  it('passes a clean repo with origin/base present', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    const result = preflightRepos(
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }], references: [], transitionAfterPush: 'In Review' },
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
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }], references: [], transitionAfterPush: 'In Review' },
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
      { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'develop' }], references: [], transitionAfterPush: 'In Review' },
      { skipFetch: true, allowDirty: true },
    );
    expect(result.ok).toBe(true);
  });

  it('flags missing base branch on origin', () => {
    const dir = join(TEST_ROOT, 'api');
    initRepo(dir, 'develop');
    const result = preflightRepos(
      { defaultBase: 'no-such-branch', branchPattern: 'ticket/{key}', repos: [{ path: dir, base: 'no-such-branch' }], references: [], transitionAfterPush: 'In Review' },
      { skipFetch: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('base-missing');
  });
});

describe('repos manifest: related + review checklist', () => {
  beforeEach(() => {
    TEST_ROOT = freshRoot();
  });
  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('defaults related to [] and review to the default checklist', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), 'repos:\n  - path: /tmp/api\n');
    const m = loadRepoManifest(path)!;
    expect(m.related).toEqual([]);
    expect(m.review).toEqual({ checklist: [], replaceDefaultChecklist: false });
    expect(effectiveReviewChecklist(m)).toEqual([...DEFAULT_REVIEW_CHECKLIST]);
  });

  it('parses related repos with role and ~ expansion', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
related:
  - path: ~/work/bridge
    role: bridge producer/consumer
  - path: /abs/other-api
`);
    const m = loadRepoManifest(path)!;
    expect(m.related).toHaveLength(2);
    expect(m.related![0].path).toMatch(/\/work\/bridge$/);
    expect(m.related![0].path.startsWith('~')).toBe(false);
    expect(m.related![0].role).toBe('bridge producer/consumer');
    expect(m.related![1]).toEqual({ path: '/abs/other-api', role: undefined });
  });

  it('rejects a related entry without a path', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), 'repos:\n  - path: /tmp/api\nrelated:\n  - role: x\n');
    expect(() => loadRepoManifest(path)).toThrow(/related\[0\] is missing required 'path'/);
  });

  it('rejects related that is not a list', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), 'repos:\n  - path: /tmp/api\nrelated: /tmp/x\n');
    expect(() => loadRepoManifest(path)).toThrow(/'related' must be a list/);
  });

  it('rejects a path listed in both repos and related', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), 'repos:\n  - path: /tmp/api\nrelated:\n  - path: /tmp/api\n');
    expect(() => loadRepoManifest(path)).toThrow(/both 'repos' and 'related'/);
  });

  it('extends the default checklist with manifest items', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
review:
  checklist:
    - Status codes are single letters; blank means active.
`);
    const list = effectiveReviewChecklist(loadRepoManifest(path)!);
    expect(list).toHaveLength(DEFAULT_REVIEW_CHECKLIST.length + 1);
    expect(list[list.length - 1]).toBe('Status codes are single letters; blank means active.');
  });

  it('replaces the default checklist when replaceDefaultChecklist is true', () => {
    const path = writeYaml(join(TEST_ROOT, 'repos.yaml'), `
repos:
  - path: /tmp/api
review:
  replaceDefaultChecklist: true
  checklist: [only this]
`);
    expect(effectiveReviewChecklist(loadRepoManifest(path)!)).toEqual(['only this']);
  });

  it('treats a manifest object without review as using the default list', () => {
    const m: RepoManifest = { defaultBase: 'd', branchPattern: 'b', repos: [], references: [], transitionAfterPush: 't' };
    expect(effectiveReviewChecklist(m)).toEqual([...DEFAULT_REVIEW_CHECKLIST]);
  });

  it('rejects malformed checklist values', () => {
    const notList = writeYaml(join(TEST_ROOT, 'a.yaml'), 'repos:\n  - path: /tmp/api\nreview:\n  checklist: nope\n');
    expect(() => loadRepoManifest(notList)).toThrow(/review.checklist must be a list/);
    const blank = writeYaml(join(TEST_ROOT, 'b.yaml'), 'repos:\n  - path: /tmp/api\nreview:\n  checklist: ["  "]\n');
    expect(() => loadRepoManifest(blank)).toThrow(/review.checklist\[0\]/);
    const badFlag = writeYaml(join(TEST_ROOT, 'c.yaml'), 'repos:\n  - path: /tmp/api\nreview:\n  replaceDefaultChecklist: yes please\n');
    expect(() => loadRepoManifest(badFlag)).toThrow(/replaceDefaultChecklist/);
  });

  it('default checklist covers the eleven standing failure modes', () => {
    expect(DEFAULT_REVIEW_CHECKLIST).toHaveLength(11);
    const joined = DEFAULT_REVIEW_CHECKLIST.join('\n');
    for (const word of ['Sentinel', 'Both directions', 'Field ownership', 'Bypass', 'Re-entry', 'Concurrency', 'premise', 'Constructor', 'Consistency with the rest', 'Stale read-modify-write', 'Who else must act']) {
      expect(joined).toContain(word);
    }
  });
});

describe('--base-local spec', () => {
  it('parses a bare ref as the default', () => {
    const s = parseBaseLocalSpec('stack/week-1');
    expect(s.defaultRef).toBe('stack/week-1');
    expect(s.perRepo.size).toBe(0);
  });

  it('parses repoPath=ref pairs alongside a bare ref', () => {
    const s = parseBaseLocalSpec('/r/api=stack/api, /r/ui=stack/ui,main');
    expect(s.defaultRef).toBe('main');
    expect(s.perRepo.get('/r/api')).toBe('stack/api');
    expect(s.perRepo.get('/r/ui')).toBe('stack/ui');
  });

  it('rejects empty, malformed, unsafe and duplicate bare refs', () => {
    expect(() => parseBaseLocalSpec(' , ')).toThrow(/needs a ref/);
    expect(() => parseBaseLocalSpec('/r/api=')).toThrow(/malformed/);
    expect(() => parseBaseLocalSpec('main; rm -rf /')).toThrow(/unsupported ref/);
    expect(() => parseBaseLocalSpec('a..b')).toThrow(/unsupported ref/);
    expect(() => parseBaseLocalSpec('a,b')).toThrow(/more than one bare ref/);
  });

  const repos = [
    { path: '/r/api', base: 'develop' },
    { path: '/r/ui', base: 'develop' },
  ];

  it('applies a bare ref only where it exists; the rest fall back to origin/<base>', () => {
    const exists = (p: string, ref: string) => p === '/r/api' && ref === 'stack';
    const out = resolveLocalBases(repos, parseBaseLocalSpec('stack'), exists);
    expect([...out.localBases]).toEqual([['/r/api', 'stack']]);
    expect(out.fallback).toEqual(['/r/ui']);
  });

  it('explicit pairs win over the bare ref and must exist', () => {
    const exists = () => true;
    const out = resolveLocalBases(repos, parseBaseLocalSpec('/r/ui=ui-stack,stack'), exists);
    expect(out.localBases.get('/r/ui')).toBe('ui-stack');
    expect(out.localBases.get('/r/api')).toBe('stack');
    expect(() => resolveLocalBases(repos, parseBaseLocalSpec('/r/ui=gone'), () => false)).toThrow(/does not exist in \/r\/ui/);
  });

  it('rejects a pair naming a repo outside the ticket scope', () => {
    expect(() => resolveLocalBases(repos, parseBaseLocalSpec('/r/other=x'), () => true)).toThrow(/not one of this ticket's repos/);
  });

  it('throws when the bare ref exists nowhere', () => {
    expect(() => resolveLocalBases(repos, parseBaseLocalSpec('stack'), () => false)).toThrow(/any of this ticket's repos/);
  });
});

describe('--base-local git flow (real repo, no origin needed)', () => {
  beforeEach(() => {
    TEST_ROOT = freshRoot();
  });
  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('cuts from the local ref and rebases onto it after the ref moves', () => {
    const dir = join(TEST_ROOT, 'repo');
    initRepo(dir);
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf-8' }).trim();
    git('checkout -q -b stack');
    writeFileSync(join(dir, 'stack.txt'), 'stack 1\n');
    git('add stack.txt');
    git('commit -q -m stack1');
    expect(refResolves(dir, 'stack')).toBe(true);
    expect(refResolves(dir, 'no-such-ref')).toBe(false);

    const repo = { path: dir, base: 'develop' };
    cutTicketBranch(repo, 'ticket/T-1', 'stack');
    writeFileSync(join(dir, 'ticket.txt'), 'ticket\n');
    git('add ticket.txt');
    git('commit -q -m ticket');

    // The local stack moves on while the ticket was being built
    git('checkout -q stack');
    writeFileSync(join(dir, 'stack2.txt'), 'stack 2\n');
    git('add stack2.txt');
    git('commit -q -m stack2');
    const stackTip = git('rev-parse stack');
    git('checkout -q ticket/T-1');

    expect(rebaseOntoBase(repo, 'stack')).toEqual({ status: 'clean' });
    expect(git('rev-parse HEAD~1')).toBe(stackTip);
  });
});

import { continueRebase, rebaseInProgress } from '../repos';
import { execSync as _exec } from 'child_process';
import { mkdtempSync as _mk, rmSync as _rm } from 'fs';
import { tmpdir as _tmp } from 'os';
import { join as _join } from 'path';

describe('continueRebase after merge-fix already finished the rebase', () => {
  it('treats "no rebase in progress" as clean', () => {
    const d = _mk(_join(_tmp(), 'tk-rebase-'));
    try {
      _exec('git init -q && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init', { cwd: d });
      expect(rebaseInProgress(d)).toBe(false);
      expect(continueRebase(d)).toEqual({ status: 'clean' });
    } finally {
      _rm(d, { recursive: true, force: true });
    }
  });
});
