import { describe, it, expect } from 'vitest';
import { aiTellsInLine } from '../quick-check';

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
