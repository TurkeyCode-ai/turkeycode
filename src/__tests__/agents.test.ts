import { describe, it, expect, afterEach } from 'vitest';
import { agentPinConflicts } from '../orchestrator';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CLAUDE_BACKEND,
  CODEX_BACKEND,
  GEMINI_BACKEND,
  OPENCODE_BACKEND,
  PHASE_TIERS,
  buildAgentArgs,
  buildAgentEnv,
  detectAgentSignals,
  resolveModelForPhase,
  resolveBackendId,
  loadCustomAgents,
  getBackend,
  AgentBackendSpec,
} from '../agents';
import { Spawner } from '../spawner';

// ---------------------------------------------------------------------------
// Arg construction
// ---------------------------------------------------------------------------

describe('buildAgentArgs', () => {
  it('a blind claude session gets no MCP servers, not even an explicit config', () => {
    const args = buildAgentArgs(CLAUDE_BACKEND, { blind: true, mcpConfig: '/tmp/aimem.json' });
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('/tmp/aimem.json');
  });

  it('a normal session is unchanged', () => {
    const args = buildAgentArgs(CLAUDE_BACKEND, { mcpConfig: '/tmp/aimem.json' });
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).toContain('/tmp/aimem.json');
  });

  it('a backend with no blind flag adds nothing', () => {
    const spec = { ...CLAUDE_BACKEND, blindFlags: undefined };
    expect(buildAgentArgs(spec, { blind: true })).not.toContain('--strict-mcp-config');
  });

  it('claude arg vector is exactly what the spawner always passed (regression lock)', () => {
    expect(buildAgentArgs(CLAUDE_BACKEND, { model: 'sonnet' })).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--verbose',
      '--input-format', 'text',
      '--model', 'sonnet',
    ]);
  });

  it('claude appends --mcp-config when given a validated path', () => {
    expect(buildAgentArgs(CLAUDE_BACKEND, { mcpConfig: '/tmp/mcp.json' })).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--verbose',
      '--input-format', 'text',
      '--mcp-config', '/tmp/mcp.json',
    ]);
  });

  it('codex uses exec with the full sandbox bypass and a stdin sentinel', () => {
    const args = buildAgentArgs(CODEX_BACKEND, { model: 'gpt-5-codex' });
    expect(args).toContain('exec');
    // Must be the full bypass, NOT --full-auto: full-auto keeps the network
    // sandbox and builds need npm install.
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args.slice(-3)).toEqual(['-m', 'gpt-5-codex', '-']);
  });

  it('arg-delivery backends carry the prompt in argv', () => {
    const args = buildAgentArgs(OPENCODE_BACKEND, { prompt: 'build the thing' });
    expect(args[0]).toBe('run');
    expect(args).toContain('--auto');
    expect(args[args.length - 1]).toBe('build the thing');
  });

  it('stdin-delivery backends never carry the prompt in argv', () => {
    for (const spec of [CLAUDE_BACKEND, CODEX_BACKEND, GEMINI_BACKEND]) {
      const args = buildAgentArgs(spec, { prompt: 'secret prompt' });
      expect(args, spec.id).not.toContain('secret prompt');
    }
  });

  it('a model is silently dropped for a backend with no model flag', () => {
    const spec: AgentBackendSpec = { ...OPENCODE_BACKEND, modelFlag: undefined };
    expect(buildAgentArgs(spec, { model: 'x', prompt: 'p' })).toEqual(['run', '--auto', 'p']);
  });
});

// ---------------------------------------------------------------------------
// Env policy
// ---------------------------------------------------------------------------

