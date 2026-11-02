import { databaseConnectionConfig } from './connection-policy.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Socket } from 'node:net';
import { Client, type ClientBase, type ClientConfig } from 'pg';
import {
  ReplayError,
  replayIdentitySchema,
  type ReplayDatabaseConfiguration,
  type ReplayIdentity,
  type ReplayOperation,
} from './evaluation-replay.js';

export const REPLAY_MIGRATION_LOCK = [0x42444556, 2] as const;
export const REPLAY_SCHEMA_SHA256 =
  '2ba0d926c579833a5b5b4ee00f882bbb30c7d79f0fe8d04848bd2ae19d065ede';
export function replayMigrations() {
  try {
    const migrationsFolder = fileURLToPath(
      new URL('../evaluation-replay-migrations/', import.meta.url),
    );
    const migrations = readMigrationFiles({ migrationsFolder });
    if (!migrations.length) throw new ReplayError('SCHEMA');
    return { migrationsFolder, migrations };
  } catch {
    throw new ReplayError('SCHEMA');
  }
}
export async function verifyReplayLedger(client: ClientBase, complete: boolean) {
  const expected = replayMigrations().migrations;
  const exists = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('evaluation_replay_migrations.__drizzle_migrations')::text AS relation",
  );
  if (exists.rows[0]?.relation === null && !complete) return;
  if (!exists.rows[0]?.relation) throw new ReplayError('SCHEMA');
  const actual = await client.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at FROM evaluation_replay_migrations.__drizzle_migrations ORDER BY created_at,id',
  );
  if (
    actual.rows.length > expected.length ||
    (complete && actual.rows.length !== expected.length) ||
    actual.rows.some(
      (row, i) =>
        row.hash !== expected[i]?.hash || row.created_at !== String(expected[i]?.folderMillis),
    )
  )
    throw new ReplayError('SCHEMA');
}
export async function verifyReplayIdentity(
  client: ClientBase,
  identity: ReplayIdentity,
  database: string,
  user: string,
) {
  const result = await client.query<{ matches: boolean; durable: boolean; writable: boolean }>(
    `SELECT current_database()=$1 AND current_user::text=$2 AND session_user::text=$2
      AND (SELECT system_identifier::text FROM pg_control_system())=$3
      AND d.oid=$4::oid AND shobj_description(d.oid,'pg_database')=$5
      AND current_setting('server_version_num')::int/10000=18 AS matches,
      current_setting('fsync')='on' AND current_setting('full_page_writes')='on'
      AND current_setting('synchronous_commit')='on' AS durable,
      NOT pg_is_in_recovery() AND current_setting('default_transaction_read_only')='off' AS writable
      FROM pg_database d WHERE d.datname=current_database()`,
    [
      database,
      user,
      identity.systemIdentifier,
      identity.databaseOid,
      'beloveddev.evaluation-replay:' + identity.marker,
    ],
  );
  if (result.rows[0]?.matches !== true) throw new ReplayError('IDENTITY');
  if (!result.rows[0].writable) throw new ReplayError('IDENTITY');
  if (!result.rows[0].durable) throw new ReplayError('DURABILITY');
}
export const replaySchemaQuery = `
SELECT jsonb_build_object(
  'relations', (SELECT jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,
    'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid),a.attcollation::regcollation::text) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype,pg_get_constraintdef(k.oid),
      k.convalidated,k.condeferrable,k.condeferred) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(i.relname,pg_get_indexdef(x.indexrelid),x.indisvalid,x.indisready)
      ORDER BY i.relname) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
    'rules',(SELECT jsonb_agg(jsonb_build_array(pg_get_ruledef(r.oid),r.ev_enabled) ORDER BY r.rulename)
      FROM pg_rewrite r WHERE r.ev_class=c.oid)
  ) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('evaluation_replay','evaluation_replay_migrations') AND c.relkind IN ('r','p','v','m','f')),
  'routines',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='evaluation_replay'),
  'types',(SELECT jsonb_agg(jsonb_build_array(t.typname,t.typtype) ORDER BY t.typname)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='evaluation_replay' AND t.typtype NOT IN ('c','b'))
)::text AS manifest`;
export async function verifyReplaySchema(client: ClientBase) {
  await verifyReplayLedger(client, true);
  const result = await client.query<{ manifest: string }>(replaySchemaQuery);
  if (
    createHash('sha256')
      .update(result.rows[0]?.manifest ?? '')
      .digest('hex') !== REPLAY_SCHEMA_SHA256
  )
    throw new ReplayError('SCHEMA');
}

