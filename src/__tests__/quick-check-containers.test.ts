/**
 * The quick check used to read every running container on the machine as the
 * project's own. A static calculator was reported as a Postgres + Redis app
 * because two unrelated projects had databases up, and the check then probed
 * those containers and could fail the build on their health.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { containersOwnedBy } from '../quick-check';

const row = (name: string, image: string, composeDir = '') => [name, image, composeDir].join('\t');

describe('containersOwnedBy', () => {
  let root: string;
  let project: string;
  let other: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tc-containers-'));
    project = join(root, 'calculator');
    other = join(root, 'milton');
    mkdirSync(join(project, 'infra'), { recursive: true });
    mkdirSync(other);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ignores databases that other projects are running', () => {
    const ps = [
      row('milton-dev-copy', 'postgres:16', other),
      row('tc-sdd-redis', 'redis:7'),
    ].join('\n');
    expect(containersOwnedBy(ps, project)).toEqual([]);
  });

  it('keeps containers Compose started from the project directory', () => {
    const ps = [
      row('calculator-db-1', 'postgres:16', project),
      row('milton-dev-copy', 'postgres:16', other),
    ].join('\n');
    expect(containersOwnedBy(ps, project)).toEqual([{ name: 'calculator-db-1', image: 'postgres:16' }]);
  });

  it('keeps containers started from a compose file below the project directory', () => {
    const ps = row('calculator-cache-1', 'redis:7', join(project, 'infra'));
    expect(containersOwnedBy(ps, project).map(c => c.name)).toEqual(['calculator-cache-1']);
  });

  it('does not treat a sibling with the same name prefix as the project', () => {
    const sibling = join(root, 'calculator-old');
    mkdirSync(sibling);
    expect(containersOwnedBy(row('old-db-1', 'postgres:16', sibling), project)).toEqual([]);
  });

  it('does not claim a container started from a parent directory', () => {
    expect(containersOwnedBy(row('mono-db-1', 'postgres:16', root), project)).toEqual([]);
  });

  it('matches through symlinks', () => {
    const link = join(root, 'calc-link');
    symlinkSync(project, link);
    expect(containersOwnedBy(row('calculator-db-1', 'postgres:16', project), link)).toHaveLength(1);
  });

  it('handles empty output', () => {
    expect(containersOwnedBy('', project)).toEqual([]);
    expect(containersOwnedBy('\n', project)).toEqual([]);
  });
});
