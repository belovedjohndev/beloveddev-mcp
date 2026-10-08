import { randomUUID } from 'node:crypto';
import { opportunityBudgetTypes, opportunityStatuses } from '@beloveddev/domain/entities';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('opportunity PostgreSQL invariants', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let opportunityId: string;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    opportunityId = (await seedOpportunity(database.admin.db, tenants.a.tenantId)).id;
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  it.each([
    'tenant_id',
    'source',
    'title',
    'description',
    'required_skills',
    'preferred_skills',
    'status',
    'created_at',
    'updated_at',
  ])('requires opportunities.%s', async (column) => {
    await expect(
      database.admin.pool.query(`UPDATE opportunities SET "${column}" = NULL WHERE id = $1`, [
        opportunityId,
      ]),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('enforces bounded canonical source slugs', async () => {
    for (const source of [
      '',
      'UPWORK',
      ' upwork',
      'upwork ',
      'up_work',
      '-upwork',
      'a'.repeat(101),
    ]) {
      await expect(
        database.admin.pool.query('UPDATE opportunities SET source = $1 WHERE id = $2', [
          source,
          opportunityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    for (const source of ['upwork', 'direct-referral', 'source2']) {
      await database.admin.pool.query('UPDATE opportunities SET source = $1 WHERE id = $2', [
        source,
        opportunityId,
      ]);
    }
  });

  it.each([['title'], ['description'], ['client_name'], ['project_type'], ['external_id']])(
    'rejects blank opportunities.%s when present',
    async (column) => {
      await expect(
        database.admin.pool.query(`UPDATE opportunities SET "${column}" = '   ' WHERE id = $1`, [
          opportunityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('accepts all specified statuses and budget types and rejects unknown enum values', async () => {
    for (const status of opportunityStatuses) {
      await database.admin.pool.query('UPDATE opportunities SET status = $1 WHERE id = $2', [
        status,
        opportunityId,
      ]);
    }
    for (const budgetType of opportunityBudgetTypes) {
      await database.admin.pool.query('UPDATE opportunities SET budget_type = $1 WHERE id = $2', [
        budgetType,
        opportunityId,
      ]);
    }
    await expect(
      database.admin.pool.query("UPDATE opportunities SET status = 'invalid'"),
    ).rejects.toMatchObject({ code: '22P02' });
    await expect(
      database.admin.pool.query("UPDATE opportunities SET budget_type = 'invalid'"),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('enforces budget range, type, currency, and numeric precision as one invariant', async () => {
    const invalidAssignments = [
      'budget_type = NULL',
      "budget_type = NULL, amount_min = 1, amount_max = NULL, currency = 'USD'",
      "budget_type = 'fixed', amount_min = 1, amount_max = NULL, currency = NULL",
      "budget_type = 'fixed', amount_min = -0.01, amount_max = 1, currency = 'USD'",
      "budget_type = 'fixed', amount_min = 2, amount_max = 1, currency = 'USD'",
      "budget_type = 'fixed', amount_min = 1, amount_max = 2, currency = 'usd'",
      "budget_type = 'fixed', amount_min = 1, amount_max = 2, currency = 'US'",
      "budget_type = 'fixed', amount_min = 'NaN', amount_max = 2, currency = 'USD'",
    ];
    for (const assignment of invalidAssignments) {
      await expect(
        database.admin.pool.query(`UPDATE opportunities SET ${assignment} WHERE id = $1`, [
          opportunityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      database.admin.pool.query(
        'UPDATE opportunities SET amount_max = 10000000000.00 WHERE id = $1',
        [opportunityId],
      ),
    ).rejects.toMatchObject({ code: '22003' });
    await database.admin.pool.query(
      'UPDATE opportunities SET budget_type = NULL, amount_min = NULL, amount_max = NULL, currency = NULL WHERE id = $1',
      [opportunityId],
    );
    await database.admin.pool.query(
      "UPDATE opportunities SET budget_type = 'hourly', amount_min = 100, amount_max = NULL, currency = 'USD' WHERE id = $1",
      [opportunityId],
    );
  });

  it.each(['required_skills', 'preferred_skills'])(
    'enforces a strict JSON string array in %s',
    async (column) => {
      for (const invalid of ['{}', '[1]', '[null]', '[{}]', '[[]]', '["ok",["nested"]]', 'null']) {
        await expect(
          database.admin.pool.query(
            `UPDATE opportunities SET "${column}" = $1::jsonb WHERE id = $2`,
            [invalid, opportunityId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      await database.admin.pool.query(
        `UPDATE opportunities SET "${column}" = '["TypeScript"]'::jsonb WHERE id = $1`,
        [opportunityId],
      );
    },
  );

  it('enforces external identity within a tenant while allowing other tenants and null IDs', async () => {
    const existing = await database.admin.pool.query<{ source: string; external_id: string }>(
      'SELECT source, external_id FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    const identity = existing.rows[0];
    if (!identity) throw new Error('Missing opportunity fixture.');
    await expect(
      seedOpportunity(database.admin.db, tenants.a.tenantId, {
        source: identity.source,
        externalId: identity.external_id,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await seedOpportunity(database.admin.db, tenants.b.tenantId, {
      source: identity.source,
      externalId: identity.external_id,
    });
    await seedOpportunity(database.admin.db, tenants.a.tenantId, { externalId: null });
    await seedOpportunity(database.admin.db, tenants.a.tenantId, { externalId: null });
  });

  it('enforces tenant ownership and restricts deleting an owning tenant', async () => {
    await expect(
      database.admin.pool.query('UPDATE opportunities SET tenant_id = $1 WHERE id = $2', [
        randomUUID(),
        opportunityId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      database.admin.pool.query('DELETE FROM tenants WHERE id = $1', [tenants.a.tenantId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('provides stable defaults without inventing budget semantics', async () => {
    const result = await database.admin.pool.query<{
      id: string;
      status: string;
      required_skills: unknown;
      preferred_skills: unknown;
      budget_type: null;
      amount_min: null;
      amount_max: null;
      currency: null;
      created_at: Date;
      updated_at: Date;
    }>(
      "INSERT INTO opportunities (tenant_id, source, title, description) VALUES ($1, 'manual', 'Title', 'Description') RETURNING *",
      [tenants.b.tenantId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'new',
      required_skills: [],
      preferred_skills: [],
      budget_type: null,
      amount_min: null,
      amount_max: null,
      currency: null,
    });
    expect(result.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0]?.created_at).toBeInstanceOf(Date);
    expect(result.rows[0]?.updated_at).toEqual(result.rows[0]?.created_at);
  });
});
