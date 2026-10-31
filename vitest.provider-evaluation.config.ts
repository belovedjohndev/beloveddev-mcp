import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from 'vitest/node';
import { providerControlReport } from './packages/mcp/test/provider-evaluation-report.js';

const reporter: Reporter = {
  onTestRunEnd(
    modules: readonly TestModule[],
    errors: readonly SerializedError[],
    reason: TestRunEndReason,
  ) {
    const states = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => test.result().state),
    );
    const measurements = modules.flatMap((module) =>
      [...module.children.allTests()].flatMap((test) =>
        test.meta().liveReadinessEstimate ? [test.meta().liveReadinessEstimate] : [],
      ),
    );
    const report = providerControlReport(
      states,
      reason !== 'passed' || errors.length > 0 || modules.some((module) => !module.ok()),
      measurements,
    );
    if (
      ('offlineControlsStatus' in report ? report.offlineControlsStatus : report.status) !==
      'passed'
    )
      process.exitCode = 1;
    try {
      mkdirSync(fileURLToPath(new URL('./.evaluation-reports/', import.meta.url)), {
        recursive: true,
        mode: 0o700,
      });
      const name = 'provider-controls-' + randomUUID() + '.json';
      writeFileSync(
        new URL('./.evaluation-reports/' + name, import.meta.url),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      process.stdout.write(JSON.stringify(report) + '\n');
      process.stderr.write(
        'Offline provider readiness controls: .evaluation-reports/' + name + '\n',
      );
    } catch {
      process.exitCode = 1;
      process.stderr.write('Offline provider readiness report publication failed.\n');
    }
  },
};
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/mcp/test/openai-provider.test.ts',
      'packages/mcp/test/provider-live-readiness.test.ts',
      'packages/mcp/test/approved-test-cluster.test.ts',
      'packages/mcp/test/provider-schema-compatibility.test.ts',
    ],
    testTimeout: 20000,
    clearMocks: true,
    restoreMocks: true,
    maxWorkers: 1,
    retry: 0,
    reporters: [reporter],
    onConsoleLog: () => false,
  },
});
