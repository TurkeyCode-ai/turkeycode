import { describe, it, expect } from 'vitest';
import { buildNodeConnectionTest } from '../quick-check';
import { resolveMigrateCmd } from '../deploy/run-local';
import type { ProjectDetection } from '../deploy/detect';

/**
 * buildNodeConnectionTest must read the connection string from process.env at
 * runtime, never inline it into the `node -e "..."` script source — a DB password
 * with a double-quote/`$`/backtick would otherwise break out of the shell string
 * or inject a subshell. These tests pin that property.
 */
describe('buildNodeConnectionTest (DB connstring injection)', () => {
  for (const dbType of ['postgres', 'mysql', 'mongodb', 'redis'] as const) {
    it(`${dbType}: reads from process.env.TURKEY_DB_URL, never inlines a value`, () => {
      const script = buildNodeConnectionTest(dbType);
      expect(script).toBeTruthy();
      expect(script).toContain('process.env.TURKEY_DB_URL');
      // No connection-string literal should appear (the old code inlined '${safe}').
      expect(script).not.toContain('://');
      expect(script).not.toMatch(/connectionString:'/);
    });
  }

  it('returns null for an unsupported db type', () => {
    // sqlite has no network driver test
    expect(buildNodeConnectionTest('sqlite' as never)).toBeNull();
  });
});

/**
 * resolveMigrateCmd must prefer an explicit migrate script, and fall back to
 * Prisma `db push` for Node+Postgres projects that ship Prisma but declare no
 * migrate script — otherwise the app boots against an empty database.
 */
describe('resolveMigrateCmd', () => {
  const base = (over: Partial<ProjectDetection>): ProjectDetection =>
    ({
      name: 'app',
      runtime: 'node',
      runtimeVersion: '20',
      stack: 'next',
      scripts: {},
      features: { database: false },
      ...over,
    } as unknown as ProjectDetection);

  it('prefers an explicit migrate script', () => {
    const det = base({ scripts: { migrate: 'npm run db:migrate' } as ProjectDetection['scripts'] });
    expect(resolveMigrateCmd(det, '/nonexistent-path-xyz')).toBe('npm run db:migrate');
  });

  it('returns undefined for a non-postgres project with no migrate script', () => {
    const det = base({ features: { database: 'mysql' } as ProjectDetection['features'] });
    expect(resolveMigrateCmd(det, '/nonexistent-path-xyz')).toBeUndefined();
  });

  it('returns undefined when database is false and no migrate script', () => {
    const det = base({});
    expect(resolveMigrateCmd(det, '/nonexistent-path-xyz')).toBeUndefined();
  });
});
