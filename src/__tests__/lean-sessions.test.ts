/**
 * Sessions carry only what they need: the MCP servers turkeycode was given
 * plus the ones the owner chose to keep, and for stages that only read, edit
 * and run commands, only the tools for that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildAgentArgs,
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  keepList,
  resolveSessionMcp,
} from '../agents';

const homes: string[] = [];
/** A fake home with a user-level registry holding two servers. */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'tc-home-'));
  homes.push(h);
  writeFileSync(join(h, '.claude.json'), JSON.stringify({
    unrelated: true,
    mcpServers: {
      memory: { type: 'stdio', command: '/bin/memory', args: ['serve'] },
      mail: { type: 'http', url: 'https://mail.example/mcp', headers: { Authorization: 'Bearer secret' } },
    },
  }));
  return h;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

const servers = (path: string) => Object.keys(JSON.parse(readFileSync(path, 'utf-8')).mcpServers).sort();

describe('keepList', () => {
  it('reads the environment first, then ~/.turkeycode/config.json, else nothing', () => {
    const h = home();
    expect(keepList({}, h)).toEqual([]);
    mkdirSync(join(h, '.turkeycode'));
    writeFileSync(join(h, '.turkeycode', 'config.json'), JSON.stringify({ keepMcpServers: ['memory', ' ', 7] }));
    expect(keepList({}, h)).toEqual(['memory']);
    expect(keepList({ TURKEYCODE_KEEP_MCP: 'a, b ,' }, h)).toEqual(['a', 'b']);
    // An empty variable is a decision to keep nothing, not "unset".
    expect(keepList({ TURKEYCODE_KEEP_MCP: '' }, h)).toEqual([]);
  });

  it('an unreadable config file keeps nothing', () => {
    const h = home();
    mkdirSync(join(h, '.turkeycode'));
    writeFileSync(join(h, '.turkeycode', 'config.json'), '{nope');
    expect(keepList({}, h)).toEqual([]);
  });
});

describe('resolveSessionMcp', () => {
  it('by default a session is cut off from every user-level server', () => {
    const h = home();
    expect(resolveSessionMcp(CLAUDE_BACKEND, undefined, [], h)).toEqual({ isolate: true, missing: [] });
    expect(existsSync(join(h, '.turkeycode'))).toBe(false);
  });

  it('a kept server is the only user-level one passed on, in an owner-only file outside any project', () => {
    const h = home();
    const res = resolveSessionMcp(CLAUDE_BACKEND, undefined, ['memory'], h);
    expect(res.isolate).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.configPath!.startsWith(join(h, '.turkeycode', 'session-mcp'))).toBe(true);
    expect(servers(res.configPath!)).toEqual(['memory']);
    expect(readFileSync(res.configPath!, 'utf-8')).not.toContain('secret');
    expect(statSync(res.configPath!).mode & 0o777).toBe(0o600);
    // The same set resolves to the same file: no pile-up across sessions.
    expect(resolveSessionMcp(CLAUDE_BACKEND, undefined, ['memory'], h).configPath).toBe(res.configPath);
  });

  it('servers turkeycode was explicitly given are kept and merged with the kept ones', () => {
    const h = home();
    const explicit = join(h, 'ticket-mcp.json');
    writeFileSync(explicit, JSON.stringify({ mcpServers: { jira: { command: 'jira-mcp' } } }));
    expect(servers(resolveSessionMcp(CLAUDE_BACKEND, explicit, [], h).configPath!)).toEqual(['jira']);
    expect(servers(resolveSessionMcp(CLAUDE_BACKEND, explicit, ['memory'], h).configPath!)).toEqual(['jira', 'memory']);
  });

  it('a kept name that is not registered is reported, not invented', () => {
    const h = home();
    expect(resolveSessionMcp(CLAUDE_BACKEND, undefined, ['nope'], h)).toEqual({ isolate: true, missing: ['nope'] });
  });

  it('"all" restores the old behaviour: no isolation, explicit config passed through', () => {
    const h = home();
    expect(resolveSessionMcp(CLAUDE_BACKEND, '/x/mcp.json', ['all'], h))
      .toEqual({ isolate: false, configPath: '/x/mcp.json', missing: [] });
  });

  it('a backend that cannot isolate is left exactly as before', () => {
    const h = home();
    const noIsolation = { ...CODEX_BACKEND, blindFlags: undefined };
    expect(resolveSessionMcp(noIsolation, '/x/mcp.json', ['memory'], h))
      .toEqual({ isolate: false, configPath: '/x/mcp.json', missing: [] });
  });
});

describe('session arguments', () => {
  it('an isolated session is cut off and still handed its config', () => {
    const args = buildAgentArgs(CLAUDE_BACKEND, { isolateMcp: true, mcpConfig: '/h/kept.json' });
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', '/h/kept.json']);
  });

  it('a blind session gets no config at all, whatever was kept', () => {
    const args = buildAgentArgs(CLAUDE_BACKEND, { blind: true, isolateMcp: true, mcpConfig: '/h/kept.json' });
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it('a named tool set limits the session to those tools; no set means every tool', () => {
    const core = buildAgentArgs(CLAUDE_BACKEND, { toolSet: 'core' });
    expect(core.slice(core.indexOf('--tools'), core.indexOf('--tools') + 2))
      .toEqual(['--tools', 'Bash,Read,Edit,Write,Glob,Grep']);
    const web = buildAgentArgs(CLAUDE_BACKEND, { toolSet: 'core+web' });
    expect(web[web.indexOf('--tools') + 1]).toBe('Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch');
    expect(buildAgentArgs(CLAUDE_BACKEND, {})).not.toContain('--tools');
    expect(buildAgentArgs(CLAUDE_BACKEND, { toolSet: 'no-such-set' })).not.toContain('--tools');
  });

  it('a backend with no tools flag ignores tool sets', () => {
    expect(buildAgentArgs(CODEX_BACKEND, { toolSet: 'core' })).toEqual(buildAgentArgs(CODEX_BACKEND, {}));
  });

  it('a probe keeps its own empty tool list', () => {
    const args = buildAgentArgs(CLAUDE_BACKEND, { probe: true, toolSet: 'core' });
    expect(args.filter((a) => a === '--tools')).toHaveLength(1);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });
});
