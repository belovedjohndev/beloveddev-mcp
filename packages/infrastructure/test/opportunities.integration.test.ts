import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresOpportunityRepository } from '../src/postgres/opportunity-repository.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('PostgresOpportunityRepository', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let repository: PostgresOpportunityRepository;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    repository = new PostgresOpportunityRepository(database.runtime.db);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('isolates every page by the trusted tenant scope', async () => {
    const tenantA = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(100),
      title: 'Tenant A opportunity',
    });
    await seedOpportunity(database.admin.db, tenants.b.tenantId, {
      id: fixtureId(101),
      title: 'Tenant B opportunity',
    });
    const page = await repository.listPage({ tenantId: tenants.a.tenantId, limit: 100 });
    expect(page.items.map((item) => item.id)).toEqual([tenantA.id]);
    expect(page.items.every((item) => item.tenantId === tenants.a.tenantId)).toBe(true);
  });

  it('orders by effective publication timestamp and then descending UUID', async () => {
    const older = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(102),
      publishedAt: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
    });
    const lowerId = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(103),
      publishedAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    const higherId = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(104),
      publishedAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    const page = await repository.listPage({ tenantId: tenants.a.tenantId, limit: 100 });
    expect(page.items.map((item) => item.id)).toEqual([higherId.id, lowerId.id, older.id]);
  });

  it('combines exact status and source filters', async () => {
    const match = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(105),
      source: 'upwork',
      status: 'reviewing',
    });
    await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(106),
      source: 'manual',
      status: 'reviewing',
    });
    await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(107),
      source: 'upwork',
      status: 'new',
    });
    const page = await repository.listPage({
      tenantId: tenants.a.tenantId,
      source: 'upwork',
      status: 'reviewing',
      limit: 100,
    });
    expect(page.items.map((item) => item.id)).toEqual([match.id]);
  });

  it.each([
    ['title', { title: 'Rare Needle Title' }],
    ['client name', { clientName: 'Rare Needle Client' }],
    ['description', { description: 'Rare Needle Description' }],
    ['project type', { projectType: 'Rare Needle Project Type' }],
  ] as const)('matches a literal case-insensitive substring in %s', async (_field, overrides) => {
    const match = await seedOpportunity(database.admin.db, tenants.a.tenantId, overrides);
    await seedOpportunity(database.admin.db, tenants.a.tenantId, { title: 'Unrelated record' });
    const page = await repository.listPage({
      tenantId: tenants.a.tenantId,
      query: 'rArE nEeDlE',
      limit: 100,
    });
    expect(page.items.map((item) => item.id)).toEqual([match.id]);
  });

  it('treats percent, underscore, and backslash as literal query characters', async () => {
    const match = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      title: 'Literal 100%_path\\name',
    });
    await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      title: 'Ordinary 100X path name',
    });
    for (const query of ['%_', '\\name']) {
      const page = await repository.listPage({ tenantId: tenants.a.tenantId, query, limit: 100 });
      expect(page.items.map((item) => item.id)).toEqual([match.id]);
    }
  });

  it('paginates deterministically without duplicates or omissions', async () => {
    for (let index = 0; index < 7; index += 1) {
      await seedOpportunity(database.admin.db, tenants.a.tenantId, {
        id: fixtureId(200 + index),
        publishedAt: new Date(`2026-09-0${Math.floor(index / 2) + 1}T12:00:00.123456Z`),
      });
    }
    const expected = await database.admin.pool.query<{ id: string }>(
      'SELECT id FROM opportunities WHERE tenant_id = $1 ORDER BY coalesce(published_at, created_at) DESC, id DESC',
      [tenants.a.tenantId],
    );
    const ids: string[] = [];
    let after: { id: string; orderingTimestamp: string } | undefined;
    do {
      const page = await repository.listPage({
        tenantId: tenants.a.tenantId,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      ids.push(...page.items.map((item) => item.id));
      after = page.nextPosition ?? undefined;
    } while (after !== undefined);
    expect(ids).toEqual(expected.rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('continues from a keyset position even if the cursor row was deleted', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedOpportunity(database.admin.db, tenants.a.tenantId, {
        id: fixtureId(300 + index),
        publishedAt: new Date(`2026-09-0${index + 1}T12:00:00.000Z`),
      });
    }
    const first = await repository.listPage({ tenantId: tenants.a.tenantId, limit: 1 });
    if (!first.nextPosition) throw new Error('Expected a next page.');
    await database.admin.pool.query('DELETE FROM opportunities WHERE id = $1', [
      first.nextPosition.id,
    ]);
    const second = await repository.listPage({
      tenantId: tenants.a.tenantId,
      limit: 2,
      after: first.nextPosition,
    });
    expect(second.items.map((item) => item.id)).toEqual([fixtureId(301), fixtureId(300)]);
  });

  it('rejects invalid repository inputs before issuing SQL', async () => {
    for (const input of [
      { tenantId: 'invalid', limit: 20 },
      { tenantId: tenants.a.tenantId, limit: 0 },
      { tenantId: tenants.a.tenantId, limit: 101 },
      { tenantId: tenants.a.tenantId, limit: 20, source: 'UPWORK' },
      { tenantId: tenants.a.tenantId, limit: 20, query: '   ' },
      {
        tenantId: tenants.a.tenantId,
        limit: 20,
        after: { id: fixtureId(1), orderingTimestamp: '2026-09-01T12:00:00.000Z' },
      },
    ]) {
      await expect(repository.listPage(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('uses the restricted runtime role for reads without granting writes', async () => {
    await seedOpportunity(database.admin.db, tenants.a.tenantId);
    const page = await repository.listPage({ tenantId: tenants.a.tenantId, limit: 20 });
    expect(page.items).toHaveLength(1);
    await expect(database.runtime.pool.query('DELETE FROM opportunities')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
