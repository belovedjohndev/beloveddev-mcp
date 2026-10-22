import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, rmdir, rename, lstat } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client, type PoolClient } from 'pg';
import { z } from 'zod';
import { openDatabase, type DatabaseConnection } from './client.js';
import { assertRuntimeDatabaseReady } from './readiness.js';
import { runtimeSchemaQuery, RUNTIME_SCHEMA_SHA256 } from './runtime-schema.js';
import { withRecoveryTools } from './recovery-process.js';
import { RecoveryError, assertNotAborted, type RecoveryConfiguration } from './recovery-policy.js';
import { MIGRATION_LOCK } from './migrate.js';
export { parseRecoveryEnvironment, RecoveryError } from './recovery-policy.js';

export const RECOVERY_TABLES = Object.freeze([
  'tenants',
  'users',
  'tenant_memberships',
  'developer_profiles',
  'clients',
  'projects',
  'project_evidence',
  'project_blockers',
  'opportunities',
  'project_notes',
  'audit_logs',
  'drizzle.__drizzle_migrations',
] as const);
type TableDigest = { count: number; sha256: string };
type DataDigests = Record<string, TableDigest>;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const backupManifestSchema = z.strictObject({
  version: z.literal(1),
  status: z.literal('validated'),
  format: z.literal('postgresql-18-custom'),
  sha256: sha256Schema,
  bytes: z.int().positive(),
  schemaSha256: z.literal(RUNTIME_SCHEMA_SHA256),
  data: z
    .record(z.string(), z.strictObject({ count: z.int().nonnegative(), sha256: sha256Schema }))
    .refine(
      (data) =>
        Object.keys(data).length === RECOVERY_TABLES.length &&
        RECOVERY_TABLES.every((table) => Object.hasOwn(data, table)),
    ),
  createdAt: z.iso.datetime(),
  backupDurationMs: z.int().nonnegative(),
});
export type BackupManifest = Readonly<z.infer<typeof backupManifestSchema>>;

function operationSignal(configuration: RecoveryConfiguration, signal?: AbortSignal) {
  return AbortSignal.any([
    AbortSignal.timeout(configuration.timeoutMs),
    ...(signal ? [signal] : []),
  ]);
}

async function withinOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let interrupt = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        interrupt = () => {
          try {
            assertNotAborted(signal);
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new RecoveryError('INTERRUPTED'));
          }
        };
        signal.addEventListener('abort', interrupt, { once: true });
        if (signal.aborted) interrupt();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

async function withClient<T>(
  configuration: RecoveryConfiguration,
  signal: AbortSignal,
  action: (client: Client) => Promise<T>,
) {
  const socket = new Socket();
  const client = new Client({ ...configuration.connection, stream: () => socket });
  let lost = false;
  client.on('error', () => {
    lost = true;
    socket.destroy();
  });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    assertNotAborted(signal);
    await client.connect();
    const identity = await client.query<{ valid: boolean }>(
      `SELECT current_database()=$1::text AND current_user::text=$2::text
       AND session_user::text=$2::text AND current_setting('server_version_num')::int/10000=18 AS valid`,
      [configuration.database, configuration.user],
    );
    if (identity.rows[0]?.valid !== true) throw new RecoveryError('CONNECTION');
    const result = await action(client);
    assertNotAborted(signal);
    if (lost) throw new RecoveryError('CONNECTION');
    return result;
  } catch (error: unknown) {
    socket.destroy();
    assertNotAborted(signal);
    throw error instanceof RecoveryError ? error : new RecoveryError('CONNECTION');
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.end(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            socket.destroy();
            reject(new RecoveryError('CLEANUP'));
          }, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

async function databaseDigests(client: Client, signal: AbortSignal): Promise<DataDigests> {
  const data: DataDigests = {};
  for (const table of RECOVERY_TABLES) {
    assertNotAborted(signal);
    const digest = createHash('sha256');
    let count = 0;
    // Identifiers are compile-time allowlisted; no caller-selected SQL identifiers.
    await client.query(
      `DECLARE recovery_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY id`,
    );
    for (;;) {
      assertNotAborted(signal);
      const batch = await client.query<{ row: string }>('FETCH FORWARD 500 FROM recovery_rows');
      for (const row of batch.rows) {
        digest.update(row.row);
        digest.update('\n');
        count++;
      }
      if (batch.rows.length < 500) break;
    }
    await client.query('CLOSE recovery_rows');
    data[table] = { count, sha256: digest.digest('hex') };
  }
  return data;
}

async function assertSchemaAndLedger(client: Client) {
  const schema = await client.query<{ manifest: string }>(runtimeSchemaQuery);
  if (
    createHash('sha256')
      .update(schema.rows[0]?.manifest ?? '')
      .digest('hex') !== RUNTIME_SCHEMA_SHA256
  )
    throw new RecoveryError('SCHEMA');
  const expected = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
  });
  const ledger = await client.query<{ hash: string; created_at: string }>(
    'SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id',
  );
  if (
    ledger.rows.length !== expected.length ||
    expected.some(
      (m, i) =>
        ledger.rows[i]?.hash !== m.hash || ledger.rows[i]?.created_at !== String(m.folderMillis),
    )
  )
    throw new RecoveryError('LEDGER');
}

