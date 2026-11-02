import {
  ReplayError,
  replayIdentitySchema,
  type ReplayDatabaseConfiguration,
  type ReplayOperation,
} from './evaluation-replay.js';
import {
  replayMigrations,
  replayConnection,
  REPLAY_MIGRATION_LOCK,
  replayTransaction,
  verifyReplayIdentity,
  verifyReplayLedger,
  verifyReplaySchema,
} from './evaluation-replay-policy.js';

export { replayConnection } from './evaluation-replay-policy.js';
export type { ReplayDatabaseConfiguration } from './evaluation-replay.js';

export function parseReplayMigrationEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): ReplayDatabaseConfiguration {
  const connectionString = input['EVALUATION_REPLAY_MIGRATION_URL'];
  if (!connectionString) throw new ReplayError('VALIDATION');
  const identity = replayIdentitySchema.safeParse({
    systemIdentifier: input['EVALUATION_REPLAY_SYSTEM_IDENTIFIER'],
    databaseOid: /^[1-9][0-9]*$/.test(input['EVALUATION_REPLAY_DATABASE_OID'] ?? '')
      ? Number(input['EVALUATION_REPLAY_DATABASE_OID'])
      : 0,
    marker: input['EVALUATION_REPLAY_MARKER'],
  });
  if (!identity.success) throw new ReplayError('VALIDATION');
  const tlsCa = input['EVALUATION_REPLAY_MIGRATION_TLS_CA'];
  const configuration = {
    connectionString,
    identity: identity.data,
    ...(tlsCa === undefined ? {} : { tlsCa }),
  };
  replayConnection(configuration);
  return Object.freeze(configuration);
}
/** Explicit admin entry only. One transaction includes every DDL statement and ledger row. */
export async function migrateReplayDatabase(
  configuration: ReplayDatabaseConfiguration,
  operation: ReplayOperation,
): Promise<void> {
  const { connection, identity, user, database } = replayConnection(configuration);
  const expected = replayMigrations().migrations;
  await replayTransaction(
    connection,
    operation,
    async (client) => {
      await verifyReplayIdentity(client, identity, database, user);
      await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [
        ...REPLAY_MIGRATION_LOCK,
      ]);
      await verifyReplayLedger(client, false);
      const existing = await client.query<{ ledger: string | null; schema: string | null }>(
        "SELECT to_regclass('evaluation_replay_migrations.__drizzle_migrations')::text ledger,to_regnamespace('evaluation_replay')::text schema",
      );
      if (!existing.rows[0]?.ledger && existing.rows[0]?.schema) throw new ReplayError('SCHEMA');
      await client.query('CREATE SCHEMA IF NOT EXISTS evaluation_replay_migrations');
      await client.query(`CREATE TABLE IF NOT EXISTS evaluation_replay_migrations.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)`);
      const applied = await client.query(
        'SELECT id FROM evaluation_replay_migrations.__drizzle_migrations',
      );
      for (const migration of expected.slice(applied.rowCount ?? 0)) {
        for (const statement of migration.sql) await client.query(statement);
        const recorded = await client.query(
          'INSERT INTO evaluation_replay_migrations.__drizzle_migrations(hash,created_at) VALUES ($1,$2)',
          [migration.hash, migration.folderMillis],
        );
        if (recorded.rowCount !== 1) throw new ReplayError('SCHEMA');
      }
      await client.query('REVOKE ALL ON SCHEMA evaluation_replay_migrations FROM PUBLIC');
      await client.query(
        'REVOKE ALL ON ALL TABLES IN SCHEMA evaluation_replay_migrations FROM PUBLIC',
      );
      await verifyReplaySchema(client);
      await verifyReplayIdentity(client, identity, database, user);
    },
    30000,
  );
}
