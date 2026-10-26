import { describe, expect, it } from 'vitest';
import { parseRecoveryEnvironment, RecoveryError } from '../src/recovery-policy.js';

const url = 'postgresql://admin:private-secret@127.0.0.1/source';
describe('explicit recovery policy', () => {
  it.each(['backup', 'restore'] as const)(
    'rejects runtime, test, or migration fallback for %s',
    (purpose) => {
      expect(() =>
        parseRecoveryEnvironment(
          { DATABASE_URL: url, TEST_DATABASE_URL: url, DATABASE_MIGRATION_URL: url },
          purpose,
        ),
      ).toThrow(RecoveryError);
    },
  );
  it('keeps source and control endpoints separate', () => {
    const env = {
      DATABASE_BACKUP_URL: url,
      DATABASE_RESTORE_ADMIN_URL: url.replace('/source', '/control'),
    };
    expect(parseRecoveryEnvironment(env, 'backup').database).toBe('source');
    expect(parseRecoveryEnvironment(env, 'restore').database).toBe('control');
  });
  it.each(['backup', 'restore'] as const)(
    'keeps the default idle transaction timeout above the recovery deadline for %s',
    (purpose) => {
      const config = parseRecoveryEnvironment(
        { DATABASE_BACKUP_URL: url, DATABASE_RESTORE_ADMIN_URL: url },
        purpose,
      );
      expect(config.timeoutMs).toBe(300_000);
      expect(config.connection.idle_in_transaction_session_timeout).toBe(330_000);
      expect(config.connection).toMatchObject({
        connectionTimeoutMillis: 5_000,
        statement_timeout: 120_000,
        lock_timeout: 5_000,
      });
    },
  );
  it.each(['backup', 'restore'] as const)(
    'keeps the maximum idle transaction timeout above the recovery deadline for %s',
    (purpose) => {
      const config = parseRecoveryEnvironment(
        {
          DATABASE_BACKUP_URL: url,
          DATABASE_RESTORE_ADMIN_URL: url,
          DATABASE_RECOVERY_TIMEOUT_MS: '3600000',
        },
        purpose,
      );
      expect(config.timeoutMs).toBe(3_600_000);
      expect(config.connection.idle_in_transaction_session_timeout).toBe(3_630_000);
      expect(config.connection).toMatchObject({
        connectionTimeoutMillis: 5_000,
        statement_timeout: 120_000,
        lock_timeout: 5_000,
      });
    },
  );
  it.each(['0', '-1', '', '1e3', '1.5', ' 10', '3600001', 'Infinity'])(
    'rejects invalid overall deadline: %s',
    (value) => {
      expect(() =>
        parseRecoveryEnvironment(
          { DATABASE_BACKUP_URL: url, DATABASE_RECOVERY_TIMEOUT_MS: value },
          'backup',
        ),
      ).toThrow('Database recovery operation was not verified.');
    },
  );
  it.each([
    'postgresql://admin:secret@remote.example/source',
    `${url}?sslmode=require`,
    `${url}?host=other`,
    `${url}?options=-crole=other`,
    `${url}?sslmode=verify-full&sslmode=disable`,
    'postgresql://admin:line%0Abreak@localhost/source',
  ])('rejects unsafe libpq/transport configuration: %#', (value) => {
    expect(() => parseRecoveryEnvironment({ DATABASE_BACKUP_URL: value }, 'backup')).toThrow(
      RecoveryError,
    );
  });
  it('requires dedicated CA settings and full certificate verification', () => {
    const config = parseRecoveryEnvironment(
      {
        DATABASE_BACKUP_URL: url.replace('127.0.0.1', 'remote.example') + '?sslmode=verify-full',
        DATABASE_BACKUP_TLS_CA: 'ca',
      },
      'backup',
    );
    expect(config.connection.ssl).toEqual({
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ca: 'ca',
    });
    expect(() =>
      parseRecoveryEnvironment(
        { DATABASE_BACKUP_URL: url, DATABASE_BACKUP_TLS_CA: 'ca' },
        'backup',
      ),
    ).toThrow(RecoveryError);
    expect(
      parseRecoveryEnvironment({ DATABASE_BACKUP_URL: url, DATABASE_TLS_CA: 'ignored' }, 'backup')
        .ca,
    ).toBeUndefined();
  });
  it('rejects relative executable directories', () => {
    expect(() =>
      parseRecoveryEnvironment(
        { DATABASE_BACKUP_URL: url, DATABASE_RECOVERY_PG_BIN: './tools' },
        'backup',
      ),
    ).toThrow(RecoveryError);
  });
});
