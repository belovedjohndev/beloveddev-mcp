import { describe, expect, it } from 'vitest';
import {
  EnvironmentValidationError,
  parseEnvironment,
  parseMcpEnvironment,
  parseTestDatabaseUrl,
} from '../src/environment.js';

const databaseUrl = 'postgresql://user:private-password@localhost:5432/beloveddev';

describe('environment validation', () => {
  it('applies defaults, freezes configuration, and discards unrelated environment variables', () => {
    const input = { DATABASE_URL: databaseUrl, UNRELATED_SECRET: 'private-value' };
    const result = parseEnvironment(input);
    expect(result).toEqual({
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(input.UNRELATED_SECRET).toBe('private-value');
  });

  it('accepts explicit settings and the postgres protocol', () => {
    expect(
      parseEnvironment({
        DATABASE_URL: 'postgres://user:password@localhost/beloveddev?sslmode=require',
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      }),
    ).toMatchObject({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
  });

  it.each([
    undefined,
    '',
    'not-a-url',
    'https://localhost/beloveddev',
    'postgresql:///beloveddev',
    'postgresql://localhost',
    'postgresql://localhost/',
    'postgresql://localhost/beloveddev#fragment',
    ' postgresql://localhost/beloveddev',
  ])('rejects a missing or invalid database URL: %s', (DATABASE_URL) => {
    expect(() => parseEnvironment({ DATABASE_URL })).toThrow(EnvironmentValidationError);
  });

  it('reports only field names, never input values or raw Zod errors', () => {
    try {
      parseEnvironment({
        DATABASE_URL: 'https://user:private-password@localhost/beloveddev',
        LOG_LEVEL: 'private-log-value',
        NODE_ENV: 'private-env-value',
      });
      expect.fail('Expected environment validation to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      if (!(error instanceof EnvironmentValidationError)) throw error;
      expect(error.fields).toEqual(['DATABASE_URL', 'LOG_LEVEL', 'NODE_ENV']);
      expect(error.message).toBe(
        'Invalid environment variables: DATABASE_URL, LOG_LEVEL, NODE_ENV',
      );
      expect(JSON.stringify(error)).not.toContain('private-');
      expect(error.cause).toBeUndefined();
    }
  });

  it.each(['NODE_ENV', 'LOG_LEVEL'])('rejects an empty %s instead of applying a default', (key) => {
    expect(() => parseEnvironment({ DATABASE_URL: databaseUrl, [key]: '' })).toThrow(
      EnvironmentValidationError,
    );
  });
});

describe('integration database configuration', () => {
  it('requires an explicit TEST_DATABASE_URL and never falls back to application settings', () => {
    expect(() => parseTestDatabaseUrl({ DATABASE_URL: databaseUrl })).toThrow('TEST_DATABASE_URL');
  });
  it('accepts a configured nondefault host port', () => {
    const url = 'postgresql://user:password@localhost:32123/test_admin';
    expect(parseTestDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });
  it('discards invalid test configuration values from errors', () => {
    expect(() => parseTestDatabaseUrl({ TEST_DATABASE_URL: 'invalid-private-secret' })).toThrow(
      'Invalid environment variables: TEST_DATABASE_URL',
    );
  });
});

describe('MCP environment validation', () => {
  const valid = {
    DATABASE_URL: databaseUrl,
    MCP_AUTH_MODE: 'local',
    MCP_CURSOR_SECRET: 'private-cursor-key-at-least-32-characters',
  };
  it.each([32, 1024])('accepts the schema secret length boundary %s', (length) => {
    const result = parseMcpEnvironment({ ...valid, MCP_CURSOR_SECRET: 'x'.repeat(length) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.MCP_LOCAL_TENANT_ID).toBeUndefined();
    expect(result.MCP_LOCAL_USER_ID).toBeUndefined();
  });
  it.each([
    { MCP_AUTH_MODE: undefined },
    { MCP_AUTH_MODE: '' },
    { MCP_AUTH_MODE: 'remote' },
    { MCP_CURSOR_SECRET: undefined },
    { MCP_CURSOR_SECRET: '' },
    { MCP_CURSOR_SECRET: 'x'.repeat(31) },
    { MCP_CURSOR_SECRET: 'x'.repeat(1025) },
    { MCP_LOCAL_TENANT_ID: 'invalid', MCP_LOCAL_USER_ID: 'invalid' },
    { MCP_LOCAL_TENANT_ID: '00000000-0000-4000-8000-000000000001' },
    { MCP_LOCAL_USER_ID: '00000000-0000-4000-8000-000000000002' },
    { NODE_ENV: 'production' },
  ])('rejects unsupported or incomplete MCP settings without retaining values', (overrides) => {
    try {
      parseMcpEnvironment({ ...valid, ...overrides });
      expect.fail('Expected invalid configuration');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(JSON.stringify(error)).not.toContain('private-');
      if (!(error instanceof EnvironmentValidationError)) throw error;
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain(valid.MCP_CURSOR_SECRET);
    }
  });
  it('accepts both operator-supplied identity fields together', () => {
    const identity = {
      MCP_LOCAL_TENANT_ID: '00000000-0000-4000-8000-000000000001',
      MCP_LOCAL_USER_ID: '00000000-0000-4000-8000-000000000002',
    };
    expect(parseMcpEnvironment({ ...valid, ...identity })).toMatchObject(identity);
  });
});
