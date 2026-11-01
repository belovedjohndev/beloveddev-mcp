import { describe, expect, it } from 'vitest';
import {
  databaseConnectionConfig,
  DatabasePolicyError,
} from '../../database/src/connection-policy.js';
import { parseMcpEnvironment } from '@beloveddev/infrastructure/environment';
import { withTestResourceCleanup } from '../src/test-database.js';
import {
  invalidTransportUrl,
  SmokeFailure,
  smokeFailureCodes,
  SmokeObservation,
} from '../src/container-smoke-observation.js';

const startup =
  JSON.stringify({
    event: 'mcp.startup_failed',
    category: 'TRANSPORT_POLICY',
    msg: 'safe startup failure',
  }) + '\n';
function observation(stderr = startup, exitCode: number | null = 1) {
  const value = new SmokeObservation(() => 25);
  value.spawned = true;
  value.stderrChunk(stderr);
  value.exited = true;
  value.exitCode = exitCode;
  return value;
}
function check(value: SmokeObservation) {
  value.expectStartupFailure('mcp.startup_failed', 'TRANSPORT_POLICY', []);
}

describe('container smoke startup observations', () => {
  it('retains exact policy rejection assertions and bounded lifecycle evidence', () => {
    const value = observation();
    expect(() => check(value)).not.toThrow();
    expect(value.snapshot()).toMatchObject({
      spawned: true,
      exited: true,
      exitCode: 1,
      stdoutLines: 0,
      events: [{ event: 'mcp.startup_failed', category: 'TRANSPORT_POLICY', afterMs: 0 }],
    });
  });
  it.each([0, 125, null])('distinguishes wrong child exit code (%s)', (code) => {
    expect(() => check(observation(startup, code))).toThrow('wrong_exit_code');
  });
  it('distinguishes missing startup event from wrong category', () => {
    expect(() => check(observation(''))).toThrow('missing_startup_event');
    expect(() => check(observation(startup.replace('TRANSPORT_POLICY', 'CONNECTION')))).toThrow(
      'wrong_failure_category',
    );
  });
  it('rejects readiness even when all other rejection assertions pass', () => {
    expect(() => check(observation(startup + '{"event":"mcp.ready"}\n'))).toThrow(
      'unexpected_ready',
    );
  });
  it.each([true, false])(
    'rejects any protocol stdout during a negative startup (%s)',
    (invalid) => {
      const value = observation();
      value.stdoutLines = 1;
      value.invalidStdout = invalid;
      expect(() => check(value)).toThrow('unexpected_protocol_stdout');
    },
  );
  it.each([
    'Docker warning: private-password\n',
    '{bad-json}\n',
    '[]\n',
    '{"event":"private-password"}\n',
    '{"event":"mcp.startup_failed","category":"private-password"}\n',
  ])('fails closed for malformed or unapproved stderr: %#', (stderr) => {
    const value = observation(stderr);
    expect(() => check(value)).toThrow('invalid_stderr_event');
    expect(JSON.stringify(value.snapshot())).not.toContain('private-password');
  });
  it('bounds stderr and lifecycle records without disclosing raw payloads', () => {
    const value = observation();
    for (let i = 0; i < 100; i++) value.stderrChunk(startup);
    expect(value.snapshot().events).toHaveLength(16);
    value.stderrChunk('sensitive'.repeat(200_000));
    expect(() => check(value)).toThrow('stderr_limit');
    expect(JSON.stringify(value.snapshot())).not.toContain('sensitive');
  });
  it('rejects leaked runtime secrets without including them in exceptions or diagnostics', () => {
    const secret = 'postgresql://user:private-password@localhost/database';
    const value = observation(
      JSON.stringify({ event: 'mcp.startup_failed', category: 'TRANSPORT_POLICY', msg: secret }) +
        '\n',
    );
    let failure: unknown;
    try {
      value.records([secret]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SmokeFailure);
    expect(smokeFailureCodes(failure)).toEqual(['secret_in_stderr']);
    expect(JSON.stringify(value.snapshot()) + String(failure)).not.toContain(secret);
  });
  it('never projects raw errors, arbitrary codes, environment, or Docker arguments', () => {
    expect(
      smokeFailureCodes(Object.assign(new Error('private-password'), { code: 'private-password' })),
    ).toEqual(['assertion_failure']);
    for (const code of [
      'child_startup_failure',
      'child_exit_timeout',
      'docker_command_failure',
      'cleanup_failure',
    ] as const)
      expect(smokeFailureCodes(new SmokeFailure(code))).toEqual([code]);
  });
  it('preserves a startup failure independently of a failing cleanup', async () => {
    const calls: string[] = [];
    let failure: unknown;
    try {
      await withTestResourceCleanup(() => {
        throw new SmokeFailure('invalid_stderr_event');
      }, [
        {
          stage: 'container',
          run: () => {
            calls.push('container');
            throw new SmokeFailure('cleanup_failure');
          },
        },
        {
          stage: 'input',
          run: () => {
            calls.push('input');
          },
        },
      ]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(calls).toEqual(['container', 'input']);
    expect(smokeFailureCodes(failure)).toEqual(['invalid_stderr_event', 'cleanup_failure']);
    expect(failure).toBeInstanceOf(AggregateError);
  });
});

describe('intentionally invalid smoke transport configuration', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'changes only URL components for %s and fails before connection',
    (hostname) => {
      const original = `postgresql://localhost:verify-full-localhost@${hostname}:5432/localhost?application_name=verify-full&sslmode=verify-full`;
      const valid = databaseConnectionConfig(original, 'synthetic-ca');
      expect(valid.ssl).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      const invalid = invalidTransportUrl(original);
      const parsed = new URL(invalid);
      expect(parsed.hostname).toBe('db.invalid');
      expect(parsed.searchParams.get('sslmode')).toBe('disable');
      expect(parsed.username).toBe('localhost');
      expect(parsed.password).toBe('verify-full-localhost');
      expect(parsed.pathname).toBe('/localhost');
      expect(parsed.searchParams.get('application_name')).toBe('verify-full');
      const environment = parseMcpEnvironment({
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        MCP_AUTH_MODE: 'local',
        MCP_CURSOR_SECRET: 'synthetic-cursor-secret-32-characters',
        DATABASE_URL: invalid,
        DATABASE_TLS_CA: 'synthetic-ca',
      });
      expect(() =>
        databaseConnectionConfig(environment.DATABASE_URL, environment.DATABASE_TLS_CA),
      ).toThrow(DatabasePolicyError);
      expect(() => databaseConnectionConfig(invalid, 'synthetic-ca')).toThrow(
        'The database connection policy is invalid.',
      );
    },
  );
});

it('preserves nested primary and cleanup codes with bounded aggregate traversal', () => {
  const primary = new SmokeFailure('child_exit_timeout');
  const cleanup = new SmokeFailure('cleanup_failure');
  expect(
    smokeFailureCodes(new AggregateError([new AggregateError([primary, cleanup]), cleanup])),
  ).toEqual(['child_exit_timeout', 'cleanup_failure', 'cleanup_failure']);
  const cyclic = new AggregateError([]);
  cyclic.errors.push(cyclic);
  expect(smokeFailureCodes(cyclic)).toEqual(['assertion_failure']);
});
