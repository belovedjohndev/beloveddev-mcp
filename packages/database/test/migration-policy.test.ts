import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  parseMigrationEnvironment,
  MigrationConfigurationError,
  MIGRATION_TIMEOUT_DEFAULTS,
} from '../src/migration-policy.js';
import { migrateDatabase } from '../src/migrate.js';

const url = 'postgresql://admin:private-secret@localhost/example';

afterEach(() => vi.unstubAllEnvs());

describe('administrative migration policy', () => {
  it.each([{}, { DATABASE_URL: url }, { TEST_DATABASE_URL: url }, { DATABASE_MIGRATION_URL: '' }])(
    'requires explicit administrative configuration: %#',
    (input) => {
      expect(() => parseMigrationEnvironment(input)).toThrow(MigrationConfigurationError);
    },
  );

  it('uses administrative bounds independently of runtime settings', () => {
    const config = parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url });
    expect(config.timeouts).toEqual(MIGRATION_TIMEOUT_DEFAULTS);
    expect(config.connection).toMatchObject({
      host: '127.0.0.1',
      user: 'admin',
      database: 'example',
      port: 5432,
      ssl: false,
      statement_timeout: 120_000,
      lock_timeout: 5_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'beloveddev-migrate',
      sslnegotiation: 'postgres',
      pipeline: false,
    });
    expect(config.connection).not.toHaveProperty('connectionString');
  });

  it.each(['CONNECT', 'ADVISORY_LOCK', 'LOCK', 'STATEMENT', 'OPERATION'])(
    'validates positive bounded integer %s timeout',
    (kind) => {
      const name = `DATABASE_MIGRATION_${kind}_TIMEOUT_MS`;
      for (const value of ['0', '-1', '1.5', '', 'NaN', 'Infinity', ' 10', '1e3', '3600001']) {
        expect(() =>
          parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url, [name]: value }),
        ).toThrow(MigrationConfigurationError);
      }
      expect(() =>
        parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url, [name]: '1500' }),
      ).not.toThrow();
    },
  );

  it.each([
    'postgresql://admin:private-secret@remote.example/app',
    `${url}?sslmode=require`,
    `${url}?sslmode=verify-full&sslmode=disable`,
    `${url}?host=other`,
    `${url}?options=-crole=other`,
    `${url}?user=other`,
    `${url}?sslrootcert=path`,
    `${url}?application_name=a&application_name=b`,
    'postgresql://admin@localhost/example',
    `${url}#fragment`,
  ])('rejects ambiguous endpoint or transport without disclosing input: %#', (value) => {
    expect(() => parseMigrationEnvironment({ DATABASE_MIGRATION_URL: value })).toThrow(
      'Administrative migration configuration is invalid.',
    );
  });

  it('keeps certificate verification and private CA explicit', () => {
    expect(
      parseMigrationEnvironment({
        DATABASE_MIGRATION_URL: 'postgresql://admin:secret@remote.example/app?sslmode=verify-full',
        DATABASE_MIGRATION_TLS_CA: 'private-ca',
      }).connection.ssl,
    ).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: 'private-ca' });
    expect(() =>
      parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url, DATABASE_MIGRATION_TLS_CA: 'ca' }),
    ).toThrow(MigrationConfigurationError);
    expect(() =>
      parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url, DATABASE_MIGRATION_TLS_CA: '' }),
    ).toThrow(MigrationConfigurationError);
    expect(
      parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url, DATABASE_TLS_CA: 'runtime-ca' })
        .connection.ssl,
    ).toBe(false);
  });

  it('overrides ambient pg endpoint, identity, TLS, and session policy', () => {
    for (const name of [
      'PGHOST',
      'PGPORT',
      'PGUSER',
      'PGPASSWORD',
      'PGDATABASE',
      'PGOPTIONS',
      'PGSSLMODE',
      'PGSSLNEGOTIATION',
      'PGAPPNAME',
    ]) {
      vi.stubEnv(name, 'untrusted');
    }
    expect(parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url }).connection).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      user: 'admin',
      password: 'private-secret',
      database: 'example',
      ssl: false,
      sslnegotiation: 'postgres',
      options: '-c search_path=public -c transaction_timeout=300000',
    });
  });

  it('does not connect when already interrupted', async () => {
    await expect(
      migrateDatabase(parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url }), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ category: 'INTERRUPTED' });
  });
});
