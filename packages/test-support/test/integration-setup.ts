import { afterAll, beforeEach, onTestFinished, expect } from 'vitest';
import { relative, sep } from 'node:path';
import {
  finishPendingTestDatabases,
  closeTestDatabaseFixtures,
  withTestResourceCleanup,
} from '@beloveddev/test-support/test-database';

beforeEach(() => {
  // Runs after the test's own afterEach hooks (including subprocess termination).
  onTestFinished(finishPendingTestDatabases);
});

function suiteObservation(event: 'start' | 'end') {
  if (process.env['BELOVEDDEV_TEST_DIAGNOSTICS'] !== '1') return;
  const file = relative(process.cwd(), expect.getState().testPath ?? '')
    .split(sep)
    .join('/');
  process.stderr.write(
    'TEST_SUITE_DIAGNOSTIC ' +
      JSON.stringify({
        schemaVersion: 1,
        event,
        file: /^packages\/[a-zA-Z0-9/_.-]+\.integration\.test\.ts$/.test(file) ? file : 'redacted',
        atMs: performance.timeOrigin + performance.now(),
        workerPid: process.pid,
      }) +
      '\n',
  );
}
suiteObservation('start');
afterAll(async () => {
  await withTestResourceCleanup(closeTestDatabaseFixtures, [
    { stage: 'suite_observation', run: () => suiteObservation('end') },
  ]);
});
