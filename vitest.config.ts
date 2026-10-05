import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Process tests allow cold Node startup on Windows and slower CI runners.
    testTimeout: 20_000,
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
