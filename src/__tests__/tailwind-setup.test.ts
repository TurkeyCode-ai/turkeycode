import { describe, it, expect } from 'vitest';
import { tailwindV4SetupError } from '../quick-check';

/**
 * Tailwind v4 needs @tailwindcss/postcss (Next.js/PostCSS) or @tailwindcss/vite
 * (Vite) wired in, or the build emits no utility classes and the app ships
 * unstyled — exactly what SA Coffee Finder shipped. This deterministic guard
 * catches it in quick-check so the fix loop resolves it before QA.
 */
describe('tailwindV4SetupError', () => {
  it('flags the SA Coffee case: v4 installed, no postcss plugin/config', () => {
    const err = tailwindV4SetupError({ tailwindcss: '^4.0.0', next: '^15.1.6' }, null, null);
    expect(err).toBeTruthy();
    expect(err).toMatch(/UNSTYLED/);
  });

  it('passes when @tailwindcss/postcss is installed AND referenced in postcss config', () => {
    const deps = { tailwindcss: '^4.3.1', '@tailwindcss/postcss': '^4.3.1' };
    const postcss = 'export default { plugins: { "@tailwindcss/postcss": {} } };';
    expect(tailwindV4SetupError(deps, postcss, null)).toBeNull();
  });

  it('fails when the plugin is a dep but the postcss config does not use it', () => {
    const deps = { tailwindcss: '^4.0.0', '@tailwindcss/postcss': '^4.0.0' };
    expect(tailwindV4SetupError(deps, 'export default { plugins: { autoprefixer: {} } };', null)).toBeTruthy();
  });

  it('passes for the Vite path (@tailwindcss/vite + vite config)', () => {
    const deps = { tailwindcss: '4.3.1', '@tailwindcss/vite': '4.3.1' };
    const vite = 'import tailwindcss from "@tailwindcss/vite"; export default { plugins: [tailwindcss()] };';
    expect(tailwindV4SetupError(deps, null, vite)).toBeNull();
  });

  it('ignores Tailwind v3 (different setup, not this failure mode)', () => {
    expect(tailwindV4SetupError({ tailwindcss: '^3.4.0' }, null, null)).toBeNull();
  });

  it('ignores apps that do not use Tailwind', () => {
    expect(tailwindV4SetupError({ next: '^15.0.0' }, null, null)).toBeNull();
  });
});
