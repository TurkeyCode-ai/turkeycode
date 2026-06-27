import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { aiTellsInLine, scanAiTells } from '../quick-check';

/**
 * Em-dashes and emojis are the two cheapest "an AI generated this" tells, banned
 * by the design bar (hyphens + real SVG icons instead). aiTellsInLine is the
 * deterministic detector the quick-check gate runs over generated source.
 */
describe('aiTellsInLine', () => {
  it('flags em and en dashes', () => {
    expect(aiTellsInLine('Find shops near you — fast')).toContain('em-dash');
    expect(aiTellsInLine('Open 9–5 daily')).toContain('em-dash');
  });

  it('flags emojis (pictographs, sparkles, coffee, flags)', () => {
    expect(aiTellsInLine('Welcome 🚀')).toContain('emoji');
    expect(aiTellsInLine('Powered by AI ✨')).toContain('emoji');
    expect(aiTellsInLine('Great coffee ☕')).toContain('emoji');
    expect(aiTellsInLine('Made in 🇺🇸')).toContain('emoji');
  });

  it('is clean for hyphens, arrows, and plain text', () => {
    expect(aiTellsInLine('Find shops near you - fast')).toEqual([]);
    expect(aiTellsInLine('Next ->')).toEqual([]);
    expect(aiTellsInLine('const total = a - b; // sum')).toEqual([]);
    expect(aiTellsInLine('Open 9-5 daily')).toEqual([]);
  });

  it('reports both kinds when a line has both', () => {
    const tells = aiTellsInLine('Launch day 🚀 — ship it');
    expect(tells).toContain('emoji');
    expect(tells).toContain('em-dash');
  });
});

/**
 * The design bar is about USER-FACING output. scanAiTells must only flag UI files
 * (markup/components/styles) - not backend code, and not console.* debug lines even
 * inside a UI file. An emoji in a seed's log is fine; an emoji in JSX copy is not.
 */
describe('scanAiTells scope (frontend-facing only)', () => {
  it('flags UI copy but ignores backend files and console logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ait-'));
    mkdirSync(join(dir, 'app'), { recursive: true });
    mkdirSync(join(dir, 'prisma'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    // backend - must NOT be flagged
    writeFileSync(join(dir, 'prisma', 'seed.ts'), 'console.log(`✓ Seeded — done 🚀`)\n');
    writeFileSync(join(dir, 'scripts', 'build.js'), 'const note = "ship it — 🚀";\n');
    // UI file with a debug log (skip) + real user-facing copy (flag)
    writeFileSync(
      join(dir, 'app', 'page.tsx'),
      'export default function P(){\n  console.log("done ✨")\n  return <h1>Welcome 🚀 to the app</h1>\n}\n'
    );
    const hits = scanAiTells(dir);
    const files = hits.map((h) => h.file.replace(/\\/g, '/'));
    expect(files).toContain('app/page.tsx');                 // JSX copy flagged
    expect(files.some((f) => f.includes('seed.ts'))).toBe(false);   // backend skipped
    expect(files.some((f) => f.includes('build.js'))).toBe(false);  // backend skipped
    // the only hit in page.tsx is the JSX line, not the console.log line
    const pageHits = hits.filter((h) => h.file.includes('page.tsx'));
    expect(pageHits.every((h) => h.snippet.includes('Welcome'))).toBe(true);
  });
});
