import { describe, it, expect, afterEach } from 'vitest';
import { infraProvidedByEnv } from '../quick-check';

/**
 * In the build sandbox the datastore arrives as an env var (DATABASE_URL etc.)
 * from a throwaway sidecar, and there is no Docker daemon. When that's the case,
 * quick-check must NOT try to install Docker / run docker-compose for a workspace
 * compose file or Dockerfile (that's the app's deploy config, not infra to run now).
 */
describe('infraProvidedByEnv', () => {
  const keys = ['DATABASE_URL', 'REDIS_URL', 'MONGO_URL', 'MONGODB_URI'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is true when DATABASE_URL is set (sidecar-provided DB)', () => {
    for (const k of keys) delete process.env[k];
    process.env.DATABASE_URL = 'postgresql://turkey:turkey@10.0.0.2:5432/app';
    expect(infraProvidedByEnv()).toBe(true);
  });

  it('is true for a redis/mongo sidecar env too', () => {
    for (const k of keys) delete process.env[k];
    process.env.REDIS_URL = 'redis://10.0.0.3:6379';
    expect(infraProvidedByEnv()).toBe(true);
  });

  it('is false when no infra env var is present', () => {
    for (const k of keys) delete process.env[k];
    expect(infraProvidedByEnv()).toBe(false);
  });
});