/** Includes inherited/PUBLIC and column privileges, SET ROLE paths and catalog ACL changes. */
export const replayPrivilegesQuery = `
WITH roles AS (
  SELECT * FROM pg_roles WHERE rolname IN (current_user,session_user) OR pg_has_role(session_user,oid,'MEMBER')
), schemas AS (
  SELECT * FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema'
), relations AS (
  SELECT c.*,n.nspname FROM pg_class c JOIN schemas n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S')
), allowed AS (
  SELECT * FROM (VALUES
    ('evaluation_replay','invocations',true,true,ARRAY['status','started_at','closed_at','outcome','last_turn_number']),
    ('evaluation_replay','identifiers',true,true,ARRAY[]::text[]),
    ('evaluation_replay','turns',true,true,ARRAY['stage','claimed_at','prepared_at','consumed_at','retired_at','permit_id','reservation_id','raw_body_digest','output_cap']),
    ('evaluation_replay_migrations','__drizzle_migrations',true,false,ARRAY[]::text[])
  ) a(schema_name,table_name,can_read,can_insert,updates)
), tables AS (
  SELECT c.*,coalesce(a.can_read,false) can_read,coalesce(a.can_insert,false) can_insert,coalesce(a.updates,ARRAY[]::text[]) updates
  FROM relations c LEFT JOIN allowed a ON a.schema_name=c.nspname AND a.table_name=c.relname WHERE c.relkind<>'S'
), routines AS (
  SELECT p.* FROM pg_proc p JOIN schemas n ON n.oid=p.pronamespace
), system_schemas AS (
  SELECT oid,nspname FROM pg_namespace WHERE left(nspname,3)='pg_' OR nspname='information_schema'
), system_grants AS (
  SELECT a.*,coalesce(i.initprivs,CASE WHEN n.nspname='information_schema' THEN ARRAY[makeaclitem(0,c.relowner,'SELECT',false)]
    ELSE acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char",c.relowner) END) initial_acl,false identity_probe
  FROM pg_class c JOIN system_schemas n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_class'::regclass AND i.objoid=c.oid AND i.objsubid=0 WHERE c.relkind IN ('r','p','v','m','f','S')
  UNION ALL
  SELECT a.*,coalesce(i.initprivs,'{}'::aclitem[]) || coalesce(t.initprivs,CASE WHEN n.nspname='information_schema'
    THEN ARRAY[makeaclitem(0,c.relowner,'SELECT',false)] ELSE acldefault('r',c.relowner) END),false
  FROM pg_class c JOIN system_schemas n ON n.oid=c.relnamespace JOIN pg_attribute col ON col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
  CROSS JOIN LATERAL aclexplode(col.attacl) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_class'::regclass AND i.objoid=c.oid AND i.objsubid=col.attnum
  LEFT JOIN pg_init_privs t ON t.classoid='pg_class'::regclass AND t.objoid=c.oid AND t.objsubid=0
  UNION ALL
  SELECT a.*,coalesce(i.initprivs,acldefault('f',p.proowner)),p.oid='pg_catalog.pg_control_system()'::regprocedure
  FROM pg_proc p JOIN system_schemas n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_proc'::regclass AND i.objoid=p.oid AND i.objsubid=0
)
SELECT (
  current_user<>session_user OR EXISTS (SELECT FROM roles WHERE rolname<>current_user OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  OR EXISTS (SELECT FROM pg_auth_members m JOIN roles r ON r.oid=m.member WHERE m.admin_option)
  OR EXISTS (SELECT FROM roles r JOIN pg_database d ON d.datname=current_database() WHERE d.datdba=r.oid
    OR has_database_privilege(r.oid,d.oid,'CREATE') OR has_database_privilege(r.oid,d.oid,'TEMPORARY') OR has_database_privilege(r.oid,d.oid,'CONNECT WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN pg_namespace n WHERE n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE') OR has_schema_privilege(r.oid,n.oid,'USAGE WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r JOIN pg_class c ON c.relowner=r.oid)
  OR EXISTS (SELECT FROM roles r JOIN pg_type t ON t.typowner=r.oid)
  OR EXISTS (SELECT FROM system_grants a WHERE (a.grantee=0 OR a.grantee IN (SELECT oid FROM roles)) AND
    (a.is_grantable OR (NOT (a.identity_probe AND a.privilege_type='EXECUTE' AND a.grantee IN (SELECT oid FROM roles)) AND NOT EXISTS
      (SELECT FROM aclexplode(a.initial_acl) b WHERE b.grantee=0 AND b.privilege_type=a.privilege_type))))
  OR EXISTS (SELECT FROM roles r CROSS JOIN routines p WHERE p.proowner=r.oid OR (p.prosecdef AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
    OR has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION')
    OR (has_function_privilege(r.oid,p.oid,'EXECUTE') AND p.oid NOT IN ('evaluation_replay.guard_write()'::regprocedure,'evaluation_replay.check_coverage()'::regprocedure)))
  OR EXISTS (SELECT FROM roles r CROSS JOIN tables c CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(priv)
    WHERE (has_table_privilege(r.oid,c.oid,v.priv) AND NOT ((v.priv='SELECT' AND c.can_read) OR (v.priv='INSERT' AND c.can_insert)))
      OR has_table_privilege(r.oid,c.oid,v.priv || ' WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN tables c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(priv)
    WHERE (has_column_privilege(r.oid,c.oid,a.attnum,v.priv) AND NOT ((v.priv='SELECT' AND c.can_read) OR (v.priv='INSERT' AND c.can_insert)
      OR (v.priv='UPDATE' AND a.attname=ANY(c.updates)))) OR has_column_privilege(r.oid,c.oid,a.attnum,v.priv || ' WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN relations c CROSS JOIN (VALUES ('USAGE'),('SELECT'),('UPDATE')) v(priv)
    WHERE c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,v.priv))
) unsafe, (
  NOT has_database_privilege(current_database(),'CONNECT')
  OR NOT has_schema_privilege('evaluation_replay','USAGE') OR NOT has_schema_privilege('evaluation_replay_migrations','USAGE')
  OR NOT has_function_privilege('pg_catalog.pg_control_system()','EXECUTE')
  OR EXISTS (SELECT FROM allowed a WHERE (a.can_read AND NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'SELECT'))
    OR (a.can_insert AND NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'INSERT'))
    OR EXISTS (SELECT FROM unnest(a.updates) col WHERE NOT has_column_privilege(format('%I.%I',a.schema_name,a.table_name),col,'UPDATE')))
) missing`;
export async function verifyReplayPrivileges(client: ClientBase) {
  const result = await client.query<{ unsafe: boolean; missing: boolean }>(replayPrivilegesQuery);
  if (result.rows[0]?.unsafe !== false || result.rows[0].missing !== false)
    throw new ReplayError('PRIVILEGES');
}

