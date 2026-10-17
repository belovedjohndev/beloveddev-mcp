import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import { assertRuntimeDatabaseReady } from '../src/readiness.js';
import { openDatabase } from '../src/client.js';

describe('runtime database security and schema readiness', () => {
  let database: TestDatabase;
  let role: string;
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
    role = new URL(database.runtimeUrl).username;
    if (!/^beloveddev_test_[0-9a-f]{32}_runtime$/.test(role))
      throw new Error('Unexpected test role');
  });
  afterAll(async () => {
    await database.close();
  });

  it('accepts the exact grants needed by all eight tools and returns the pool client', async () => {
    await assertRuntimeDatabaseReady(database.runtime.pool);
    expect(database.runtime.pool.idleCount).toBe(1);
    const result = await database.runtime.pool.query<{ search_path: string }>('SHOW search_path');
    expect(result.rows[0]?.search_path).toBe('public');
  });

  it('preserves column-limited tenant and user reads without audit-content access', async () => {
    await assertRuntimeDatabaseReady(database.runtime.pool);
    for (const table of ['tenants', 'users']) {
      await expect(
        database.runtime.pool.query(`SELECT id, status FROM ${table} LIMIT 1`),
      ).resolves.toBeDefined();
      await expect(
        database.runtime.pool.query(`SELECT * FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      database.runtime.pool.query('SELECT * FROM audit_logs LIMIT 1'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['database', 'user'] as const)(
    'rejects a connected %s identity that differs from client configuration',
    async (field) => {
      const connection = openDatabase(database.runtimeUrl, { onIdleError: () => {} });
      // Simulate a routing/configuration mismatch in the client's expected identity.
      // PostgreSQL still returns its real database/session/current-role identities.
      connection.pool.once('acquire', (client: PoolClient) => {
        client[field] = 'private-unexpected-identity';
      });
      try {
        await expect(assertRuntimeDatabaseReady(connection.pool)).rejects.toMatchObject({
          category: 'IDENTITY',
          message: 'Database operational readiness failed.',
        });
        expect(connection.pool.totalCount).toBe(0);
      } finally {
        await connection.close();
      }
    },
  );

  it('rejects administrator credentials', async () => {
    await expect(assertRuntimeDatabaseReady(database.admin.pool)).rejects.toMatchObject({
      category: 'UNSAFE_PRIVILEGES',
    });
  });

  it('rejects a database configured for read-only application transactions', async () => {
    const name = new URL(database.runtimeUrl).pathname.slice(1);
    await database.admin.pool.query(
      `ALTER DATABASE "${name}" SET default_transaction_read_only=on`,
    );
    const connection = openDatabase(database.runtimeUrl, { onIdleError: () => {} });
    try {
      await expect(assertRuntimeDatabaseReady(connection.pool)).rejects.toMatchObject({
        category: 'READ_ONLY',
      });
    } finally {
      await connection.close();
      await database.admin.pool.query(
        `ALTER DATABASE "${name}" RESET default_transaction_read_only`,
      );
    }
  });

  it.each(['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS'])(
    'rejects dangerous role attribute %s',
    async (attribute) => {
      await database.admin.pool.query(`ALTER ROLE "${role}" ${attribute}`);
      try {
        await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
          category: 'UNSAFE_PRIVILEGES',
        });
      } finally {
        await database.admin.pool.query(`ALTER ROLE "${role}" NO${attribute}`);
      }
    },
  );

  it.each([
    ['UPDATE ON projects', 'UPDATE ON projects'],
    ['DELETE ON projects', 'DELETE ON projects'],
    ['TRUNCATE ON projects', 'TRUNCATE ON projects'],
    ['INSERT ON projects', 'INSERT ON projects'],
    ['SELECT ON audit_logs', 'SELECT ON audit_logs'],
    ['SELECT (email) ON users', 'SELECT (email) ON users'],
    ['UPDATE (status) ON tenants', 'UPDATE (status) ON tenants'],
    ['CREATE ON SCHEMA public', 'CREATE ON SCHEMA public'],
    ['CREATE ON SCHEMA pg_catalog', 'CREATE ON SCHEMA pg_catalog'],
    ['SELECT ON pg_catalog.pg_authid', 'SELECT ON pg_catalog.pg_authid'],
    [
      'SELECT (umoptions) ON pg_catalog.pg_user_mapping',
      'SELECT (umoptions) ON pg_catalog.pg_user_mapping',
    ],
    ['UPDATE ON pg_catalog.pg_class', 'UPDATE ON pg_catalog.pg_class'],
    [
      'EXECUTE ON FUNCTION pg_catalog.pg_read_file(text)',
      'EXECUTE ON FUNCTION pg_catalog.pg_read_file(text)',
    ],
  ])('rejects excess or delegatable privilege %s', async (grant, revoke) => {
    await database.admin.pool.query(`GRANT ${grant} TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE ${revoke} FROM "${role}"`);
    }
  });

  it('rejects grant options on otherwise permitted table access', async () => {
    await database.admin.pool.query(`GRANT SELECT ON projects TO "${role}" WITH GRANT OPTION`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE GRANT OPTION FOR SELECT ON projects FROM "${role}"`);
    }
  });

  it('rejects delegatable schema access', async () => {
    await database.admin.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}" WITH GRANT OPTION`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(
        `REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM "${role}"`,
      );
    }
  });

  it('rejects ambient PUBLIC temporary-object privilege', async () => {
    const name = new URL(database.runtimeUrl).pathname.slice(1);
    await database.admin.pool.query(`GRANT TEMPORARY ON DATABASE "${name}" TO PUBLIC`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
    }
  });

  it('rejects database CREATE and database ownership', async () => {
    const name = new URL(database.runtimeUrl).pathname.slice(1);
    await database.admin.pool.query(`GRANT CREATE ON DATABASE "${name}" TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE CREATE ON DATABASE "${name}" FROM "${role}"`);
    }
    await database.admin.pool.query(`ALTER DATABASE "${name}" OWNER TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`ALTER DATABASE "${name}" OWNER TO CURRENT_USER`);
    }
  });

  it('rejects sequence privileges and excess PUBLIC grants', async () => {
    await database.admin.pool.query(
      `GRANT USAGE ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO "${role}"`,
    );
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(
        `REVOKE USAGE ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "${role}"`,
      );
    }
    await database.admin.pool.query('GRANT UPDATE ON projects TO PUBLIC');
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query('REVOKE UPDATE ON projects FROM PUBLIC');
    }
  });

  it('rejects a dangerous system-catalog grant through PUBLIC', async () => {
    await database.admin.pool.query('GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC');
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query('REVOKE SELECT ON pg_catalog.pg_authid FROM PUBLIC');
    }
  });

  it('does not mistake a user schema starting with pg for a system schema', async () => {
    await database.admin.pool.query(`CREATE SCHEMA pgx_test AUTHORIZATION "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query('DROP SCHEMA pgx_test');
    }
  });

  it('rejects a NOINHERIT predefined-role membership', async () => {
    await database.admin.pool.query(`GRANT pg_read_all_data TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE pg_read_all_data FROM "${role}"`);
    }
  });

  it('rejects a NOINHERIT path to an administrator-owned role', async () => {
    const admin = new URL(parseTestDatabaseUrl(process.env)).username;
    // Role names from configuration are escaped as identifiers, never interpolated raw.
    const identifier = '"' + decodeURIComponent(admin).replaceAll('"', '""') + '"';
    await database.admin.pool.query(`GRANT ${identifier} TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`REVOKE ${identifier} FROM "${role}"`);
    }
  });

  it.each([
    'INSERT ON project_notes',
    'INSERT ON audit_logs',
    'SELECT ON projects',
    'SELECT ON drizzle.__drizzle_migrations',
    'USAGE ON SCHEMA drizzle',
  ])('rejects missing required grant %s', async (grant) => {
    await database.admin.pool.query(`REVOKE ${grant} FROM "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'MISSING_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query(`GRANT ${grant} TO "${role}"`);
    }
  });

  it('rejects runtime table ownership', async () => {
    await database.admin.pool.query(`ALTER TABLE projects OWNER TO "${role}"`);
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query('ALTER TABLE projects OWNER TO CURRENT_USER');
      await database.admin.pool.query(`GRANT SELECT ON projects TO "${role}"`);
    }
  });

  it('rejects callable security-definer functions', async () => {
    await database.admin.pool.query(
      "CREATE FUNCTION public.test_escalation() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
    );
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'UNSAFE_PRIVILEGES',
      });
    } finally {
      await database.admin.pool.query('DROP FUNCTION public.test_escalation()');
    }
  });

  it('rejects a modified migration ledger', async () => {
    await database.admin.pool.query(
      "UPDATE drizzle.__drizzle_migrations SET hash='tampered' WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)",
    );
    try {
      await expect(assertRuntimeDatabaseReady(database.runtime.pool)).rejects.toMatchObject({
        category: 'SCHEMA',
      });
    } finally {
      const { readMigrationFiles } = await import('drizzle-orm/migrator');
      const { fileURLToPath } = await import('node:url');
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
      });
      await database.admin.pool.query(
        'UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE id=(SELECT max(id) FROM drizzle.__drizzle_migrations)',
        [migrations.at(-1)?.hash],
      );
    }
  });

  it.each([
    'DROP TABLE opportunities',
    'ALTER TABLE opportunities DROP COLUMN project_type',
    'ALTER TABLE project_notes DROP CONSTRAINT project_notes_tenant_project_fk',
    'ALTER TABLE project_notes DROP CONSTRAINT project_notes_tenant_author_idempotency_unique',
    'ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_tenant_note_actor_fk',
    'ALTER TABLE projects DROP CONSTRAINT projects_slug_format',
    'ALTER TABLE projects ALTER COLUMN name DROP NOT NULL',
    'DROP INDEX projects_tenant_status_idx',
  ])('rejects structural schema drift: %s', async (statement) => {
    // Disposable databases expose committed drift without leaking catalog changes.
    const isolated = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    try {
      await isolated.admin.pool.query(statement);
      await expect(assertRuntimeDatabaseReady(isolated.runtime.pool)).rejects.toMatchObject({
        category: 'SCHEMA',
      });
    } finally {
      await isolated.close();
    }
  });

  it('still accepts the restricted role after every rejected configuration is restored', async () => {
    await assertRuntimeDatabaseReady(database.runtime.pool);
  });
});
