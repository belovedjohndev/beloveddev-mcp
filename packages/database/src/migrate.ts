import { fileURLToPath } from 'node:url';
import { Socket } from 'node:net';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import type { MigrationConfiguration } from './migration-policy.js';
export { parseMigrationEnvironment, MigrationConfigurationError } from './migration-policy.js';

// PostgreSQL session advisory locks are scoped to the current database.
export const MIGRATION_LOCK = Object.freeze([0x42444556, 1] as const);
export const MIGRATION_CLEANUP_TIMEOUT_MS = 5_000;

type MigrationFailure =
  | 'CONNECTION'
  | 'IDENTITY'
  | 'MIGRATION_FILES'
  | 'LEDGER'
  | 'ADVISORY_LOCK_TIMEOUT'
  | 'LOCK_TIMEOUT'
  | 'STATEMENT_TIMEOUT'
  | 'SQL_FAILURE'
  | 'INTERRUPTED'
  | 'OPERATION_TIMEOUT'
  | 'CLEANUP';

export class MigrationError extends Error {
  constructor(readonly category: MigrationFailure) {
    super('Administrative migration success was not established.');
    this.name = 'MigrationError';
  }
}

function sqlState(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return undefined;
  if ('code' in error) return error.code;
  return 'cause' in error ? sqlState(error.cause) : undefined;
}

async function verifyLedger(client: Client, expected: MigrationMeta[], complete: boolean) {
  const exists = await client.query<{ name: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name",
  );
  if (exists.rows[0]?.name === null && !complete) return;
  if (!exists.rows[0]?.name) throw new MigrationError('LEDGER');
  const ledger = await client.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id',
  );
  if (
    ledger.rows.length > expected.length ||
    (complete && ledger.rows.length !== expected.length) ||
    ledger.rows.some(
      (row, index) =>
        row.hash !== expected[index]?.hash ||
        row.created_at !== String(expected[index]?.folderMillis),
    )
  )
    throw new MigrationError('LEDGER');
}

/** Owns one physical session for locking, Drizzle transactions, and cleanup. No retries. */
export async function migrateDatabase(
  configuration: MigrationConfiguration,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const started = performance.now();
  const { timeouts } = configuration;
  const socket = new Socket();
  const client = new Client({ ...configuration.connection, stream: () => socket });
  let failure: MigrationError | undefined;
  let phase: 'connect' | 'identity' | 'advisory' | 'ledger' | 'migrate' | 'unlock' = 'connect';
  let closing = false;
  let rejectFatal: (error: MigrationError) => void = () => {};
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  // Observe even if an already-aborted signal fires before Promise.race attaches.
  void fatal.catch(() => {});
  const stop = (category: MigrationFailure) => {
    failure ??= new MigrationError(category);
    socket.destroy();
    rejectFatal(failure);
  };
  // Active-query errors bypass Client's error event. Preserve the server's
  // transaction timeout before a generic connection-close event can win.
  client.connection.on('errorMessage', (error: unknown) => {
    if (sqlState(error) === '25P04') stop('OPERATION_TIMEOUT');
  });
  client.on('error', (error: unknown) =>
    stop(sqlState(error) === '25P04' ? 'OPERATION_TIMEOUT' : 'CONNECTION'),
  );
  client.on('end', () => {
    if (!closing) stop('CONNECTION');
  });
  const interrupt = () => stop('INTERRUPTED');
  options.signal?.addEventListener('abort', interrupt, { once: true });
  const timer = setTimeout(() => stop('OPERATION_TIMEOUT'), timeouts.operationMs);
  const check = () => {
    if (failure !== undefined) throw failure;
    if (performance.now() - started >= timeouts.operationMs) {
      stop('OPERATION_TIMEOUT');
      throw new MigrationError('OPERATION_TIMEOUT');
    }
  };
  const execute = async () => {
    check();
    const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
    let expected: MigrationMeta[];
    try {
      expected = readMigrationFiles({ migrationsFolder });
      if (expected.length === 0) throw new MigrationError('MIGRATION_FILES');
    } catch {
      throw new MigrationError('MIGRATION_FILES');
    }
    check();
    await client.connect();
    check();
    phase = 'identity';
    const identity = await client.query<{ valid: boolean }>(
      `SELECT current_database()=$1::text AND session_user::text=$2::text
        AND current_user::text=$2::text
        AND current_setting('server_version_num')::int / 10000=18 AS valid`,
      [configuration.connection.database, configuration.connection.user],
    );
    if (identity.rows[0]?.valid !== true) throw new MigrationError('IDENTITY');
    phase = 'advisory';
    await client.query(
      "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $1, false)",
      [String(timeouts.advisoryLockMs)],
    );
    check();
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [...MIGRATION_LOCK]);
    check();
    await client.query(
      `SELECT set_config('lock_timeout', $1, false),
        set_config('statement_timeout', $2, false),
        set_config('transaction_timeout', $3, false)`,
      [
        String(timeouts.lockMs),
        String(timeouts.statementMs),
        String(Math.max(1, Math.floor(timeouts.operationMs - (performance.now() - started)))),
      ],
    );
    phase = 'ledger';
    await verifyLedger(client, expected, false);
    check();
    phase = 'migrate';
    await migrate(drizzle({ client }), { migrationsFolder });
    check();
    phase = 'ledger';
    await verifyLedger(client, expected, true);
    check();
    phase = 'unlock';
    const unlocked = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock($1::int, $2::int) AS released',
      [...MIGRATION_LOCK],
    );
    if (unlocked.rows[0]?.released !== true) throw new MigrationError('CONNECTION');
    check();
  };
  try {
    if (options.signal?.aborted) interrupt();
    await Promise.race([execute(), fatal]);
  } catch (error: unknown) {
    const code = sqlState(error);
    failure ??=
      error instanceof MigrationError
        ? error
        : new MigrationError(
            phase === 'connect' || (typeof code === 'string' && /^(08|57P)/.test(code))
              ? 'CONNECTION'
              : phase === 'advisory' && (code === '55P03' || code === '57014')
                ? 'ADVISORY_LOCK_TIMEOUT'
                : code === '55P03'
                  ? 'LOCK_TIMEOUT'
                  : code === '57014'
                    ? 'STATEMENT_TIMEOUT'
                    : phase === 'ledger'
                      ? 'LEDGER'
                      : 'SQL_FAILURE',
          );
    socket.destroy();
  } finally {
    closing = true;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.end(),
        new Promise<never>((_resolve, reject) => {
          cleanupTimer = setTimeout(() => {
            socket.destroy();
            reject(new MigrationError('CLEANUP'));
          }, MIGRATION_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } catch {
      failure ??= new MigrationError('CLEANUP');
      socket.destroy();
    } finally {
      clearTimeout(cleanupTimer);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', interrupt);
    }
  }
  if (failure !== undefined) throw failure;
  if (performance.now() - started >= timeouts.operationMs)
    throw new MigrationError('OPERATION_TIMEOUT');
}
