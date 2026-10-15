import { randomUUID } from 'node:crypto';
import { auditLogs, projectNotes, tenantMemberships } from '@beloveddev/database/schema';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import { noteInput } from '@beloveddev/test-support/project-knowledge-fixtures';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('audit log PostgreSQL integrity', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let noteIds: { a: string; b: string };
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    noteIds = { a: randomUUID(), b: randomUUID() };
    await database.admin.db.insert(projectNotes).values([
      { ...noteInput(tenants.a), id: noteIds.a },
      { ...noteInput(tenants.b), id: noteIds.b },
    ]);
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  function input() {
    return {
      tenantId: tenants.a.tenantId,
      actorUserId: tenants.a.userId,
      action: 'project_note.created',
      resourceType: 'project_note',
      resourceId: noteIds.a,
      requestId: randomUUID(),
      metadata: { projectId: tenants.a.projectId, category: 'decision' as const },
    };
  }

  it('stores the required audit fields with database-generated identity and timestamp', async () => {
    const data = input();
    const [record] = await database.admin.db.insert(auditLogs).values(data).returning();
    expect(record).toMatchObject(data);
    expect(record?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record?.createdAt).toBeInstanceOf(Date);
  });

  it.each(['tenantId', 'actorUserId', 'resourceId'] as const)(
    'rejects cross-tenant %s references',
    async (field) => {
      const data = input();
      const replacement =
        field === 'tenantId'
          ? tenants.b.tenantId
          : field === 'actorUserId'
            ? tenants.b.userId
            : noteIds.b;
      await expect(
        database.admin.db.insert(auditLogs).values({ ...data, [field]: replacement }),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
    },
  );

  it('rejects a different actor even when that actor is a member of the note tenant', async () => {
    await database.admin.db
      .insert(tenantMemberships)
      .values({ tenantId: tenants.a.tenantId, userId: tenants.b.userId, role: 'member' });
    await expect(
      database.admin.db.insert(auditLogs).values({ ...input(), actorUserId: tenants.b.userId }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it.each(['tenantId', 'actorUserId', 'resourceId'] as const)(
    'rejects unknown %s references',
    async (field) => {
      await expect(
        database.admin.db.insert(auditLogs).values({ ...input(), [field]: randomUUID() }),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
    },
  );

  it.each([
    'tenant_id',
    'actor_user_id',
    'action',
    'resource_type',
    'resource_id',
    'request_id',
    'metadata',
    'created_at',
  ] as const)('requires %s', async (column) => {
    const [record] = await database.admin.db.insert(auditLogs).values(input()).returning();
    await expect(
      database.admin.pool.query(`UPDATE audit_logs SET ${column}=NULL WHERE id=$1`, [record?.id]),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it.each([
    ['action', ''],
    ['action', 'unrelated.mutation'],
    ['resource_type', 'project'],
    ['metadata', '{}'],
    ['metadata', '[]'],
    ['metadata', '{"projectId":"id","category":null}'],
    ['metadata', '{"projectId":123,"category":"decision"}'],
    ['metadata', '{"projectId":"id","category":"decision","content":"private"}'],
  ])('constrains %s to the current safe audit contract', async (column, value) => {
    const [record] = await database.admin.db.insert(auditLogs).values(input()).returning();
    await expect(
      database.admin.pool.query(`UPDATE audit_logs SET ${column}=$1 WHERE id=$2`, [
        value,
        record?.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces one creation audit per tenant/resource regardless of request ID', async () => {
    const data = input();
    await database.admin.db.insert(auditLogs).values(data);
    await expect(
      database.admin.db.insert(auditLogs).values({ ...data, requestId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('requires a valid UUID request ID and retains referenced note history', async () => {
    const [record] = await database.admin.db.insert(auditLogs).values(input()).returning();
    await expect(
      database.admin.pool.query('UPDATE audit_logs SET request_id=$1 WHERE id=$2', [
        'invalid',
        record?.id,
      ]),
    ).rejects.toMatchObject({ code: '22P02' });
    await expect(
      database.admin.pool.query('DELETE FROM project_notes WHERE id=$1', [noteIds.a]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
