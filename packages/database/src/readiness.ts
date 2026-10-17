import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Pool, PoolClient } from 'pg';
import { RUNTIME_SCHEMA_SHA256, runtimeSchemaQuery } from './runtime-schema.js';
import { runtimePrivilegesQuery } from './runtime-privileges.js';

export const DATABASE_READINESS_TIMEOUT_MS = 10_000;
type ReadinessFailure =
  | 'TIMEOUT'
  | 'CONNECTION'
  | 'IDENTITY'
  | 'SCHEMA'
  | 'READ_ONLY'
  | 'UNSAFE_PRIVILEGES'
  | 'MISSING_PRIVILEGES';

export class DatabaseReadinessError extends Error {
  constructor(readonly category: ReadinessFailure) {
    super('Database operational readiness failed.');
    this.name = 'DatabaseReadinessError';
  }
}

/** Read-only startup gate, including connection acquisition, under one absolute deadline. */
export async function assertRuntimeDatabaseReady(pool: Pick<Pool, 'connect'>): Promise<void> {
  let client: PoolClient | undefined;
  let released = false;
  let expired = false;
  const release = (destroy: boolean) => {
    if (client === undefined || released) return;
    released = true;
    client.release(destroy);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      release(true);
      reject(new DatabaseReadinessError('TIMEOUT'));
    }, DATABASE_READINESS_TIMEOUT_MS);
  });
  const check = async () => {
    client = await pool.connect();
    if (expired) {
      release(true);
      return;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const version = await client.query<{
      version: number;
      writable: boolean;
      identity_matches: boolean;
    }>(
      `SELECT current_setting('server_version_num')::integer AS version,
        current_setting('default_transaction_read_only')='off' AND NOT pg_is_in_recovery() AS writable,
        current_database()=$1::text AND session_user::text=$2::text
          AND current_user::text=$2::text AS identity_matches`,
      // pg exposes the explicit database/user requested by this physical client.
      // Bind them as values; neither identity nor a server error is ever logged.
      [client.database, client.user],
    );
    if (version.rows[0]?.identity_matches !== true) throw new DatabaseReadinessError('IDENTITY');
    if (Math.floor((version.rows[0]?.version ?? 0) / 10_000) !== 18) {
      throw new DatabaseReadinessError('SCHEMA');
    }
    if (!version.rows[0]?.writable) throw new DatabaseReadinessError('READ_ONLY');
    const manifest = await client.query<{ manifest: string }>(runtimeSchemaQuery);
    if (
      createHash('sha256')
        .update(manifest.rows[0]?.manifest ?? '')
        .digest('hex') !== RUNTIME_SCHEMA_SHA256
    ) {
      throw new DatabaseReadinessError('SCHEMA');
    }
    const privileges = await client.query<{ unsafe: boolean; missing: boolean }>(
      runtimePrivilegesQuery,
    );
    if (privileges.rows[0]?.unsafe !== false) throw new DatabaseReadinessError('UNSAFE_PRIVILEGES');
    if (privileges.rows[0].missing) throw new DatabaseReadinessError('MISSING_PRIVILEGES');
    const expected = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
    });
    const ledger = await client.query<{ hash: string; created_at: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id',
    );
    if (
      ledger.rows.length !== expected.length ||
      expected.some(
        (migration, index) =>
          ledger.rows[index]?.hash !== migration.hash ||
          ledger.rows[index]?.created_at !== String(migration.folderMillis),
      )
    ) {
      throw new DatabaseReadinessError('SCHEMA');
    }
    await client.query('ROLLBACK');
    release(false);
  };
  try {
    await Promise.race([check(), deadline]);
  } catch (error: unknown) {
    release(true);
    if (error instanceof DatabaseReadinessError) throw error;
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === '42501') throw new DatabaseReadinessError('MISSING_PRIVILEGES');
    if (typeof code === 'string' && ['42P01', '42704', '42703', '42883', '3F000'].includes(code)) {
      throw new DatabaseReadinessError('SCHEMA');
    }
    throw new DatabaseReadinessError('CONNECTION');
  } finally {
    clearTimeout(timer);
  }
}
