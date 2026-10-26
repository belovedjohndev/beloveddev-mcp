import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@beloveddev/test-support/test-database';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import type { DatabaseConnection } from '../src/client.js';
import { migrateDatabase, MIGRATION_LOCK, parseMigrationEnvironment } from '../src/migrate.js';
import { assertRuntimeDatabaseReady } from '../src/readiness.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = fileURLToPath(new URL('../../../scripts/migrate.ts', import.meta.url));
const active = new Set<ReturnType<typeof launch>>();

function launch(url: string | undefined, extra: Record<string, string> = {}, signalEvents = false) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('DATABASE_MIGRATION_')) delete env[name];
  }
  const child = spawn(
    process.execPath,
    [
      ...(signalEvents
        ? [
            '--import',
            'data:text/javascript,process.on("message",s=>{process.disconnect();process.emit(s)})',
          ]
        : []),
      entry,
    ],
    {
      cwd: root,
      env: {
        ...env,
        ...(url === undefined ? {} : { DATABASE_MIGRATION_URL: url }),
        DATABASE_MIGRATION_OPERATION_TIMEOUT_MS: '12000',
        ...extra,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', ...(signalEvents ? ['ipc' as const] : [])],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 17_000);
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    },
  ).finally(() => {
    clearTimeout(watchdog);
    active.delete(result);
  });
  const result = { child, done };
  active.add(result);
  return result;
}

afterEach(async () => {
  for (const process of active) process.child.kill('SIGKILL');
  await Promise.allSettled([...active].map((process) => process.done));
});

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    // Polling is bounded; progress depends on database state, not elapsed sleep.
    await pause(20);
  }
  throw new Error('Migration database-state barrier expired.');
}

