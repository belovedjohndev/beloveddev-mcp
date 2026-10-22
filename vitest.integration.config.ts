import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./packages/test-support/test/integration-setup.ts'],
    include: ['packages/**/*.integration.test.ts'],
    // Four process-heavy suites exhausted the shared cluster's checkpoint/host budget.
    // Two suites remain parallel; concurrency/serialization within each test is unchanged.
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
