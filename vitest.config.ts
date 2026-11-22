import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    // The landing site has its own tests, written for Node's built-in runner.
    // Run them with `npm test` inside site/.
    exclude: [...configDefaults.exclude, 'site/**']
  }
});
