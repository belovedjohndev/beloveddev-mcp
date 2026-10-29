import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from 'vitest/node';
import integration from './vitest.integration.config.js';
import { aggregateAgentReports } from './packages/mcp/test/agent-evaluation.js';

const reporter: Reporter = {
  onTestRunEnd(
    modules: readonly TestModule[],
    errors: readonly SerializedError[],
    reason: TestRunEndReason,
  ) {
    const outcomes = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => ({
        name: test.name,
        state: test.result().state,
        report: test.meta().agentEvaluation,
      })),
    );
    const report = aggregateAgentReports(
      outcomes,
      reason !== 'passed' || errors.length > 0 || modules.some((module) => !module.ok()),
    );
    if (report.status !== 'passed') process.exitCode = 1;
    try {
      mkdirSync(fileURLToPath(new URL('./.evaluation-reports/', import.meta.url)), {
        recursive: true,
        mode: 0o700,
      });
      const name = 'agent-run-' + randomUUID() + '.json';
      writeFileSync(
        new URL('./.evaluation-reports/' + name, import.meta.url),
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      process.stdout.write(JSON.stringify(report) + '\n');
      process.stderr.write('Offline agent report: .evaluation-reports/' + name + '\n');
    } catch {
      process.exitCode = 1;
      process.stderr.write('Offline agent report publication failed.\n');
    }
  },
};
export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: ['packages/mcp/test/agent-evaluation.integration.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    reporters: [reporter],
    onConsoleLog: () => false,
  },
});
