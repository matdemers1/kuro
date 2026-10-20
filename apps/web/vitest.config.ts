import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Components render to static markup in Node — structure, not behaviour; Playwright drives the
// real thing.
export default defineConfig({
  plugins: [react()],
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
