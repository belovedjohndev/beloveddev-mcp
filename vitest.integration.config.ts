import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.integration.test.ts'],
    // Suites share one PostgreSQL instance; bound concurrent database creation/drop I/O.
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
