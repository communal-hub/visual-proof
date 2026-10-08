import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          // Many tests shell out to git; the suite also runs next to browsers and dev servers.
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts', 'test/corpus/**/*.test.ts'],
          // Each file owns a dev server and a Chromium; too many side by side starve the
          // latency-sensitive tests (save-to-still, HMR barrier). Runs after the unit project.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