describe('buildAgentEnv', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://secret',
    STRIPE_SECRET_KEY: 'sk_live',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oai',
    CLAUDECODE: '1',
  } as NodeJS.ProcessEnv;

  it('always strips global secrets and forces CI', () => {
    for (const spec of [CLAUDE_BACKEND, CODEX_BACKEND, GEMINI_BACKEND, OPENCODE_BACKEND]) {
      const env = buildAgentEnv(spec, baseEnv);
      expect(env.DATABASE_URL, spec.id).toBeUndefined();
      expect(env.STRIPE_SECRET_KEY, spec.id).toBeUndefined();
      expect(env.CI, spec.id).toBe('true');
      expect(env.PATH, spec.id).toBe('/usr/bin');
    }
  });

  it('claude strips ANTHROPIC_API_KEY by default (Max login) and CLAUDECODE always', () => {
    const env = buildAgentEnv(CLAUDE_BACKEND, baseEnv);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    // Other vendors' keys pass through untouched.
    expect(env.OPENAI_API_KEY).toBe('sk-oai');
  });

  it('TURKEYCODE_USE_API_KEY=1 keeps the vendor key as the auth source', () => {
    const env = buildAgentEnv(CLAUDE_BACKEND, { ...baseEnv, TURKEYCODE_USE_API_KEY: '1' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.CLAUDECODE).toBeUndefined(); // nested guard is unconditional
  });

  it('codex passes OPENAI_API_KEY through and does not strip CLAUDECODE-style guards it does not declare', () => {
    const env = buildAgentEnv(CODEX_BACKEND, baseEnv);
    expect(env.OPENAI_API_KEY).toBe('sk-oai');
    expect(env.CLAUDECODE).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Output classifiers
// ---------------------------------------------------------------------------

describe('detectAgentSignals (per backend)', () => {
  it('codex quota exhaustion needs vendor context, like claude', () => {
    const s = detectAgentSignals(CODEX_BACKEND, 'openai: insufficient_quota, exceeded your current quota');
    expect(s.creditExhausted).toBe(true);
    // Domain text alone must not trip it.
    const domain = detectAgentSignals(CODEX_BACKEND, 'the invoice exceeded your current quota of free deliveries');
    expect(domain.creditExhausted).toBe(false);
  });

  it('gemini RESOURCE_EXHAUSTED is a rate-limit signal', () => {
    expect(detectAgentSignals(GEMINI_BACKEND, 'Error: RESOURCE_EXHAUSTED').rateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('resolveModelForPhase', () => {
  afterEach(() => {
    delete process.env.TURKEYCODE_MODEL;
    delete process.env.TURKEYCODE_MODEL_BUILD;
  });

  it('claude resolves the historical model for every phase (regression lock)', () => {
    const expected: Record<string, string> = {
      'scope': 'opus', 'research': 'sonnet', 'plan': 'opus',
      'build': 'claude-fable-5',
      'qa-smoke': 'haiku', 'qa-functional': 'sonnet', 'qa-visual': 'sonnet', 'qa-verdict': 'sonnet',
      'qa-fix': 'claude-fable-5', 'quick-fix': 'sonnet',
      'code-review': 'sonnet', 'ticket-review': 'opus', 'aar': 'sonnet', 'polish': 'sonnet',
    };
    for (const phase of Object.keys(PHASE_TIERS)) {
      expect(resolveModelForPhase(CLAUDE_BACKEND, phase), phase).toBe(expected[phase]);
    }
  });

  it('env overrides beat backend tables, per-phase beats global', () => {
    process.env.TURKEYCODE_MODEL = 'globalmodel';
    expect(resolveModelForPhase(CODEX_BACKEND, 'build')).toBe('globalmodel');
    process.env.TURKEYCODE_MODEL_BUILD = 'buildmodel';
    expect(resolveModelForPhase(CODEX_BACKEND, 'build')).toBe('buildmodel');
    expect(resolveModelForPhase(CODEX_BACKEND, 'plan')).toBe('globalmodel');
  });

  it('opencode has no tier table — undefined means the CLI default model', () => {
    expect(resolveModelForPhase(OPENCODE_BACKEND, 'build')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

describe('resolveBackendId', () => {
  afterEach(() => {
    delete process.env.TURKEYCODE_AGENT;
  });

  it('precedence: flag > env > state pin > claude', () => {
    expect(resolveBackendId({})).toBe('claude');
    expect(resolveBackendId({ stateAgent: 'codex' })).toBe('codex');
    process.env.TURKEYCODE_AGENT = 'gemini';
    expect(resolveBackendId({})).toBe('gemini');
    expect(resolveBackendId({ cliFlag: 'opencode' })).toBe('opencode');
  });

  it('an explicit choice conflicting with a resumed pin is a hard error', () => {
    expect(() => resolveBackendId({ cliFlag: 'codex', stateAgent: 'claude' }))
      .toThrow(/pinned|started with agent/i);
    // Matching explicit choice is fine.
    expect(resolveBackendId({ cliFlag: 'codex', stateAgent: 'codex' })).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// agents.yaml loader
// ---------------------------------------------------------------------------

describe('loadCustomAgents', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'turkey-agents-'));
    const p = join(dir, 'agents.yaml');
    writeFileSync(p, content);
    return p;
  }

  it('returns [] when the file does not exist', () => {
    expect(loadCustomAgents('/nonexistent/agents.yaml')).toEqual([]);
  });

  it('parses a minimal custom agent with defaults', () => {
    const p = writeYaml(`
agents:
  - id: myagent
    binary: /usr/local/bin/myagent
    baseArgs: ["go", "--auto-approve"]
    promptDelivery: arg
    modelFlag: "-m"
`);
    const [spec] = loadCustomAgents(p);
    expect(spec.id).toBe('myagent');
    expect(spec.displayName).toBe('myagent');
    expect(spec.versionArgs).toEqual(['--version']);
    expect(spec.capabilities.subagents).toBe(false);
    expect(buildAgentArgs(spec, { model: 'm1', prompt: 'hi' }))
      .toEqual(['go', '--auto-approve', '-m', 'm1', 'hi']);
  });

  it('rejects a missing binary with a path-bearing error', () => {
    const p = writeYaml(`
agents:
  - id: broken
`);
    expect(() => loadCustomAgents(p)).toThrow(/agents\[0\].*binary/);
  });

  it('rejects an invalid classifier regex naming the pattern', () => {
    const p = writeYaml(`
agents:
  - id: badregex
    binary: x
    classifiers:
      rateLimit: ["[unclosed"]
`);
    expect(() => loadCustomAgents(p)).toThrow(/invalid regex.*\[unclosed/);
  });

  it('a custom entry can override a built-in by id', () => {
    const p = writeYaml(`
agents:
  - id: codex
    binary: /opt/custom-codex
`);
    expect(getBackend('codex', p).binary).toBe('/opt/custom-codex');
    // Untouched built-ins remain.
    expect(getBackend('claude', p).binary).toBe('claude');
  });

  it('getBackend names the available ids on an unknown id', () => {
    expect(() => getBackend('nope', '/nonexistent/agents.yaml'))
      .toThrow(/claude.*codex.*gemini.*opencode/);
  });
});

// ---------------------------------------------------------------------------
// Fake-binary integration: delivery mode + done-file flow, no real agent
// ---------------------------------------------------------------------------

describe('Spawner with a fake backend binary', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fakeBackend(script: string): AgentBackendSpec {
    dir = mkdtempSync(join(tmpdir(), 'turkey-fake-'));
    const bin = join(dir, 'fake-agent.sh');
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    return {
      id: 'fake',
      displayName: 'Fake Agent',
      binary: bin,
      baseArgs: ['--auto'],
      promptDelivery: 'stdin',
      modelFlag: '-m',
      env: {},
      versionArgs: ['--version'],
      installHint: 'n/a',
      classifiers: { rateLimit: [], creditExhausted: [], apiErrorContext: [] },
      models: { tiers: {} },
      capabilities: { subagents: false, skills: false, mcpConfig: false, multimodalImages: false },
    };
  }

  it('spawns the spec binary, delivers the prompt on stdin, honors the done file', async () => {
    const backend = fakeBackend(
      '#!/bin/sh\n' +
      'echo "argv:$@"\n' +
      'prompt=$(cat)\n' +
      'echo "got:$prompt"\n' +
      'touch session.done\n' +
      // Pad stdout past the suspicious-short heuristic and linger so the
      // done-file poll (5s) is what ends the session path.
      'printf "%0100d" 0\n'
    );
    const spawner = new Spawner({ backend });
    const result = await spawner.run({
      cwd: dir,
      prompt: 'hello fake',
      timeoutMs: 30000,
      sessionName: 'fake-test',
      doneFile: 'session.done',
      model: 'fake-model',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('argv:--auto -m fake-model');
    expect(result.stdout).toContain('got:hello fake');
  }, 40000);

  it('arg delivery puts the prompt in argv instead of stdin', async () => {
    const backend = { ...fakeBackend(
      '#!/bin/sh\n' +
      'echo "argv:$@"\n' +
      'touch session.done\n' +
      'printf "%0100d" 0\n'
    ), promptDelivery: 'arg' as const };
    const spawner = new Spawner({ backend });
    const result = await spawner.run({
      cwd: dir,
      prompt: 'prompt-in-argv',
      timeoutMs: 30000,
      sessionName: 'fake-arg-test',
      doneFile: 'session.done',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('argv:--auto prompt-in-argv');
  }, 40000);
});

describe('rate-limit detection on numbers', () => {
  it.each([CLAUDE_BACKEND, CODEX_BACKEND, GEMINI_BACKEND, OPENCODE_BACKEND])('$id ignores 429 in ordinary output', backend => {
    for (const text of ['Frames 60 through 210 are 34,429 bytes each', 'read 429 files', 'frame00000429.png', 'port 8429']) {
      expect(detectAgentSignals(backend, text).rateLimited, text).toBe(false);
    }
  });

  it.each([CLAUDE_BACKEND, CODEX_BACKEND, GEMINI_BACKEND, OPENCODE_BACKEND])('$id still sees a real 429', backend => {
    for (const text of ['Error: 429 Too Many Requests', 'API Error: 429', 'HTTP 429', 'status code 429']) {
      expect(detectAgentSignals(backend, text).rateLimited, text).toBe(true);
    }

describe('agent pin', () => {
  it('rejects a different backend on a run in progress', () => {
    expect(agentPinConflicts({ agent: 'codex', currentPhase: 'build' }, 'claude')).toBe(true);
  });

  it('allows any backend once the run is finished or not started', () => {
    expect(agentPinConflicts({ agent: 'codex', currentPhase: 'done' }, 'claude')).toBe(false);
    expect(agentPinConflicts({ agent: 'codex', currentPhase: 'init' }, 'claude')).toBe(false);
  });

  it('allows the pinned backend and a run with no pin', () => {
    expect(agentPinConflicts({ agent: 'claude', currentPhase: 'build' }, 'claude')).toBe(false);
    expect(agentPinConflicts({ currentPhase: 'build' }, 'claude')).toBe(false);
  });
});
