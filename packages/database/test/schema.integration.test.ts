import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '@beloveddev/database/migrate';
import {
  clients,
  developerProfiles,
  projects,
  tenantMemberships,
  tenants,
  users,
} from '@beloveddev/database/schema';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const tables = [tenants, users, tenantMemberships, developerProfiles, clients, projects];

async function schemaSignature(database: TestDatabase) {
  const columns = await database.admin.pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    "SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
  );
  const indexes = await database.admin.pool.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  );
  const constraints = await database.admin.pool.query<{ conname: string; definition: string }>(
    "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname",
  );
  return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
}

describe('real PostgreSQL migration and constraints', () => {
  let database: TestDatabase;
  let fixtures: TenantFixtures;
  let initiallyEmpty: boolean;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    const result = await database.admin.pool.query<{ count: number }>(
      'SELECT (SELECT count(*) FROM tenants)::int AS count',
    );
    initiallyEmpty = result.rows[0]?.count === 0;
  });
  beforeEach(async () => {
    fixtures = await seedTwoTenants(database.admin.db);
  });
  afterEach(async () => {
    if (fixtures) await removeTenantFixtures(database.admin.db, fixtures);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('applies to an empty database, creates exactly six tables, and can run again safely', async () => {
    expect(initiallyEmpty).toBe(true);
    const result = await database.admin.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'clients',
      'developer_profiles',
      'projects',
      'tenant_memberships',
      'tenants',
      'users',
    ]);
    await migrateDatabase(database.admin.db);
    const journal = await database.admin.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ count: 1 }]);
  });

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    'matches Drizzle columns and constraints for %s',
    async (_name, table) => {
      const config = getTableConfig(table);
      const columns = await database.admin.pool.query<{
        name: string;
        nullable: boolean;
        type: string;
      }>(
        `SELECT a.attname AS name, NOT a.attnotnull AS nullable,
          format_type(a.atttypid, a.atttypmod) AS type
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1
          AND a.attnum > 0 AND NOT a.attisdropped`,
        [config.name],
      );
      const normalize = (items: { name: string; nullable: boolean; type: string }[]) =>
        items
          .map((item) => ({ ...item, type: item.type.replace(/[\s"]/g, '') }))
          .sort((a, b) => a.name.localeCompare(b.name));
      expect(normalize(columns.rows)).toEqual(
        normalize(
          config.columns.map((column) => ({
            name: column.name,
            nullable: !column.notNull,
            type: column.getSQLType(),
          })),
        ),
      );
      const constraints = await database.admin.pool.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass',
        [config.name],
      );
      const names = constraints.rows.map((row) => row.conname);
      for (const check of config.checks) expect(names).toContain(check.name);
      for (const foreignKey of config.foreignKeys) expect(names).toContain(foreignKey.getName());
      for (const unique of config.uniqueConstraints) expect(names).toContain(unique.getName());
      const indexes = await database.admin.pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
        [config.name],
      );
      for (const index of config.indexes)
        expect(indexes.rows.map((row) => row.indexname)).toContain(index.config.name);
    },
  );

  it('reproduces the same schema on a second fresh database', async () => {
    const second = await createTestDatabase(parseTestDatabaseUrl(process.env));
    try {
      expect(await schemaSignature(second)).toEqual(await schemaSignature(database));
    } finally {
      await second.close();
    }
  });

  it('keeps the runtime role separate from migration and fixture privileges', async () => {
    const roles = await database.runtime.pool.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
    }>(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(roles.rows).toEqual([
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false },
    ]);
    await expect(database.runtime.pool.query('SELECT * FROM users')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      database.runtime.pool.query('CREATE TABLE unauthorized (id int)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(database.runtime.pool.query('DELETE FROM projects')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('enforces global tenant slug uniqueness and case-insensitive global email uniqueness', async () => {
    await expect(
      database.admin.pool.query('UPDATE tenants SET slug = $1 WHERE id = $2', [
        `studio-${fixtures.a.tenantId}`,
        fixtures.b.tenantId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      database.admin.pool.query('UPDATE users SET email = $1 WHERE id = $2', [
        `DEVELOPER-${fixtures.a.userId}@EXAMPLE.TEST`,
        fixtures.b.userId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows a global user to join another tenant with a separate membership', async () => {
    const result = await database.admin.pool.query<{ tenant_id: string; user_id: string }>(
      "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member') RETURNING tenant_id, user_id",
      [fixtures.b.tenantId, fixtures.a.userId],
    );
    expect(result.rows).toEqual([{ tenant_id: fixtures.b.tenantId, user_id: fixtures.a.userId }]);
  });

  it('enforces membership uniqueness and one profile per tenant', async () => {
    await expect(
      database.admin.pool.query(
        "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')",
        [fixtures.a.tenantId, fixtures.a.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      database.admin.pool.query('UPDATE developer_profiles SET tenant_id = $1 WHERE id = $2', [
        fixtures.a.tenantId,
        fixtures.b.profileId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('permits a project slug in different tenants, but not twice in one tenant', async () => {
    const result = await database.admin.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM projects WHERE slug = 'portfolio-platform'",
    );
    expect(result.rows).toEqual([{ count: 2 }]);
    await expect(
      database.admin.pool.query(
        `INSERT INTO projects (tenant_id, name, slug, summary, problem_statement, outcome)
       VALUES ($1, 'Duplicate', 'portfolio-platform', '', '', '')`,
        [fixtures.a.tenantId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['tenants', 'status'],
    ['users', 'status'],
    ['tenant_memberships', 'status'],
    ['tenant_memberships', 'role'],
    ['clients', 'status'],
    ['projects', 'status'],
  ])('constrains %s.%s', async (table, column) => {
    await expect(
      database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1`, ['invalid']),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it.each([
    ['tenant_memberships', 'tenant_id', 'membershipId'],
    ['tenant_memberships', 'user_id', 'membershipId'],
    ['developer_profiles', 'tenant_id', 'profileId'],
    ['clients', 'tenant_id', 'clientId'],
    ['projects', 'tenant_id', 'projectId'],
  ] as const)('enforces the %s.%s foreign key', async (table, column, fixtureKey) => {
    await expect(
      database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`, [
        randomUUID(),
        fixtures.a[fixtureKey],
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('blocks cross-tenant client references, missing clients, and unsafe parent changes at the database', async () => {
    for (const clientId of [fixtures.b.clientId, randomUUID()]) {
      await expect(
        database.admin.pool.query('UPDATE projects SET client_id = $1 WHERE id = $2', [
          clientId,
          fixtures.a.projectId,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    }
    await expect(
      database.admin.pool.query('UPDATE clients SET tenant_id = $1 WHERE id = $2', [
        fixtures.b.tenantId,
        fixtures.a.clientId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      database.admin.pool.query('DELETE FROM clients WHERE id = $1', [fixtures.a.clientId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      database.admin.pool.query('DELETE FROM tenants WHERE id = $1', [fixtures.a.tenantId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it.each([
    ['tenants', 'name'],
    ['users', 'email'],
    ['tenant_memberships', 'tenant_id'],
    ['developer_profiles', 'tenant_id'],
    ['clients', 'tenant_id'],
    ['projects', 'tenant_id'],
  ])('requires %s.%s', async (table, column) => {
    await expect(
      database.admin.pool.query(`UPDATE "${table}" SET "${column}" = NULL`),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it.each([
    ['developer_profiles', 'skills'],
    ['developer_profiles', 'service_areas'],
    ['developer_profiles', 'preferred_project_types'],
    ['developer_profiles', 'excluded_project_types'],
    ['projects', 'stack'],
  ])('enforces string arrays in %s.%s', async (table, column) => {
    for (const invalid of ['{}', '[1]', '[null]', '[{}]', 'null']) {
      await expect(
        database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1::jsonb`, [invalid]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('requires an availability object', async () => {
    await expect(
      database.admin.pool.query("UPDATE developer_profiles SET availability = '[]'::jsonb"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['-0.01', 'NaN'])('rejects invalid hourly rates: %s', async (rate) => {
    await expect(
      database.admin.pool.query('UPDATE developer_profiles SET hourly_rate = $1', [rate]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces rate precision and nonnegative experience', async () => {
    await expect(
      database.admin.pool.query('UPDATE developer_profiles SET hourly_rate = $1', [
        '10000000000.00',
      ]),
    ).rejects.toMatchObject({ code: '22003' });
    await expect(
      database.admin.pool.query('UPDATE developer_profiles SET years_experience = -1'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('distinguishes an unpublished rate from a zero rate', async () => {
    await database.admin.pool.query(
      'UPDATE developer_profiles SET hourly_rate = NULL WHERE id = $1',
      [fixtures.a.profileId],
    );
    await database.admin.pool.query('UPDATE developer_profiles SET hourly_rate = 0 WHERE id = $1', [
      fixtures.b.profileId,
    ]);
    const result = await database.admin.pool.query<{ hourly_rate: string | null }>(
      'SELECT hourly_rate FROM developer_profiles ORDER BY hourly_rate NULLS LAST',
    );
    expect(result.rows).toEqual([{ hourly_rate: '0.00' }, { hourly_rate: null }]);
  });

  it('rejects invalid slugs, blank names, and reversed project dates', async () => {
    await expect(
      database.admin.pool.query("UPDATE tenants SET slug = 'Invalid Slug'"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.admin.pool.query("UPDATE projects SET name = '   '"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.admin.pool.query("UPDATE projects SET completed_at = '2025-01-01T00:00:00Z'"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('provides database-generated IDs, timestamps, and minimal defaults', async () => {
    const result = await database.admin.pool.query<{
      id: string;
      status: string;
      created_at: Date;
      updated_at: Date;
      stack: unknown;
    }>(
      `INSERT INTO projects (tenant_id, name, slug, summary, problem_statement, outcome)
       VALUES ($1, 'Default Project', 'default-project', '', '', '') RETURNING *`,
      [fixtures.a.tenantId],
    );
    const project = result.rows[0];
    expect(project?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project?.status).toBe('planned');
    expect(project?.created_at).toBeInstanceOf(Date);
    expect(project?.updated_at).toEqual(project?.created_at);
    expect(project?.stack).toEqual([]);
  });
});
