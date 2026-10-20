import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → unit → integration. Only integration needs a
// database, and it runs one file at a time against a freshly created *_test database.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
