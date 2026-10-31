import { randomUUID } from 'node:crypto';
import { openDatabase, type DatabaseConnection } from '@beloveddev/database/client';
import { migrateDatabase, parseMigrationEnvironment } from '@beloveddev/database/migrate';

type TestDatabaseOptions = {
  beforeMigrate?: (connection: DatabaseConnection, administratorUrl: string) => Promise<void>;
  projectNoteWrites?: boolean;
  mcpRuntime?: boolean;
  tlsCa?: string;
};
const pendingSetups = new Set<Promise<TestDatabase>>();
const liveFixtures = new Set<() => Promise<void>>();

export class TestCleanupError extends Error {
  constructor(readonly failures: readonly { stage: string; code: string }[]) {
    super(
      `Test resource cleanup failed: ${failures.map(({ stage, code }) => `${stage} [${code}]`).join(', ')}.`,
    );
    this.name = 'TestCleanupError';
  }
}

/** Independent steps always run; diagnostics deliberately exclude raw errors/SQL/credentials. */
export async function cleanupTestResources(
  steps: readonly { stage: string; run: () => void | Promise<void> }[],
) {
  const failures: { stage: string; code: string }[] = [];
  for (const { stage, run } of steps) {
    try {
      await run();
    } catch (error: unknown) {
      if (error instanceof TestCleanupError) {
        failures.push(
          ...error.failures.map((failure) => ({
            stage: `${stage}.${failure.stage}`,
            code: failure.code,
          })),
        );
        continue;
      }
      const code =
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[A-Z0-9_]{1,32}$/.test(error.code)
          ? error.code
          : 'UNKNOWN';
      failures.push({ stage, code });
    }
  }
  if (failures.length) throw new TestCleanupError(failures);
}

/** Preserve the original assertion while independently attempting every owned cleanup step. */
export async function withTestResourceCleanup<T>(
  operation: () => T | Promise<T>,
  steps: Parameters<typeof cleanupTestResources>[0],
): Promise<T> {
  const outcome = await Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    await cleanupTestResources(steps);
  } catch (cleanupError: unknown) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, cleanupError],
        'Test assertion and resource cleanup failed.',
        { cause: cleanupError },
      );
    throw cleanupError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function createTestDatabase(
  administratorUrl: string,
  options: TestDatabaseOptions = {},
): ReturnType<typeof initializeTestDatabase> {
  const setup = initializeTestDatabase(administratorUrl, options);
  pendingSetups.add(setup);
  void setup.then(
    () => pendingSetups.delete(setup),
    () => pendingSetups.delete(setup),
  );
  return setup;
}

