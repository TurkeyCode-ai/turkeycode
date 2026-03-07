import { describe, it, expect } from 'vitest';
import { Spawner } from '../spawner';

describe('Spawner', () => {
  it('can be instantiated', () => {
    const spawner = new Spawner();
    expect(spawner).toBeDefined();
  });

  it('accepts verbose option', () => {
    const spawner = new Spawner({ verbose: true });
    expect(spawner).toBeDefined();
  });

  it('has run method', () => {
    const spawner = new Spawner();
    expect(typeof spawner.run).toBe('function');
  });

  it('has runParallel method', () => {
    const spawner = new Spawner();
    expect(typeof (spawner as any).runParallel).toBe('function');
  });
});
