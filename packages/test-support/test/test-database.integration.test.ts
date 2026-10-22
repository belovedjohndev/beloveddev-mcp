import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseConnection } from '@beloveddev/database/client';
import {
  createTestDatabase,
  cleanupTestResources,
  TestCleanupError,
  finishPendingTestDatabases,
  type TestDatabase,
} from '@beloveddev/test-support/test-database';

describe('owned PostgreSQL fixture lifecycle', () => {
  let control: DatabaseConnection;
  let idleFailed = false;
  const url = () => {
    const value = process.env['TEST_DATABASE_URL'];
    if (!value) throw new Error('An explicit TEST_DATABASE_URL is required.');
    return value; // The fixture applies the shared connection policy and PostgreSQL 18 check.
  };
  beforeAll(() => {
    control = openDatabase(url(), {
      onIdleError: () => {
        idleFailed = true;
      },
    });
  });
  afterAll(async () => {
    await control.close();
    expect(idleFailed).toBe(false);
  });
  async function absent(identity: TestDatabase['identity']) {
    expect(
      (
        await control.pool.query('SELECT oid FROM pg_database WHERE oid=$1 OR datname=$2', [
          identity.databaseOid,
          identity.databaseName,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await control.pool.query('SELECT oid FROM pg_roles WHERE oid=$1 OR rolname=$2', [
          identity.roleOid,
          identity.roleName,
        ])
      ).rows,
    ).toEqual([]);
  }

  it.each(['idle', 'active'] as const)(
    'releases an owned %s checkout and coalesces repeated retirement',
    async (state) => {
      const fixture = await createTestDatabase(url());
      try {
        const held = await fixture.runtime.pool.connect();
        const pid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        const query =
          state === 'active'
            ? held.query('SELECT pg_sleep(30)').catch((error: unknown) => error)
            : undefined;
        if (query)
          await expect
            .poll(
              async () =>
                (
                  await control.pool.query<{ wait_event: string }>(
                    'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
                    [pid],
                  )
                ).rows[0]?.wait_event,
            )
            .toBe('PgSleep');
        const closing = fixture.close();
        expect(fixture.close()).toBe(closing);
        await closing;
        expect(fixture.runtime.pool.totalCount).toBe(0);
        if (query) expect(await query).toBeInstanceOf(Error);
        await expect(held.query('SELECT 1')).rejects.toBeInstanceOf(Error);
        await absent(fixture.identity);
      } finally {
        await fixture.close();
      }
    },
  );

  it('reports a pool cleanup failure but still retires the database, role and control connection', async () => {
    const fixture = await createTestDatabase(url());
    const original = fixture.runtime.close;
    const spy = vi.spyOn(fixture.runtime, 'close').mockImplementation(async () => {
      await original();
      throw new Error('Injected close failure');
    });
    let closing: Promise<void> | undefined;
    try {
      closing = fixture.close();
      await expect(closing).rejects.toMatchObject({
        failures: [{ stage: 'runtime_pool', code: 'UNKNOWN' }],
      });
      expect(fixture.close()).toBe(closing);
      await absent(fixture.identity);
    } finally {
      spy.mockRestore();
      if (closing) await closing.catch(() => {});
      else await fixture.close();
    }
  });

  it('retires a partially initialized fixture after the setup callback fails', async () => {
    const failure = new Error('Injected setup failure');
    let name = '';
    await expect(
      createTestDatabase(url(), {
        beforeMigrate: (_connection, endpoint) => {
          name = new URL(endpoint).pathname.slice(1);
          return Promise.reject(failure);
        },
      }),
    ).rejects.toBe(failure);
    expect(name).toMatch(/^beloveddev_test_[a-f0-9]{32}$/);
    expect(
      (await control.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows,
    ).toEqual([]);
    expect(
      (await control.pool.query('SELECT oid FROM pg_roles WHERE rolname=$1', [`${name}_runtime`]))
        .rows,
    ).toEqual([]);
  });

  it.each(['success', 'failure'] as const)(
    'settles and retires an unfinished %s setup before test teardown completes',
    async (outcome) => {
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let name = '';
      const setup = createTestDatabase(url(), {
        beforeMigrate: async (_connection, endpoint) => {
          name = new URL(endpoint).pathname.slice(1);
          entered();
          await gate;
          if (outcome === 'failure') throw new Error('Injected late setup failure');
        },
      });
      const observed = setup.catch((error: unknown) => error);
      await Promise.race([
        ready,
        setup.then(() => {
          throw new Error('Fixture completed without the setup barrier.');
        }),
      ]);
      const draining = finishPendingTestDatabases();
      const result = draining.catch((error: unknown) => error);
      release();
      if (outcome === 'failure') expect(await result).toBeInstanceOf(AggregateError);
      else await draining;
      await observed;
      expect(
        (await control.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows,
      ).toEqual([]);
      expect(
        (await control.pool.query('SELECT oid FROM pg_roles WHERE rolname=$1', [`${name}_runtime`]))
          .rows,
      ).toEqual([]);
    },
  );

  it('refuses a replacement role with the same name and a different recorded OID', async () => {
    const fixture = await createTestDatabase(url());
    const { roleName, roleOid, databaseName } = fixture.identity;
    const renamedName = `${roleName}_old`;
    let renamed = false;
    let replacementOid: number | undefined;
    let closing: Promise<void> | undefined;
    async function removeOwnedRole(name: string, oid: number | undefined) {
      if (oid === undefined) return;
      const actual = (
        await control.pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [
          name,
        ])
      ).rows[0];
      if (!actual) return;
      if (!/^beloveddev_test_[a-f0-9]{32}_runtime(?:_old)?$/.test(name) || actual.oid !== oid)
        throw new Error('Refusing unknown test role cleanup.');
      await control.pool.query(`DROP ROLE "${name}"`);
    }
    try {
      await control.pool.query(`ALTER ROLE "${roleName}" RENAME TO "${renamedName}"`);
      renamed = true;
      await control.pool.query(`CREATE ROLE "${roleName}" NOLOGIN`);
      replacementOid = (
        await control.pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [
          roleName,
        ])
      ).rows[0]?.oid;
      closing = fixture.close();
      await expect(closing).rejects.toBeInstanceOf(TestCleanupError);
      await expect(closing).rejects.toMatchObject({
        failures: [{ stage: 'role', code: 'UNKNOWN' }],
      });
      expect(
        (await control.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [databaseName]))
          .rows,
      ).toEqual([]);
      expect(
        (await control.pool.query('SELECT oid FROM pg_roles WHERE rolname=$1', [roleName])).rows,
      ).toEqual([{ oid: replacementOid }]);
    } finally {
      await cleanupTestResources([
        {
          stage: 'fixture',
          run: async () => {
            if (closing) await closing.catch(() => {});
            else await fixture.close();
          },
        },
        { stage: 'replacement_role', run: () => removeOwnedRole(roleName, replacementOid) },
        {
          stage: 'original_role',
          run: () => removeOwnedRole(renamed ? renamedName : roleName, roleOid),
        },
      ]);
    }
  });
});
