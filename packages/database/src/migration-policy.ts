import type { ClientConfig } from 'pg';
import { databaseConnectionConfig } from './connection-policy.js';

export class MigrationConfigurationError extends Error {
  constructor() {
    super('Administrative migration configuration is invalid.');
    this.name = 'MigrationConfigurationError';
  }
}

export const MIGRATION_TIMEOUT_DEFAULTS = Object.freeze({
  connectMs: 5_000,
  advisoryLockMs: 10_000,
  lockMs: 5_000,
  statementMs: 120_000,
  operationMs: 300_000,
});

export type MigrationTimeouts = Readonly<Record<keyof typeof MIGRATION_TIMEOUT_DEFAULTS, number>>;
export type MigrationConfiguration = Readonly<{
  connection: ClientConfig;
  timeouts: MigrationTimeouts;
}>;

/** Separate from runtime parsing: no DATABASE_URL, TEST_DATABASE_URL, or CA fallback. */
export function parseMigrationEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): MigrationConfiguration {
  try {
    const url = input['DATABASE_MIGRATION_URL'];
    const ca = input['DATABASE_MIGRATION_TLS_CA'];
    if (url === undefined || (ca !== undefined && (ca.length === 0 || ca.length > 65_536)))
      throw new MigrationConfigurationError();
    const timeout = (name: string, fallback: number): number => {
      const value = input[name];
      if (value === undefined) return fallback;
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 3_600_000)
        throw new MigrationConfigurationError();
      return Number(value);
    };
    const timeouts: MigrationTimeouts = Object.freeze({
      connectMs: timeout('DATABASE_MIGRATION_CONNECT_TIMEOUT_MS', 5_000),
      advisoryLockMs: timeout('DATABASE_MIGRATION_ADVISORY_LOCK_TIMEOUT_MS', 10_000),
      lockMs: timeout('DATABASE_MIGRATION_LOCK_TIMEOUT_MS', 5_000),
      statementMs: timeout('DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS', 120_000),
      operationMs: timeout('DATABASE_MIGRATION_OPERATION_TIMEOUT_MS', 300_000),
    });
    return Object.freeze({
      timeouts,
      connection: Object.freeze({
        ...databaseConnectionConfig(url, ca),
        application_name: 'beloveddev-migrate',
        sslnegotiation: 'postgres',
        client_encoding: 'UTF8',
        connectionTimeoutMillis: timeouts.connectMs,
        statement_timeout: timeouts.statementMs,
        lock_timeout: timeouts.lockMs,
        idle_in_transaction_session_timeout: timeouts.statementMs,
        // Explicit startup options override role/database defaults and PGOPTIONS.
        options: `-c search_path=public -c transaction_timeout=${timeouts.operationMs}`,
        pipeline: false,
      }),
    });
  } catch {
    throw new MigrationConfigurationError();
  }
}