async function migrationPid(admin: DatabaseConnection, waiting = false) {
  return waitFor(async () => {
    const result = await admin.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND application_name='beloveddev-migrate' ${waiting ? "AND wait_event_type='Lock'" : ''}`,
    );
    return result.rows[0]?.pid;
  });
}

async function noSessions(admin: DatabaseConnection) {
  await waitFor(async () => {
    const result = await admin.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='beloveddev-migrate'`,
    );
    return result.rows[0]?.count === 0 ? true : undefined;
  });
  const locks = await admin.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid=$1::oid AND objid=$2::oid AND objsubid=2`,
    [...MIGRATION_LOCK],
  );
  expect(locks.rows).toEqual([{ count: 0 }]);
}

function diagnostic(
  result: { code: number | null; stdout: string; stderr: string },
  category: string,
) {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  const lines = result.stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    event: 'database.migration_failed',
    category,
    outcome: 'unconfirmed',
  });
  expect(result.stderr).not.toMatch(/postgres(?:ql)?:\/\/|private-test-secret|CREATE TYPE| at /);
}

async function emptyDatabase(action: (admin: DatabaseConnection, url: string) => Promise<void>) {
  const database = await createTestDatabase(parseTestDatabaseUrl(process.env), {
    mcpRuntime: true,
    beforeMigrate: action,
  });
  try {
    await assertRuntimeDatabaseReady(database.runtime.pool);
    await noSessions(database.admin);
  } finally {
    await database.close();
  }
}

async function trigger(admin: DatabaseConnection, body: string) {
  // Test-owned objects only, confined to this test's generated disposable database.
  await admin.pool.query(`CREATE FUNCTION public.migration_test_hook() RETURNS event_trigger
    LANGUAGE plpgsql AS $hook$ BEGIN IF TG_TAG='CREATE TYPE' THEN ${body} END IF; END $hook$;
    CREATE EVENT TRIGGER migration_test_hook ON ddl_command_start
      EXECUTE FUNCTION public.migration_test_hook()`);
}

async function removeTrigger(admin: DatabaseConnection) {
  await admin.pool.query(
    'DROP EVENT TRIGGER IF EXISTS migration_test_hook; DROP FUNCTION IF EXISTS public.migration_test_hook()',
  );
}

describe('serialized administrative migration CLI against PostgreSQL 18', () => {
  it('migrates an empty database and preserves hashes and IDs on repeated CLI execution', async () => {
    await emptyDatabase(async (admin, url) => {
      expect((await launch(url).done).code).toBe(0);
      const before = await admin.pool.query(
        'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id',
      );
      const expected = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
      });
      expect(before.rows.map((row: { hash: string }) => row.hash)).toEqual(
        expected.map((m) => m.hash),
      );
      expect((await launch(url).done).code).toBe(0);
      expect(
        (await admin.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
      ).toEqual(before.rows);
    });
  });

  it('serializes independent processes on the session executing migration SQL', async () => {
    await emptyDatabase(async (admin, url) => {
      const barrier = await admin.pool.connect();
      await barrier.query('SELECT pg_advisory_lock($1::int,$2::int)', [...MIGRATION_LOCK]);
      const first = launch(url);
      let second: ReturnType<typeof launch> | undefined;
      try {
        // Gate first at the database advisory lock before either can run DDL.
        await migrationPid(admin, true);
        second = launch(url);
        await waitFor(async () => {
          const result = await admin.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted
              AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
              AND classid=$1::oid AND objid=$2::oid`,
            [...MIGRATION_LOCK],
          );
          return result.rows[0]?.count === 2 ? true : undefined;
        });
        await barrier.query('SELECT pg_advisory_unlock($1::int,$2::int)', [...MIGRATION_LOCK]);
        const results = await Promise.all([first.done, second.done]);
        expect(results.map((r) => r.code)).toEqual([0, 0]);
        expect(
          (
            await admin.pool.query(
              'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
            )
          ).rows,
        ).toEqual([{ count: 5 }]);
      } finally {
        await barrier.query('SELECT pg_advisory_unlock_all()');
        barrier.release();
        await Promise.allSettled([first.done, ...(second === undefined ? [] : [second.done])]);
      }
    });
  });

  it('bounds advisory lock acquisition, leaves no migration session, and recovers after release', async () => {
    await emptyDatabase(async (admin, url) => {
      const holder = await admin.pool.connect();
      try {
        await holder.query('SELECT pg_advisory_lock($1::int,$2::int)', [...MIGRATION_LOCK]);
        diagnostic(
          await launch(url, { DATABASE_MIGRATION_ADVISORY_LOCK_TIMEOUT_MS: '200' }).done,
          'ADVISORY_LOCK_TIMEOUT',
        );
        const absent = await admin.pool.query(
          "SELECT to_regclass('drizzle.__drizzle_migrations') AS name",
        );
        expect(absent.rows).toEqual([{ name: null }]);
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
      }
      await noSessions(admin);
      expect((await launch(url).done).code).toBe(0);
    });
  });

  it('keeps the migration advisory lock on the same backend as blocked transactional DDL', async () => {
    await emptyDatabase(async (admin, url) => {
      const holder = await admin.pool.connect();
      await holder.query('SELECT pg_advisory_lock(725,1)');
      await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
      const first = launch(url);
      try {
        const pid = await migrationPid(admin, true);
        expect(
          (
            await admin.pool.query(
              `SELECT granted FROM pg_locks WHERE pid=$1 AND locktype='advisory'
            AND classid=$2::oid AND objid=$3::oid AND objsubid=2`,
              [pid, ...MIGRATION_LOCK],
            )
          ).rows,
        ).toEqual([{ granted: true }]);
        diagnostic(
          await launch(url, { DATABASE_MIGRATION_ADVISORY_LOCK_TIMEOUT_MS: '200' }).done,
          'ADVISORY_LOCK_TIMEOUT',
        );
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
        expect((await first.done).code).toBe(0);
        await removeTrigger(admin);
      }
    });
  });

  it('fails SQL safely, rolls back observed transaction changes, rejects readiness, and recovers', async () => {
    await emptyDatabase(async (admin, url) => {
      await trigger(admin, "RAISE EXCEPTION 'private-test-secret';");
      try {
        diagnostic(await launch(url).done, 'SQL_FAILURE');
        await noSessions(admin);
        expect(
          (
            await admin.pool.query(
              'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (await admin.pool.query("SELECT to_regclass('public.tenants') AS name")).rows,
        ).toEqual([{ name: null }]);
        await expect(assertRuntimeDatabaseReady(admin.pool)).rejects.toMatchObject({
          category: 'SCHEMA',
        });
      } finally {
        await removeTrigger(admin);
      }
      expect((await launch(url).done).code).toBe(0);
    });
  });

  it.each([
    ['STATEMENT_TIMEOUT', { DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS: '200' }],
    ['OPERATION_TIMEOUT', { DATABASE_MIGRATION_OPERATION_TIMEOUT_MS: '1000' }],
  ] as const)(
    'enforces %s and releases connections without a rollback claim',
    async (category, limits) => {
      await emptyDatabase(async (admin, url) => {
        await trigger(admin, 'PERFORM pg_sleep(60);');
        try {
          diagnostic(await launch(url, limits).done, category);
          await noSessions(admin);
        } finally {
          await removeTrigger(admin);
        }
        expect((await launch(url).done).code).toBe(0);
      });
    },
  );

  it('enforces DDL lock wait separately from advisory acquisition and statement bounds', async () => {
    await emptyDatabase(async (admin, url) => {
      const holder = await admin.pool.connect();
      await holder.query('SELECT pg_advisory_lock(725,1)');
      await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
      try {
        diagnostic(
          await launch(url, { DATABASE_MIGRATION_LOCK_TIMEOUT_MS: '200' }).done,
          'LOCK_TIMEOUT',
        );
        await noSessions(admin);
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
        await removeTrigger(admin);
      }
    });
  });

  it('fails closed on backend termination while applying transactional DDL', async () => {
    await emptyDatabase(async (admin, url) => {
      await trigger(admin, 'PERFORM pg_sleep(60);');
      const process = launch(url);
      try {
        const pid = await waitFor(async () => {
          const rows = await admin.pool.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='beloveddev-migrate' AND wait_event='PgSleep'",
          );
          return rows.rows[0]?.pid;
        });
        await admin.pool.query('SELECT pg_terminate_backend($1)', [pid]);
        diagnostic(await process.done, 'CONNECTION');
        await noSessions(admin);
      } finally {
        await removeTrigger(admin);
      }
    });
  });

  it('interrupts a running executor through its AbortSignal and recovers', async () => {
    await emptyDatabase(async (admin, url) => {
      const holder = await admin.pool.connect();
      await holder.query('SELECT pg_advisory_lock(725,1)');
      await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
      const abort = new AbortController();
      const running = migrateDatabase(parseMigrationEnvironment({ DATABASE_MIGRATION_URL: url }), {
        signal: abort.signal,
      });
      // Observe rejection before coordinating to avoid an unhandled test failure.
      const settled = running.catch((error: unknown) => error);
      try {
        await migrationPid(admin, true);
        abort.abort();
        expect(await settled).toMatchObject({ category: 'INTERRUPTED' });
        await noSessions(admin);
      } finally {
        abort.abort();
        await settled;
        await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
        await removeTrigger(admin);
      }
    });
  });

  it.each(['SIGINT', 'SIGTERM'])(
    'handles %s through the actual CLI signal handler with nonzero safe diagnostics',
    async (signal) => {
      await emptyDatabase(async (admin, url) => {
        const holder = await admin.pool.connect();
        await holder.query('SELECT pg_advisory_lock(725,1)');
        await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
        const process = launch(url, {}, true);
        try {
          await migrationPid(admin, true);
          process.child.send(signal);
          diagnostic(await process.done, 'INTERRUPTED');
        } finally {
          await holder.query('SELECT pg_advisory_unlock_all()');
          holder.release();
          await process.done;
          await removeTrigger(admin);
        }
        await noSessions(admin);
        expect((await launch(url).done).code).toBe(0);
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'handles an actual POSIX SIGTERM during migration',
    async () => {
      await emptyDatabase(async (admin, url) => {
        const holder = await admin.pool.connect();
        await holder.query('SELECT pg_advisory_lock(725,1)');
        await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
        const process = launch(url);
        try {
          await migrationPid(admin, true);
          process.child.kill('SIGTERM');
          diagnostic(await process.done, 'INTERRUPTED');
        } finally {
          await holder.query('SELECT pg_advisory_unlock_all()');
          holder.release();
          await process.done;
          await removeTrigger(admin);
        }
        await noSessions(admin);
      });
    },
  );

  it('recovers after forced process termination without assuming a delivered rollback result', async () => {
    await emptyDatabase(async (admin, url) => {
      const holder = await admin.pool.connect();
      await holder.query('SELECT pg_advisory_lock(725,1)');
      await trigger(admin, 'PERFORM pg_advisory_xact_lock(725,1);');
      const process = launch(url);
      try {
        await migrationPid(admin, true);
        process.child.kill('SIGKILL');
        expect((await process.done).code).not.toBe(0);
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
        await process.done;
        await noSessions(admin);
        await removeTrigger(admin);
      }
      expect((await launch(url).done).code).toBe(0);
    });
  });

  it('rejects altered ledger history without repairing it', async () => {
    const database = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    try {
      await database.admin.pool.query(
        "UPDATE drizzle.__drizzle_migrations SET hash='private-test-secret' WHERE id=1",
      );
      const before = await database.admin.pool.query(
        'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id',
      );
      diagnostic(await launch(database.migrationUrl).done, 'LEDGER');
      expect(
        (await database.admin.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id'))
          .rows,
      ).toEqual(before.rows);
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'SCHEMA',
      });
      await noSessions(database.admin);
    } finally {
      await database.close();
    }
  });

  it('rejects runtime privileges for migrations and preserves runtime readiness', async () => {
    const database = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    try {
      diagnostic(await launch(database.runtimeUrl).done, 'SQL_FAILURE');
      await assertRuntimeDatabaseReady(database.runtime.pool);
      await noSessions(database.admin);
    } finally {
      await database.close();
    }
  });

  it('ignores poisoned ambient pg endpoint, identity, and TLS settings in the real CLI', async () => {
    await emptyDatabase(async (_admin, url) => {
      expect(
        (
          await launch(url, {
            PGHOST: 'remote.invalid',
            PGPORT: '1',
            PGUSER: 'wrong',
            PGPASSWORD: 'wrong',
            PGDATABASE: 'wrong',
            PGSSLMODE: 'no-verify',
            PGOPTIONS: '-c role=wrong',
            PGSSLNEGOTIATION: 'invalid',
            PGAPPNAME: 'wrong',
          }).done
        ).code,
      ).toBe(0);
      const invalid = new URL(url);
      invalid.password = 'private-test-secret';
      diagnostic(await launch(invalid.href).done, 'CONNECTION');
    });
  });

  it.each([
    ['CONNECTION', { DATABASE_MIGRATION_CONNECT_TIMEOUT_MS: '200' }],
    [
      'OPERATION_TIMEOUT',
      {
        DATABASE_MIGRATION_OPERATION_TIMEOUT_MS: '200',
        DATABASE_MIGRATION_CONNECT_TIMEOUT_MS: '10000',
      },
    ],
  ] as const)('bounds stalled connection setup: %s', async (category, limits) => {
    // A real local TCP peer accepts but never answers PostgreSQL startup.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Unexpected TCP fixture address.');
      diagnostic(
        await launch(
          `postgresql://admin:private-test-secret@127.0.0.1:${address.port}/test`,
          limits,
        ).done,
        category,
      );
      await waitFor(() => (sockets.size === 0 ? true : undefined));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    undefined,
    'postgresql://admin:private-test-secret@remote.example/app',
    'postgresql://admin:private-test-secret@localhost/app?sslmode=require',
  ])(
    'returns safe nonzero entrypoint diagnostics for missing/invalid admin configuration: %#',
    async (url) => {
      diagnostic(
        await launch(url, {
          DATABASE_URL: 'postgresql://runtime:private-test-secret@localhost/runtime',
        }).done,
        'CONFIGURATION',
      );
    },
  );
});
