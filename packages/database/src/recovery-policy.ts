import { isAbsolute } from 'node:path';
import { databaseConnectionConfig } from './connection-policy.js';

// Keep the idle snapshot transaction alive through the overall deadline and
// bounded abort/connection cleanup (five-second grace), with scheduling headroom.
const IDLE_TRANSACTION_CLEANUP_MARGIN_MS = 30_000;

export type RecoveryCategory =
  | 'CONFIGURATION'
  | 'CLIENT_VERSION'
  | 'PROCESS'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'ARTIFACT'
  | 'EXISTS'
  | 'CONNECTION'
  | 'SCHEMA'
  | 'LEDGER'
  | 'DATA'
  | 'RESTORE'
  | 'READINESS'
  | 'CLEANUP';

export class RecoveryError extends Error {
  constructor(readonly category: RecoveryCategory) {
    super('Database recovery operation was not verified.');
    this.name = 'RecoveryError';
  }
}

export function parseRecoveryEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  purpose: 'backup' | 'restore',
) {
  try {
    const url = input[purpose === 'backup' ? 'DATABASE_BACKUP_URL' : 'DATABASE_RESTORE_ADMIN_URL'];
    const ca = input[purpose === 'backup' ? 'DATABASE_BACKUP_TLS_CA' : 'DATABASE_RESTORE_TLS_CA'];
    const binaryDirectory = input['DATABASE_RECOVERY_PG_BIN'];
    const rawTimeout = input['DATABASE_RECOVERY_TIMEOUT_MS'] ?? '300000';
    if (
      !url ||
      (ca !== undefined && (ca.length === 0 || ca.length > 65_536)) ||
      (binaryDirectory !== undefined && !isAbsolute(binaryDirectory)) ||
      !/^[1-9][0-9]*$/.test(rawTimeout) ||
      Number(rawTimeout) > 3_600_000
    )
      throw new RecoveryError('CONFIGURATION');
    const timeoutMs = Number(rawTimeout);
    const connection = databaseConnectionConfig(url, ca);
    const { host, port, user, password, database, ssl } = connection;
    if (
      typeof host !== 'string' ||
      typeof port !== 'number' ||
      typeof user !== 'string' ||
      typeof password !== 'string' ||
      typeof database !== 'string' ||
      [host, user, password, database].some((value) => /[\r\n]/.test(value))
    )
      throw new RecoveryError('CONFIGURATION');
    return Object.freeze({
      host,
      port,
      user,
      password,
      database,
      tls: ssl !== false,
      ca,
      binaryDirectory,
      timeoutMs,
      connection: Object.freeze({
        ...connection,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 120_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: timeoutMs + IDLE_TRANSACTION_CLEANUP_MARGIN_MS,
        application_name: 'beloveddev-recovery',
        sslnegotiation: 'postgres' as const,
        options: '-c search_path=public -c timezone=UTC -c datestyle=ISO,YMD',
      }),
    });
  } catch {
    throw new RecoveryError('CONFIGURATION');
  }
}

export type RecoveryConfiguration = ReturnType<typeof parseRecoveryEnvironment>;

export function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new RecoveryError(
      signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
        ? 'TIMEOUT'
        : 'INTERRUPTED',
    );
}
