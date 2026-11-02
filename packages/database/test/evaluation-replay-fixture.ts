import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase, type DatabaseConnection } from '../src/client.js';
import {
  migrateReplayDatabase,
  type ReplayDatabaseConfiguration,
} from '../src/evaluation-replay-migrate.js';
import { openReplayStore } from '../src/evaluation-replay-postgres.js';
import type {
  ReplayAdmission,
  ReplayBinding,
  ReplayOperation,
  ReplayStore,
  ReplayTurn,
  ReplayPermit,
} from '../src/evaluation-replay.js';
import { cleanupTestResources } from '@beloveddev/test-support/test-database';

export const operation = (ms = 5000): ReplayOperation => ({ deadlineAt: performance.now() + ms });
export function binding(admission: ReplayAdmission): ReplayBinding {
  const {
    invocationId,
    approvalId,
    executionId,
    approvalDigest,
    ownerKeyFingerprint,
    fixtureManifestDigest,
    scenarioSetDigest,
    scenarioId,
    model,
    compatibilityProfile,
    planDigest,
  } = admission;
  return {
    invocationId,
    approvalId,
    executionId,
    approvalDigest,
    ownerKeyFingerprint,
    fixtureManifestDigest,
    scenarioSetDigest,
    scenarioId,
    model,
    compatibilityProfile,
    planDigest,
  };
}
export function admission(ttl = 60000): ReplayAdmission {
  return {
    invocationId: randomUUID(),
    approvalId: randomUUID(),
    executionId: randomUUID(),
    approvalDigest: 'a'.repeat(64),
    ownerKeyFingerprint: 'b'.repeat(64),
    fixtureManifestDigest: 'c'.repeat(64),
    scenarioSetDigest: 'd'.repeat(64),
    scenarioId: 'evidence_retrieval',
    model: 'gpt-4.1-mini-2025-04-14',
    compatibilityProfile: 'gpt41-mini-text-v1-2026-10-29',
    planDigest: 'e'.repeat(64),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    pricingVerifiedAt: new Date(Date.now() - 2000).toISOString(),
    maxCalls: 2,
    maxInputTokensPerCall: 1024,
    maxOutputTokensPerCall: 128,
    maxTotalTokens: 4096,
    maxPlannedCostMicroUsd: 1000000,
  };
}
export function turn(turnNumber = 1): ReplayTurn {
  return {
    turnId: randomUUID(),
    turnNumber,
    requestDigest: '1'.repeat(64),
    transcriptDigest: '2'.repeat(64),
    toolDigest: '3'.repeat(64),
    runnerBodyDigest: '4'.repeat(64),
    digestVersion: 'json-stringify-v1',
  };
}
export function permit(): ReplayPermit {
  return {
    permitId: randomUUID(),
    reservationId: randomUUID(),
    rawBodyDigest: '5'.repeat(64),
    outputCap: 64,
  };
}
/** Separate control schema; never calls the application migrator or reuses an existing database. */
export async function createReplayFixture(
  administratorUrl: string,
  options: {
    beforeMigrate?: (
      admin: DatabaseConnection,
      configuration: ReplayDatabaseConfiguration,
    ) => Promise<void>;
  } = {},
) {
  const name = 'beloveddev_replay_' + randomUUID().replaceAll('-', '');
  const role = name + '_runtime',
    password = randomUUID().replaceAll('-', ''),
    marker = randomUUID();
  const source = new URL(administratorUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname) ||
    !source.port ||
    source.search ||
    source.hash
  )
    throw new Error('Replay tests require an explicit local synthetic cluster.');
  source.pathname = '/postgres';
  const pools: DatabaseConnection[] = [];
  const acquired = new Map<DatabaseConnection, Set<PoolClient>>();
  let closing = false,
    failed = false;
  const connect = (url: string) => {
    const database = openDatabase(url, {
      maxConnections: 2,
      onIdleError: () => {
        if (!closing) failed = true;
      },
    });
    const held = new Set<PoolClient>();
    database.pool.on('acquire', (client) => held.add(client));
    database.pool.on('release', (_error, client) => held.delete(client));
    acquired.set(database, held);
    pools.push(database);
    return database;
  };
  async function closePool(pool: DatabaseConnection) {
    const ended = pool.close();
    void ended.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await cleanupTestResources([
        ...[...(acquired.get(pool) ?? [])].map((client) => ({
          stage: 'held_client',
          run: () => client.release(true),
        })),
        {
          stage: 'pool_end',
          run: () =>
            Promise.race([
              ended,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Owned replay pool cleanup deadline.')),
                  5000,
                );
              }),
            ]),
        },
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const control = connect(source.href);
  let databaseCreated = false,
    roleCreated = false,
    databaseOid: number | undefined,
    roleOid: number | undefined,
    ownerOid: number | undefined;
  const stores = new Set<ReplayStore>();
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      closing = true;
      await cleanupTestResources([
        ...[...stores].map((store) => ({ stage: 'store', run: () => store.close() })),
        ...pools
          .filter((p) => p !== control)
          .map((pool) => ({ stage: 'owned_pool', run: () => closePool(pool) })),
        {
          stage: 'database',
          run: async () => {
            if (!databaseCreated) return;
            const actual = await control.pool.query<{
              oid: number;
              datdba: number;
              marker: string | null;
            }>(
              "SELECT oid,datdba,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",
              [name],
            );
            if (
              !/^beloveddev_replay_[a-f0-9]{32}$/.test(name) ||
              actual.rows[0]?.oid !== databaseOid ||
              actual.rows[0]?.datdba !== ownerOid ||
              actual.rows[0]?.marker !== 'beloveddev.evaluation-replay:' + marker
            )
              throw new Error('Refusing unverified replay database retirement.');
            await control.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          },
        },
        {
          stage: 'role',
          run: async () => {
            if (!roleCreated) return;
            const actual = await control.pool.query<{ oid: number }>(
              'SELECT oid FROM pg_roles WHERE rolname=$1',
              [role],
            );
            if (!roleOid || actual.rows[0]?.oid !== roleOid || role !== name + '_runtime')
              throw new Error('Refusing unverified replay role retirement.');
            await control.pool.query(`DROP ROLE "${role}"`);
          },
        },
        { stage: 'control', run: () => closePool(control) },
        {
          stage: 'pool_health',
          run: () => {
            if (failed) throw new Error('Replay fixture pool failed.');
          },
        },
      ]);
    })());
  try {
    const trusted = await control.pool.query<{
      identifier: string;
      marker: string | null;
      owner_oid: number;
      version: number;
    }>(
      "SELECT system_identifier::text identifier,shobj_description(d.oid,'pg_database') marker,(SELECT oid FROM pg_roles WHERE rolname=current_user) owner_oid,current_setting('server_version_num')::int/10000 version FROM pg_control_system() CROSS JOIN pg_database d WHERE d.datname=current_database()",
    );
    const row = trusted.rows[0];
    if (
      !row ||
      row.version !== 18 ||
      row.identifier !== process.env['TEST_CLUSTER_SYSTEM_IDENTIFIER'] ||
      row.marker !== 'beloveddev.synthetic-evaluation-cluster:' + process.env['TEST_CLUSTER_MARKER']
    )
      throw new Error('Unapproved replay test cluster.');
    ownerOid = row.owner_oid;
    await control.pool.query(`CREATE DATABASE "${name}"`);
    databaseCreated = true;
    databaseOid = (
      await control.pool.query<{ oid: number }>('SELECT oid FROM pg_database WHERE datname=$1', [
        name,
      ])
    ).rows[0]?.oid;
    // Install the marker immediately so failed later setup can still retire only its own database.
    await control.pool.query(
      `COMMENT ON DATABASE "${name}" IS 'beloveddev.evaluation-replay:${marker}'`,
    );
    await control.pool.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
    );
    roleCreated = true;
    roleOid = (
      await control.pool.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [role])
    ).rows[0]?.oid;
    source.pathname = '/' + name;
    const admin = connect(source.href);
    if (!databaseOid || !roleOid) throw new Error('Missing replay fixture identity.');
    const migration = {
      connectionString: source.href,
      identity: { systemIdentifier: row.identifier, databaseOid, marker },
    };
    await options.beforeMigrate?.(admin, migration);
    await migrateReplayDatabase(migration, operation(30000));
    await admin.pool.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await admin.pool.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    await admin.pool.query(
      `GRANT USAGE ON SCHEMA evaluation_replay,evaluation_replay_migrations TO "${role}"`,
    );
    await admin.pool.query(
      `GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA evaluation_replay TO "${role}"`,
    );
    await admin.pool.query(
      `GRANT SELECT ON evaluation_replay_migrations.__drizzle_migrations TO "${role}"`,
    );
    await admin.pool.query(
      `GRANT UPDATE(status,started_at,closed_at,outcome,last_turn_number) ON evaluation_replay.invocations TO "${role}"`,
    );
    await admin.pool.query(
      `GRANT UPDATE(stage,claimed_at,prepared_at,consumed_at,retired_at,permit_id,reservation_id,raw_body_digest,output_cap) ON evaluation_replay.turns TO "${role}"`,
    );
    await admin.pool.query(
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),evaluation_replay.guard_write(),evaluation_replay.check_coverage() TO "${role}"`,
    );
    source.username = role;
    source.password = password;
    const configuration: ReplayDatabaseConfiguration = {
      connectionString: source.href,
      identity: migration.identity,
    };
    const runtime = connect(source.href);
    return {
      admin,
      runtime,
      configuration,
      migration,
      name,
      role,
      stores,
      close,
      async open() {
        const store = await openReplayStore(configuration, operation());
        stores.add(store);
        return store;
      },
    };
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanup: unknown) {
      throw new AggregateError([error, cleanup], 'Replay fixture setup and cleanup failed.', {
        cause: cleanup,
      });
    }
    throw error;
  }
}
export type ReplayFixture = Awaited<ReturnType<typeof createReplayFixture>>;
