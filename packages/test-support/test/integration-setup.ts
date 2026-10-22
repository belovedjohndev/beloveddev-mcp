import { afterAll, beforeEach, onTestFinished } from 'vitest';
import {
  finishPendingTestDatabases,
  closeTestDatabaseFixtures,
} from '@beloveddev/test-support/test-database';

beforeEach(() => {
  // Runs after the test's own afterEach hooks (including subprocess termination).
  onTestFinished(finishPendingTestDatabases);
});

afterAll(closeTestDatabaseFixtures);
