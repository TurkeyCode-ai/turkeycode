import { describe, it, expect } from 'vitest';
import { scopeManifestToTriage } from '../ticket-orchestrator';
import { RepoManifest } from '../repos';

const manifest: RepoManifest = {
  defaultBase: 'develop',
  branchPattern: 'ticket/{key}-{slug}',
  repos: [
    { path: '/r/orders-api', role: 'orders-api', base: 'develop' },
    { path: '/r/inventory-api', role: 'inventory-api', base: 'develop' },
    { path: '/r/inventory-ui', role: 'inventory-ui', base: 'develop' },
  ],
  references: [],
  transitionAfterPush: 'In Review',
};

describe('scopeManifestToTriage', () => {
  it('filters the manifest to just the named repos', () => {
    const out = scopeManifestToTriage(manifest, ['/r/inventory-api'], 'PROJ-1');
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0].path).toBe('/r/inventory-api');
  });

  it('preserves manifest-level fields (branchPattern, defaultBase)', () => {
    const out = scopeManifestToTriage(manifest, ['/r/inventory-api'], 'PROJ-1');
    expect(out.defaultBase).toBe('develop');
    expect(out.branchPattern).toBe('ticket/{key}-{slug}');
  });

  it('keeps the manifest order even when triage lists in a different order', () => {
    const out = scopeManifestToTriage(
      manifest,
      ['/r/inventory-ui', '/r/orders-api'],
      'PROJ-1',
    );
    expect(out.repos.map((r) => r.path)).toEqual(['/r/orders-api', '/r/inventory-ui']);
  });

  it('throws when triage names no repos', () => {
    expect(() => scopeManifestToTriage(manifest, [], 'PROJ-9')).toThrow(/did not name any repos/);
  });

  it('throws when triage names a path that is not in the manifest', () => {
    expect(() =>
      scopeManifestToTriage(manifest, ['/r/inventory-api', '/r/who-dis'], 'PROJ-9'),
    ).toThrow(/not in the manifest/);
  });

  it('does not partially scope on unknown paths — all-or-nothing', () => {
    expect(() =>
      scopeManifestToTriage(manifest, ['/r/who-dis'], 'PROJ-9'),
    ).toThrow();
  });

  it('passes references through unchanged so the build prompt still sees them', () => {
    const withRefs: RepoManifest = {
      ...manifest,
      references: [{ path: '/legacy/cynergi', role: 'legacy' }],
    };
    const out = scopeManifestToTriage(withRefs, ['/r/inventory-api'], 'PROJ-1');
    expect(out.references).toEqual(withRefs.references);
  });
});
