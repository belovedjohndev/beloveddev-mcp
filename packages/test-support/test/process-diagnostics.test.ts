import { cleanupTestResources } from '../src/test-database.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessDiagnostics, probeOptions } from './process-diagnostics.js';
const owned: ProcessDiagnostics[] = [];
function observe(...args: ConstructorParameters<typeof ProcessDiagnostics>) {
  const recorder = new ProcessDiagnostics(...args);
  owned.push(recorder);
  return recorder;
}
afterEach(async () => {
  await cleanupTestResources([
    ...owned
      .splice(0)
      .map((recorder) => ({ stage: 'diagnostic_timer', run: () => recorder.publish() })),
    {
      stage: 'environment',
      run: () => {
        vi.unstubAllEnvs();
      },
    },
  ]);
});
it('leaves launch configuration untouched unless explicitly enabled', () => {
  vi.stubEnv('BELOVEDDEV_TEST_DIAGNOSTICS', undefined);
  const env = { PRIVATE: 'sensitive' };
  expect(probeOptions(env)).toEqual({ env, ipc: false });
  const write = vi.fn();
  const recorder = observe('safe test', false, () => 0, write);
  recorder.mark('spawn_called');
  recorder.publish();
  expect(write).not.toHaveBeenCalled();
});
it('records only validated timing fields and never raw stderr, credentials or invalid IPC payloads', () => {
  let time = 0;
  const lines: string[] = [];
  const recorder = observe(
    'safe test',
    true,
    () => time,
    (line) => {
      lines.push(line);
    },
  );
  recorder.mark('spawn_called');
  time = 10;
  recorder.message({
    kind: 'beloveddev-test-timing',
    phase: 'bootstrap',
    childUptimeMs: 5,
    sentAtMs: performance.timeOrigin + 10,
  });
  recorder.message({
    kind: 'beloveddev-test-timing',
    phase: 'bootstrap',
    childUptimeMs: 5,
    sentAtMs: 0,
    secret: 'PRIVATE_KEY',
  });
  recorder.stderr(
    'postgresql://admin:PRIVATE_KEY@host/db\n{"event":"mcp.ready","secret":"PRIVATE_KEY"}\n',
  );
  recorder.mark('response_timeout');
  recorder.publish();
  recorder.publish();
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toMatch(/PRIVATE_KEY|postgresql|admin/);
  expect(recorder.snapshot()).toMatchObject({
    classification: 'mcp_response_timeout_after_readiness',
    rejectedMessages: 1,
  });
});
it('bounds the number of timing records and redacts unsafe test labels', () => {
  const recorder = observe(
    'postgresql://private',
    true,
    () => 0,
    () => {},
  );
  for (let i = 0; i < 1000; i++) recorder.mark('response');
  recorder.mark('cleanup_timeout');
  recorder.publish();
  expect(recorder.snapshot()).toMatchObject({
    classification: 'cleanup_timeout',
    testName: 'redacted_test_name',
    truncated: true,
  });
  expect(recorder.snapshot().points).toHaveLength(128);
});
it.each([
  [['response_timeout'], 'startup_unobserved'],
  [['bootstrap', 'response_timeout'], 'connection_or_module_startup_unconfirmed'],
  [['tcp_connected', 'response_timeout'], 'startup_or_database_readiness_unconfirmed'],
  [['watchdog'], 'migration_subprocess_timeout'],
  [['cleanup_timeout'], 'cleanup_timeout'],
  [['spawn_error'], 'process_spawn_failure'],
  [['runtime_startup_failed', 'response_timeout'], 'reported_startup_failure'],
  [['database_pool_error', 'response_timeout'], 'reported_database_pool_failure'],
] as const)(
  'distinguishes observed phases without inventing a root cause: %s',
  (phases, classification) => {
    const recorder = observe(
      'safe test',
      true,
      () => 0,
      () => {},
    );
    for (const phase of phases) recorder.mark(phase);
    recorder.publish();
    expect(recorder.snapshot().classification).toBe(classification);
  },
);

it('classifies protocol errors without retaining messages and distinguishes readiness observation', () => {
  const recorder = observe(
    'safe protocol',
    true,
    () => 20,
    () => {},
  );
  recorder.response('server/discover', { code: -32603, message: 'Internal server error' });
  expect(recorder.snapshot().classification).toBe('reported_protocol_internal_error');
  recorder.stderr('{"event":"mcp.ready","secret":"PRIVATE_KEY"}\n');
  recorder.response('initialize', { code: -32602, message: 'PRIVATE_KEY postgresql://private' });
  recorder.stderr('{"event":"mcp.protocol_error","message":"PRIVATE_KEY"}\n');
  recorder.stderr(
    '{"event":"mcp.startup_failed","category":"CONNECTION","password":"PRIVATE_KEY"}\n',
  );
  recorder.exit(1, null);
  const snapshot = recorder.snapshot();
  expect(snapshot.rpcErrors).toEqual([
    {
      method: 'server/discover',
      code: -32603,
      messageClass: 'internal_server_error',
      readinessObserved: false,
      afterMs: 0,
    },
    {
      method: 'initialize',
      code: -32602,
      messageClass: 'other_redacted',
      readinessObserved: true,
      afterMs: 0,
    },
  ]);
  expect(snapshot.lifecycleEvents).toEqual([
    { event: 'mcp.ready', afterMs: 0 },
    { event: 'mcp.protocol_error', afterMs: 0 },
    { event: 'mcp.startup_failed', category: 'CONNECTION', afterMs: 0 },
  ]);
  expect(snapshot.exitStatus).toEqual({ code: 1, signal: null });
  expect(snapshot.classification).toBe('reported_startup_failure');
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_KEY|postgresql|password/);
});
it('bounds protocol and lifecycle observations and rejects malformed error records', () => {
  const recorder = observe(
    'safe protocol bounds',
    true,
    () => 0,
    () => {},
  );
  recorder.response('server/discover', { code: -32603, message: 'unsafe', extra: 'private' });
  for (let index = 0; index < 100; index++) {
    recorder.response('untrusted method', { code: -32603, message: 'private' });
    recorder.stderr('{"event":"mcp.protocol_error"}\n');
  }
  expect(recorder.snapshot()).toMatchObject({ rejectedMessages: 1, truncated: true });
  expect(recorder.snapshot().rpcErrors).toHaveLength(16);
  expect(recorder.snapshot().lifecycleEvents).toHaveLength(64);
  expect(recorder.snapshot().rpcErrors.every(({ method }) => method === 'other')).toBe(true);
});