async function fileDigest(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stream = handle.createReadStream({ signal, autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function inspectArchive(
  path: string,
  run: Parameters<Parameters<typeof withRecoveryTools>[2]>[0],
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString('ascii') !== 'PGDMP') throw new RecoveryError('ARTIFACT');
  } finally {
    await handle.close();
  }
  const toc = await run('pg_restore', ['--list', path]);
  // pg_dump 18 omits the initdb-created public SCHEMA entry; its tables below
  // explicitly represent public. Drizzle is a user-created schema and must exist.
  for (const schema of ['drizzle']) {
    if (!new RegExp(` SCHEMA - ${schema} `).test(toc)) throw new RecoveryError('ARTIFACT');
  }
  for (const table of RECOVERY_TABLES) {
    const [schema, name] = table.includes('.') ? table.split('.') : ['public', table];
    for (const kind of ['TABLE', 'TABLE DATA']) {
      if (!toc.includes(` ${kind} ${schema} ${name} `)) throw new RecoveryError('ARTIFACT');
    }
  }
  // Read and decompress every data block: a valid TOC alone misses truncated tails.
  await run('pg_restore', ['--no-owner', '--no-acl', '--file=-', path], 'discard');
}

/** A newly reserved private directory is the artifact; completion metadata is published last. */
export async function createBackup(
  configuration: RecoveryConfiguration,
  directory: string,
  signal?: AbortSignal,
): Promise<BackupManifest> {
  const started = performance.now();
  const bounded = operationSignal(configuration, signal);
  let owned = false;
  let complete = false;
  const partial = join(directory, 'archive.partial');
  const archive = join(directory, 'archive.dump');
  try {
    try {
      await mkdir(directory, { mode: 0o700 });
      owned = true;
    } catch (error: unknown) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
        throw new RecoveryError('EXISTS');
      throw new RecoveryError('ARTIFACT');
    }
    const result = await withRecoveryTools(configuration, bounded, async (run) =>
      withClient(configuration, bounded, async (client) => {
        await client.query('SELECT pg_advisory_lock_shared($1::int,$2::int)', [...MIGRATION_LOCK]);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await assertSchemaAndLedger(client);
        const exported = await client.query<{ snapshot: string }>(
          'SELECT pg_export_snapshot() AS snapshot',
        );
        const snapshot = exported.rows[0]?.snapshot;
        if (!snapshot || !/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new RecoveryError('CONNECTION');
        const data = await databaseDigests(client, bounded);
        const output = await open(partial, 'wx', 0o600);
        try {
          await run(
            'pg_dump',
            [
              '--format=custom',
              '--no-owner',
              '--no-acl',
              '--no-tablespaces',
              '--no-password',
              '--lock-wait-timeout=5000',
              `--snapshot=${snapshot}`,
            ],
            output.fd,
          );
          await output.sync();
        } finally {
          await output.close();
        }
        await client.query('ROLLBACK');
        await inspectArchive(partial, run);
        const bytes = (await stat(partial)).size;
        const sha256 = await fileDigest(partial, bounded);
        assertNotAborted(bounded);
        return {
          version: 1 as const,
          status: 'validated' as const,
          format: 'postgresql-18-custom' as const,
          sha256,
          bytes,
          schemaSha256: RUNTIME_SCHEMA_SHA256,
          data,
          createdAt: new Date().toISOString(),
          backupDurationMs: Math.round(performance.now() - started),
        } satisfies BackupManifest;
      }),
    );
    assertNotAborted(bounded);
    await rename(partial, archive);
    const metadata = await open(join(directory, 'manifest.partial'), 'wx', 0o600);
    try {
      await metadata.writeFile(JSON.stringify(result, null, 2) + '\n');
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    assertNotAborted(bounded);
    await rename(join(directory, 'manifest.partial'), join(directory, 'manifest.json'));
    assertNotAborted(bounded);
    complete = true;
    return result;
  } catch (error: unknown) {
    assertNotAborted(bounded);
    throw error instanceof RecoveryError ? error : new RecoveryError('ARTIFACT');
  } finally {
    if (owned && !complete) {
      await Promise.allSettled(
        ['archive.partial', 'archive.dump', 'manifest.partial', 'manifest.json'].map((name) =>
          unlink(join(directory, name)),
        ),
      );
      await rmdir(directory).catch(() => {});
    }
  }
}

export async function validateBackup(
  configuration: RecoveryConfiguration,
  directory: string,
  signal?: AbortSignal,
): Promise<BackupManifest> {
  const bounded = operationSignal(configuration, signal);
  try {
    if (!(await lstat(directory)).isDirectory()) throw new RecoveryError('ARTIFACT');
    const metadata = join(directory, 'manifest.json');
    if (!(await lstat(metadata)).isFile() || (await stat(metadata)).size > 65_536)
      throw new RecoveryError('ARTIFACT');
    const parsed = backupManifestSchema.safeParse(
      JSON.parse(await readFile(metadata, 'utf8')) as unknown,
    );
    if (!parsed.success) throw new RecoveryError('ARTIFACT');
    const manifest = parsed.data;
    const archive = join(directory, 'archive.dump');
    if (
      !(await lstat(archive)).isFile() ||
      (await stat(archive)).size !== manifest.bytes ||
      (await fileDigest(archive, bounded)) !== manifest.sha256
    )
      throw new RecoveryError('ARTIFACT');
    await withRecoveryTools(configuration, bounded, (run) => inspectArchive(archive, run));
    assertNotAborted(bounded);
    return manifest;
  } catch (error: unknown) {
    assertNotAborted(bounded);
    throw error instanceof RecoveryError ? error : new RecoveryError('ARTIFACT');
  }
}

function targetConfiguration(
  configuration: RecoveryConfiguration,
  database: string,
): RecoveryConfiguration {
  return { ...configuration, database, connection: { ...configuration.connection, database } };
}

function runtimeUrl(
  configuration: RecoveryConfiguration,
  database: string,
  role: string,
  password: string,
) {
  const url = new URL(
    `postgresql://${configuration.host.includes(':') ? `[${configuration.host}]` : configuration.host}:${configuration.port}/`,
  );
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  if (configuration.tls) url.searchParams.set('sslmode', 'verify-full');
  return url.href;
}

export type RestoredDatabase = Readonly<{
  admin: DatabaseConnection;
  runtime: DatabaseConnection;
  runtimeUrl: string;
  databaseName: string;
}>;

/** Only creates targets; never accepts a destination name and never replaces a database. */
export async function withRestoredDatabase<T>(
  configuration: RecoveryConfiguration,
  directory: string,
  action: (target: RestoredDatabase) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ result: T; restoreDurationMs: number }> {
  const started = performance.now();
  const bounded = operationSignal(configuration, signal);
  const manifest = await validateBackup(configuration, directory, bounded);
  const databaseName = `beloveddev_restore_${randomUUID().replaceAll('-', '')}`;
  const roleName = `${databaseName}_rt`;
  const password = randomUUID().replaceAll('-', '');
  let databaseOid: number | undefined;
  let roleOid: number | undefined;
  let admin: DatabaseConnection | undefined;
  let runtime: DatabaseConnection | undefined;
  let cleanupFailed = false;
  const acquired = new Set<PoolClient>();
  const releaseAcquired = () => {
    for (const client of acquired) {
      acquired.delete(client);
      client.release(true);
    }
  };
  const verified = await withClient(configuration, bounded, async (control) => {
    const retire = async () => {
      // Use a fresh bounded control session even if the operation connection died.
      await withClient(configuration, AbortSignal.timeout(15_000), async (cleanup) => {
        if (
          !/^beloveddev_restore_[a-f0-9]{32}$/.test(databaseName) ||
          roleName !== `${databaseName}_rt`
        )
          throw new RecoveryError('CLEANUP');
        if (databaseOid !== undefined) {
          const identity = await cleanup.query<{ oid: number }>(
            'SELECT oid FROM pg_database WHERE datname=$1 AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)',
            [databaseName],
          );
          if (identity.rows[0]?.oid !== databaseOid) throw new RecoveryError('CLEANUP');
          await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
        if (roleOid !== undefined) {
          const identity = await cleanup.query<{ oid: number }>(
            'SELECT oid FROM pg_roles WHERE rolname=$1',
            [roleName],
          );
          if (identity.rows[0]?.oid !== roleOid) throw new RecoveryError('CLEANUP');
          await cleanup.query(`DROP ROLE "${roleName}"`);
        }
      });
    };
    let outcome: { result: T; restoreDurationMs: number } | undefined;
    let failure: unknown;
    try {
      await control.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
      databaseOid = (
        await control.query<{ oid: number }>('SELECT oid FROM pg_database WHERE datname=$1', [
          databaseName,
        ])
      ).rows[0]?.oid;
      if (databaseOid === undefined) throw new RecoveryError('RESTORE');
      const destination = targetConfiguration(configuration, databaseName);
      await withClient(destination, bounded, async (verify) => {
        const identity = await verify.query<{ oid: number; owned: boolean }>(
          'SELECT oid,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=current_database()',
        );
        if (identity.rows[0]?.oid !== databaseOid || identity.rows[0]?.owned !== true)
          throw new RecoveryError('RESTORE');
        const empty = await verify.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S')",
        );
        if (empty.rows[0]?.count !== 0) throw new RecoveryError('RESTORE');
      });
      await withRecoveryTools(destination, bounded, async (run) => {
        await run(
          'pg_restore',
          [
            '--no-password',
            '--exit-on-error',
            '--single-transaction',
            '--no-owner',
            '--no-acl',
            '--no-tablespaces',
            '--dbname',
            databaseName,
            join(directory, 'archive.dump'),
          ],
          'discard',
        );
      });
      await withClient(destination, bounded, async (verify) => {
        await verify.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await assertSchemaAndLedger(verify);
        const data = await databaseDigests(verify, bounded);
        if (
          RECOVERY_TABLES.some(
            (table) =>
              data[table]?.count !== manifest.data[table]?.count ||
              data[table]?.sha256 !== manifest.data[table]?.sha256,
          )
        )
          throw new RecoveryError('DATA');
        await verify.query('ROLLBACK');
      });
      await control.query(
        `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      roleOid = (
        await control.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [
          roleName,
        ])
      ).rows[0]?.oid;
      if (roleOid === undefined) throw new RecoveryError('RESTORE');
      await withClient(destination, bounded, async (grant) => {
        await grant.query(`BEGIN;
          REVOKE CREATE,TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC;
          REVOKE CREATE ON SCHEMA public FROM PUBLIC;
          GRANT CONNECT ON DATABASE "${databaseName}" TO "${roleName}";
          GRANT USAGE ON SCHEMA public,drizzle TO "${roleName}";
          GRANT SELECT ON tenant_memberships,developer_profiles,clients,projects,project_evidence,project_blockers,project_notes,opportunities,drizzle.__drizzle_migrations TO "${roleName}";
          GRANT SELECT(id,status) ON tenants,users TO "${roleName}";
          GRANT INSERT ON project_notes,audit_logs TO "${roleName}";
          COMMIT;`);
      });
      let clientFailed = false;
      const onError = () => {
        clientFailed = true;
      };
      const options = {
        onIdleError: onError,
        onClientError: onError,
        maxConnections: 2,
        ...(configuration.ca === undefined ? {} : { tlsCa: configuration.ca }),
      };
      const url = runtimeUrl(configuration, databaseName, roleName, password);
      runtime = openDatabase(url, options);
      admin = openDatabase(
        runtimeUrl(configuration, databaseName, configuration.user, configuration.password),
        options,
      );
      for (const connection of [runtime, admin]) {
        connection.pool.on('acquire', (client) => acquired.add(client));
        connection.pool.on('release', (_error, client) => acquired.delete(client));
      }
      bounded.addEventListener('abort', releaseAcquired, { once: true });
      await assertRuntimeDatabaseReady(runtime.pool).catch(() => {
        assertNotAborted(bounded);
        throw new RecoveryError('READINESS');
      });
      assertNotAborted(bounded);
      const restoreDurationMs = Math.round(performance.now() - started);
      const result = await withinOperation(
        action({ admin, runtime, runtimeUrl: url, databaseName }),
        bounded,
      );
      assertNotAborted(bounded);
      await assertRuntimeDatabaseReady(runtime.pool).catch(() => {
        assertNotAborted(bounded);
        throw new RecoveryError('READINESS');
      });
      assertNotAborted(bounded);
      if (clientFailed) throw new RecoveryError('CONNECTION');
      outcome = { result, restoreDurationMs };
    } catch (error: unknown) {
      failure = error;
    } finally {
      bounded.removeEventListener('abort', releaseAcquired);
      releaseAcquired();
      for (const connection of [runtime, admin]) {
        if (connection !== undefined)
          await withinOperation(connection.close(), AbortSignal.timeout(5_000)).catch(() => {
            cleanupFailed = true;
          });
      }
      await retire().catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw new RecoveryError('CLEANUP');
    if (failure !== undefined)
      throw failure instanceof Error ? failure : new RecoveryError('RESTORE');
    if (outcome === undefined) throw new RecoveryError('RESTORE');
    return outcome;
  });
  assertNotAborted(bounded);
  return verified;
}
