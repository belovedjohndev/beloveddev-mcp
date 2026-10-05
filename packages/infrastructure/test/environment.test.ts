import { describe, expect, it } from 'vitest';
import {
  EnvironmentValidationError,
  parseEnvironment,
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