export function replayFailure(error: unknown, committing = false): ReplayError {
  if (error instanceof ReplayError) return error;
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === '23505') return new ReplayError('DUPLICATE');
  if (code === '23503') return new ReplayError('BINDING');
  if (code === '23514') return new ReplayError('STATE');
  if (committing) return new ReplayError('COMMIT_UNKNOWN');
  if (code === '42501') return new ReplayError('PRIVILEGES');
  if (code === '57014' || code === '55P03' || code === '25P04') return new ReplayError('TIMEOUT');
  if (code === '42P01' || code === '3F000' || code === '42883') return new ReplayError('SCHEMA');
  return new ReplayError('UNAVAILABLE');
}
/** Dedicated physical session: bounded connect/work/commit/cleanup, no retries. */
export async function replayTransaction(
  config: ClientConfig,
  operation: ReplayOperation,
  work: (client: Client) => Promise<void>,
  maximumMs = 5000,
): Promise<void> {
  const remaining = Math.min(maximumMs, operation.deadlineAt - performance.now());
  if (!Number.isFinite(remaining) || remaining <= 0 || operation.signal?.aborted)
    throw new ReplayError('TIMEOUT');
  const socket = new Socket();
  const client = new Client({
    ...config,
    stream: () => socket,
    connectionTimeoutMillis: Math.max(1, Math.floor(remaining)),
    statement_timeout: Math.max(1, Math.floor(remaining)),
    lock_timeout: Math.max(1, Math.floor(Math.min(1000, remaining))),
    options: `-c search_path=pg_catalog -c transaction_timeout=${Math.max(1, Math.floor(remaining))}`,
    pipeline: false,
  });
  let committing = false,
    closing = false;
  let failure: ReplayError | undefined;
  let rejectFatal: (failure: ReplayError) => void = () => {};
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => {});
  const stop = (category: 'TIMEOUT' | 'UNAVAILABLE') => {
    failure ??= new ReplayError(committing ? 'COMMIT_UNKNOWN' : category);
    socket.destroy();
    rejectFatal(failure);
  };
  client.on('error', () => stop('UNAVAILABLE'));
  client.on('end', () => {
    if (!closing) stop('UNAVAILABLE');
  });
  client.connection.on('errorMessage', (error: unknown) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '25P04')
      stop('TIMEOUT');
  });
  const abort = () => stop('TIMEOUT');
  operation.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, remaining);
  const check = () => {
    if (failure) throw failure;
    if (performance.now() >= operation.deadlineAt) throw new ReplayError('TIMEOUT');
  };
  try {
    await Promise.race([
      (async () => {
        check();
        await client.connect();
        check();
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await work(client);
        check();
        await client.query("SET LOCAL synchronous_commit='on'");
        committing = true;
        await client.query('COMMIT');
        committing = false;
        check();
      })(),
      fatal,
    ]);
  } catch (error: unknown) {
    failure ??= replayFailure(error, committing);
    socket.destroy();
  } finally {
    closing = true;
    clearTimeout(timer);
    operation.signal?.removeEventListener('abort', abort);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.end(),
        new Promise<never>((_resolve, reject) => {
          cleanupTimer = setTimeout(() => {
            socket.destroy();
            reject(new ReplayError('CLEANUP'));
          }, 5000);
        }),
      ]);
    } catch {
      failure ??= new ReplayError('CLEANUP');
      socket.destroy();
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
  if (failure) throw failure;
  if (performance.now() >= operation.deadlineAt) throw new ReplayError('TIMEOUT');
}

export function replayConnection(configuration: ReplayDatabaseConfiguration) {
  try {
    const identity = replayIdentitySchema.parse(configuration.identity);
    if (
      configuration.tlsCa !== undefined &&
      (!configuration.tlsCa.length || configuration.tlsCa.length > 65536)
    )
      throw new ReplayError('VALIDATION');
    const connection = databaseConnectionConfig(
      configuration.connectionString,
      configuration.tlsCa,
    );
    if (typeof connection.user !== 'string' || typeof connection.database !== 'string')
      throw new ReplayError('VALIDATION');
    return {
      connection: { ...connection, application_name: 'beloveddev-evaluation-replay' },
      identity,
      user: connection.user,
      database: connection.database,
    };
  } catch {
    throw new ReplayError('VALIDATION');
  }
}
