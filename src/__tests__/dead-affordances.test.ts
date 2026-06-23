import { describe, it, expect } from 'vitest';
import { deadAffordancesInLine } from '../quick-check';

/**
 * Dead affordances are the blatant "a button that does nothing" cases - an anchor
 * to "#"/""/void(0) or an empty click handler. SA Coffee shipped a no-op nav and a
 * routeless directions link; this catches the deterministic subset before QA.
 */
describe('deadAffordancesInLine', () => {
  it('flags anchors that go nowhere', () => {
    expect(deadAffordancesInLine('<a href="#">Browse Cafes</a>')).toContain('hash-href');
    expect(deadAffordancesInLine('<a href="">Click</a>')).toContain('empty-href');
    expect(deadAffordancesInLine('<a href="javascript:void(0)">x</a>')).toContain('void-href');
  });

  it('flags empty click handlers', () => {
    expect(deadAffordancesInLine('<button onClick={() => {}}>Go</button>')).toContain('empty-onclick');
    expect(deadAffordancesInLine('<button onClick={function() {}}>Go</button>')).toContain('empty-onclick');
  });

  it('does not flag real links and handlers', () => {
    expect(deadAffordancesInLine('<Link href={`/shop/${shop.id}`}>View details</Link>')).toEqual([]);
    expect(deadAffordancesInLine('<a href="https://example.com/x">Open</a>')).toEqual([]);
    expect(deadAffordancesInLine('<button onClick={() => setViewMode("map")}>Map</button>')).toEqual([]);
    expect(deadAffordancesInLine('<button onClick={handleNearMeClick}>Near me</button>')).toEqual([]);
  });
});