/** A timed-out test can finish before its asynchronous setup returns a fixture. */
export async function finishPendingTestDatabases() {
  if (!pendingSetups.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let results: PromiseSettledResult<TestDatabase>[];
  try {
    results = await Promise.race([
      Promise.allSettled([...pendingSetups]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TestCleanupError([{ stage: 'pending_setups', code: 'SETUP_TIMEOUT' }])),
          45_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const failures: unknown[] = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  try {
    await cleanupTestResources(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? [{ stage: 'late_fixture', run: result.value.close }] : [],
      ),
    );
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Unfinished test fixture setup or retirement failed.');
}

export async function closeTestDatabaseFixtures() {
  await cleanupTestResources([
    { stage: 'pending_setups', run: finishPendingTestDatabases },
    {
      stage: 'live_fixtures',
      run: () =>
        cleanupTestResources(
          [...liveFixtures].map((close) => ({
            stage: 'owned_fixture',
            run: close,
          })),
        ),
    },
  ]);
}

async function initializeTestDatabase(administratorUrl: string, options: TestDatabaseOptions) {
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `beloveddev_test_${suffix}`;
  const roleName = `${databaseName}_runtime`;
  const password = randomUUID().replaceAll('-', '');
  let idleFailure = false;
  let closing = false;
  const onIdleError = () => {
    if (!closing) idleFailure = true;
  };
  const connectionOptions = {
    onIdleError,
    ...(options.tlsCa === undefined ? {} : { tlsCa: options.tlsCa }),
  };
  const control = openDatabase(administratorUrl, { ...connectionOptions, maxConnections: 1 });
  let admin: DatabaseConnection | undefined;
  let runtime: DatabaseConnection | undefined;
  let databaseCreated = false;
  let roleCreated = false;
  let databaseOid: number | undefined;
  let roleOid: number | undefined;
  let ownerOid: number | undefined;
  let closingOperation: Promise<void> | undefined;

  // pool.end() waits forever for checked-out clients unless their owner releases them.
  // Retire only this fixture's acquired connections, including after a failed test.
  const acquired = new Map<DatabaseConnection, Map<object, () => void>>();
  function own(connection: DatabaseConnection) {
    const held = new Map<object, () => void>();
    connection.pool.on('acquire', (client) => held.set(client, () => client.release(true)));
    connection.pool.on('release', (_error, client) => held.delete(client));
    acquired.set(connection, held);
    return connection;
  }
  own(control);

  async function closePool(connection: DatabaseConnection | undefined) {
    if (!connection) return;
    let ended: Promise<void>;
    try {
      ended = connection.close();
    } catch (error: unknown) {
      ended = Promise.reject(
        error instanceof Error ? error : new Error('Owned pool close failed.', { cause: error }),
      );
    }
    void ended.catch(() => {});
    const releaseFailures: unknown[] = [];
    for (const release of [...(acquired.get(connection)?.values() ?? [])]) {
      try {
        release();
      } catch (error: unknown) {
        releaseFailures.push(error);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ended,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Owned pool did not close.')), 5_000);
        }),
      ]);
      if (releaseFailures.length) throw new Error('Owned client release failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function retire() {
    closing = true;
    await cleanupTestResources([
      { stage: 'runtime_pool', run: () => closePool(runtime) },
      { stage: 'admin_pool', run: () => closePool(admin) },
      {
        stage: 'database',
        run: async () => {
          if (!databaseCreated) return;
          const actual = await control.pool.query<{ oid: number; datdba: number }>(
            'SELECT oid,datdba FROM pg_database WHERE datname=$1',
            [databaseName],
          );
          if (
            !/^beloveddev_test_[0-9a-f]{32}$/.test(databaseName) ||
            databaseOid === undefined ||
            actual.rows[0]?.oid !== databaseOid ||
            actual.rows[0]?.datdba !== ownerOid
          )
            throw new Error('Refusing unverified database retirement.');
          await control.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        },
      },
      {
        stage: 'role',
        run: async () => {
          if (!roleCreated) return;
          const actual = await control.pool.query<{ oid: number }>(
            'SELECT oid FROM pg_roles WHERE rolname=$1',
            [roleName],
          );
          if (
            roleName !== `${databaseName}_runtime` ||
            roleOid === undefined ||
            actual.rows[0]?.oid !== roleOid
          )
            throw new Error('Refusing unverified role retirement.');
          await control.pool.query(`DROP ROLE "${roleName}"`);
        },
      },
      { stage: 'control_pool', run: () => closePool(control) },
      {
        stage: 'prior_pool_error',
        run: () =>
          idleFailure
            ? Promise.reject(new Error('A fixture pool failed before retirement.'))
            : Promise.resolve(),
      },
    ]);
  }

  function close() {
    // Coalesce concurrent/repeated teardown; a failed retirement stays failed, without retries.
    closingOperation ??= retire().finally(() => {
      liveFixtures.delete(close);
    });
    return closingOperation;
  }

  try {
    const version = await control.pool.query<{ version: number; owner_oid: number }>(
      "SELECT current_setting('server_version_num')::int / 10000 AS version,(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner_oid",
    );
    if (version.rows[0]?.version !== 18) throw new Error('Tests require PostgreSQL 18.');
    ownerOid = version.rows[0].owner_oid;
    // Identifiers and password below are generated hexadecimal values, never caller input.
    await control.pool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    databaseOid = (
      await control.pool.query<{ oid: number }>('SELECT oid FROM pg_database WHERE datname=$1', [
        databaseName,
      ])
    ).rows[0]?.oid;
    await control.pool.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    roleCreated = true;
    roleOid = (
      await control.pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [
        roleName,
      ])
    ).rows[0]?.oid;
    const url = new URL(administratorUrl);
    url.pathname = `/${databaseName}`;
    admin = own(openDatabase(url.href, connectionOptions));
    const connectedIdentity = await admin.pool.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    if (connectedIdentity.rows[0]?.name !== databaseName) {
      throw new Error('Refusing to migrate an unexpected test database.');
    }
    await options.beforeMigrate?.(admin, url.href);
    await migrateDatabase(
      parseMigrationEnvironment({
        DATABASE_MIGRATION_URL: url.href,
        ...(options.tlsCa === undefined ? {} : { DATABASE_MIGRATION_TLS_CA: options.tlsCa }),
      }),
    );
    await admin.pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await admin.pool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await admin.pool.query(
      `GRANT SELECT ON tenant_memberships, developer_profiles, clients, projects, project_evidence, project_blockers, project_notes, opportunities TO "${roleName}"`,
    );
    await admin.pool.query(`GRANT SELECT (id, status) ON tenants, users TO "${roleName}"`);
    if (!options.mcpRuntime) await admin.pool.query(`GRANT INSERT ON projects TO "${roleName}"`);
    if (options.projectNoteWrites || options.mcpRuntime) {
      await admin.pool.query(`GRANT INSERT ON project_notes, audit_logs TO "${roleName}"`);
    }
    if (options.mcpRuntime) {
      await admin.pool.query(`REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC`);
      await admin.pool.query(`GRANT USAGE ON SCHEMA drizzle TO "${roleName}"`);
      await admin.pool.query(`GRANT SELECT ON drizzle.__drizzle_migrations TO "${roleName}"`);
    }
    const migrationUrl = url.href;
    url.username = roleName;
    url.password = password;
    url.searchParams.delete('user');
    url.searchParams.delete('password');
    runtime = own(openDatabase(url.href, connectionOptions));
    if (databaseOid === undefined || roleOid === undefined)
      throw new Error('Fixture identity was not recorded.');
    const identity = Object.freeze({ databaseName, databaseOid, roleName, roleOid, ownerOid });
    liveFixtures.add(close);
    return { admin, runtime, migrationUrl, runtimeUrl: url.href, identity, close };
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'Test database setup and cleanup failed.', {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
