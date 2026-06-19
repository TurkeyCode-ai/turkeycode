import { describe, it, expect } from 'vitest';
import { isUnsafeWorkDir } from '../orchestrator';

describe('isUnsafeWorkDir', () => {
  const home = '/Users/chadcox';

  it('refuses the home directory itself (with or without trailing slash)', () => {
    expect(isUnsafeWorkDir('/Users/chadcox', home)).toBe(true);
    expect(isUnsafeWorkDir('/Users/chadcox/', home)).toBe(true);
  });

  it('refuses system roots', () => {
    for (const d of ['/', '/usr', '/etc', '/var', '/tmp', '/Library', '/System', '/Applications', '/Users', '/root']) {
      expect(isUnsafeWorkDir(d, home)).toBe(true);
    }
  });

  it('refuses a Windows drive root', () => {
    expect(isUnsafeWorkDir('C:', home)).toBe(true);
    expect(isUnsafeWorkDir('C:\\', home)).toBe(true);
  });

  it('allows any subdirectory of home or system dirs', () => {
    expect(isUnsafeWorkDir('/Users/chadcox/projects/app', home)).toBe(false);
    expect(isUnsafeWorkDir('/tmp/dadjoke-build', home)).toBe(false);
    expect(isUnsafeWorkDir('/Users/chadcox/my-app', home)).toBe(false);
    expect(isUnsafeWorkDir('/opt/work/thing', home)).toBe(false);
  });
});
