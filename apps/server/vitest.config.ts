import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → unit → integration. Only integration needs a
// database (it arrives with the schema in KURO-T-0.2).
export default defineConfig({
  test: {
    projects: [{ test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } }],
  },
});
