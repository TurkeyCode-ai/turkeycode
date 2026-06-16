import { describe, it, expect } from 'vitest';
import { flattenAdf, formatJiraDuration } from '../jira';

describe('flattenAdf', () => {
  it('returns empty string for null/undefined', () => {
    expect(flattenAdf(null)).toBe('');
    expect(flattenAdf(undefined)).toBe('');
  });

  it('passes through plain strings', () => {
    expect(flattenAdf('hello world')).toBe('hello world');
  });

  it('flattens a simple paragraph ADF doc', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    };
    expect(flattenAdf(doc)).toBe('Hello\n\nworld');
  });

  it('collapses runs of blank lines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    };
    const out = flattenAdf(doc);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('inlines mention text and inline card URLs', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Assigned to ' },
            { type: 'mention', attrs: { text: '@alice' } },
            { type: 'text', text: ' see ' },
            { type: 'inlineCard', attrs: { url: 'https://example.com/spec' } },
          ],
        },
      ],
    };
    const out = flattenAdf(doc);
    expect(out).toContain('@alice');
    expect(out).toContain('https://example.com/spec');
  });

  it('walks nested lists', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
      ],
    };
    const out = flattenAdf(doc);
    expect(out).toContain('one');
    expect(out).toContain('two');
  });
});

describe('formatJiraDuration', () => {
  it('clamps sub-minute durations to 1m', () => {
    expect(formatJiraDuration(0)).toBe('1m');
    expect(formatJiraDuration(15_000)).toBe('1m');
    expect(formatJiraDuration(59_000)).toBe('1m');
  });

  it('formats minute-only durations', () => {
    expect(formatJiraDuration(60_000)).toBe('1m');
    expect(formatJiraDuration(5 * 60_000)).toBe('5m');
    expect(formatJiraDuration(45 * 60_000)).toBe('45m');
  });

  it('formats hour-only durations without an empty minutes segment', () => {
    expect(formatJiraDuration(3600_000)).toBe('1h');
    expect(formatJiraDuration(2 * 3600_000)).toBe('2h');
  });

  it('formats hour+minute durations', () => {
    expect(formatJiraDuration(3600_000 + 23 * 60_000)).toBe('1h 23m');
    expect(formatJiraDuration(2 * 3600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});
