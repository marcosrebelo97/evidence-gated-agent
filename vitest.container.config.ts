import { defineConfig } from 'vitest/config';

/** Integration suite for isolation "container". Needs Docker; builds its own test image. */
export default defineConfig({
  test: {
    include: ['test/container/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
