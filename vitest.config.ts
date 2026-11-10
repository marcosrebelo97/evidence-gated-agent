import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Needs Docker: run with `npm run test:container`.
    exclude: ['test/container/**', 'node_modules/**'],
    testTimeout: 30_000,
  },
});
