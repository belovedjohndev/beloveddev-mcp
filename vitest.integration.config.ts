import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
