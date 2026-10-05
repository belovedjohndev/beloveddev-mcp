import { randomUUID } from 'node:crypto';
import type { ProjectRepository } from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import { openDatabase } from '@beloveddev/database/client';
import { tenantMemberships } from '@beloveddev/database/schema';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresClientRepository } from '../src/postgres/client-repository.js';
import { PostgresDeveloperProfileRepository } from '../src/postgres/developer-profile-repository.js';
import { PostgresMembershipRepository } from '../src/postgres/membership-repository.js';
import { PostgresProjectRepository } from '../src/postgres/project-repository.js';

describe('PostgreSQL tenant-scoped repositories', () => {
  let database: TestDatabase;
  let fixtures: TenantFixtures;
  let projects: ProjectRepository;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
  });
  beforeEach(async () => {
    fixtures = await seedTwoTenants(database.admin.db);
    projects = new PostgresProjectRepository(database.runtime.db);
  });
  afterEach(async () => {
    if (fixtures) await removeTenantFixtures(database.admin.db, fixtures);
  });
  afterAll(async () => {
    await database?.close();
  });

  it.each(['a', 'b'] as const)('tenant %s can read its own project', async (key) => {
    const tenant = fixtures[key];
    const result = await projects.getById(tenant);
    expect(result).toMatchObject({
      id: tenant.projectId,
      tenantId: tenant.tenantId,
      clientId: tenant.clientId,
      stack: ['TypeScript', 'PostgreSQL'],
    });
    expect(result?.startedAt).toEqual(new Date('2026-01-15T09:00:00Z'));
  });

  it.each(['a', 'b'] as const)('tenant %s cannot retrieve another tenant project', async (key) => {
    const other = key === 'a' ? fixtures.b : fixtures.a;
    expect(
      await projects.getById({ tenantId: fixtures[key].tenantId, projectId: other.projectId }),
    ).toBeNull();
  });

  it('returns the same null result for an unknown project', async () => {
    expect(
      await projects.getById({ tenantId: fixtures.a.tenantId, projectId: randomUUID() }),
    ).toBeNull();
  });

  it.each(['a', 'b'] as const)('tenant %s listing excludes other tenants', async (key) => {
    const own = fixtures[key];
    expect(
      (await projects.list({ tenantId: own.tenantId, limit: 100 })).map((project) => project.id),
    ).toEqual([own.projectId]);
  });

  it('filters status and applies a deterministic order and bound inside the tenant', async () => {
    const paused = await projects.create({
      ...projectInput(fixtures.a.tenantId, null),
      slug: 'paused-project',
      status: 'paused',
    });
    expect(
      (await projects.list({ tenantId: fixtures.a.tenantId, status: 'paused', limit: 20 })).map(
        (project) => project.id,
      ),
    ).toEqual([paused.id]);
    const expected = [fixtures.a.projectId, paused.id].sort();
    expect(
      (await projects.list({ tenantId: fixtures.a.tenantId, limit: 1 })).map(
        (project) => project.id,
      ),
    ).toEqual(expected.slice(0, 1));
    expect(
      (await projects.list({ tenantId: fixtures.a.tenantId, limit: 100 })).map(
        (project) => project.id,
      ),
    ).toEqual(expected);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects invalid list limits: %s', async (limit) => {
    await expect(projects.list({ tenantId: fixtures.a.tenantId, limit })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('scopes client lookup in both directions and returns null for unknown IDs', async () => {
    const repository = new PostgresClientRepository(database.runtime.db);
    expect(await repository.getById(fixtures.a)).toMatchObject({ id: fixtures.a.clientId });
    expect(
      await repository.getById({ tenantId: fixtures.a.tenantId, clientId: fixtures.b.clientId }),
    ).toBeNull();
    expect(
      await repository.getById({ tenantId: fixtures.b.tenantId, clientId: fixtures.a.clientId }),
    ).toBeNull();
    expect(
      await repository.getById({ tenantId: fixtures.a.tenantId, clientId: randomUUID() }),
    ).toBeNull();
  });

  it('retrieves only the requested tenant profile and preserves exact decimal amounts', async () => {
    const repository = new PostgresDeveloperProfileRepository(database.runtime.db);
    expect(await repository.getByTenant(fixtures.a)).toMatchObject({
      id: fixtures.a.profileId,
      tenantId: fixtures.a.tenantId,
      hourlyRate: '125.50',
    });
    expect(await repository.getByTenant(fixtures.b)).toMatchObject({
      id: fixtures.b.profileId,
      tenantId: fixtures.b.tenantId,
    });
    expect(await repository.getByTenant({ tenantId: randomUUID() })).toBeNull();
  });

  it('requires both tenant and user for membership lookup', async () => {
    const repository = new PostgresMembershipRepository(database.runtime.db);
    expect(await repository.getByUser(fixtures.a)).toMatchObject({
      id: fixtures.a.membershipId,
      role: 'owner',
    });
    expect(await repository.getByUser(fixtures.b)).toMatchObject({
      id: fixtures.b.membershipId,
      role: 'viewer',
    });
    expect(
      await repository.getByUser({ tenantId: fixtures.a.tenantId, userId: fixtures.b.userId }),
    ).toBeNull();
    expect(
      await repository.getByUser({ tenantId: fixtures.b.tenantId, userId: fixtures.a.userId }),
    ).toBeNull();
    expect(
      await repository.getByUser({ tenantId: fixtures.a.tenantId, userId: randomUUID() }),
    ).toBeNull();
  });

  it('returns membership status without implementing authorization decisions', async () => {
    await database.admin.db
      .update(tenantMemberships)
      .set({ status: 'inactive' })
      .where(eq(tenantMemberships.id, fixtures.a.membershipId));
    const repository = new PostgresMembershipRepository(database.runtime.db);
    expect(await repository.getByUser(fixtures.a)).toMatchObject({ status: 'inactive' });
  });

  it.each([true, false])(
    'creates a project atomically (client present: %s)',
    async (withClient) => {
      const input = {
        ...projectInput(fixtures.a.tenantId, withClient ? fixtures.a.clientId : null),
        slug: 'new-project',
      };
      const created = await projects.create(input);
      expect(created).toMatchObject(input);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(
        await projects.getById({ tenantId: fixtures.a.tenantId, projectId: created.id }),
      ).toEqual(created);
      expect(
        await projects.getById({ tenantId: fixtures.b.tenantId, projectId: created.id }),
      ).toBeNull();
    },
  );

  it('rejects cross-tenant and missing clients identically without partial writes or SQL details', async () => {
    const errors: RepositoryError[] = [];
    for (const clientId of [fixtures.b.clientId, randomUUID()]) {
      try {
        await projects.create({
          ...projectInput(fixtures.a.tenantId, clientId),
          slug: 'invalid-client',
        });
        expect.fail('Expected the project/client invariant to reject the write');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RepositoryError);
        if (!(error instanceof RepositoryError)) throw error;
        expect(error.code).toBe('INVALID_REFERENCE');
        expect(error.cause).toBeUndefined();
        expect(error.message).not.toContain(clientId);
        expect(error.message).not.toContain('SQL');
        errors.push(error);
      }
    }
    expect(errors[0]?.message).toBe(errors[1]?.message);
    expect(await projects.list({ tenantId: fixtures.a.tenantId, limit: 100 })).toHaveLength(1);
  });

  it('maps a tenant slug conflict without exposing the database constraint', async () => {
    await expect(projects.create(projectInput(fixtures.a.tenantId, null))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The record conflicts with an existing record.',
    });
  });

  it('lets PostgreSQL resolve concurrent duplicate inserts without duplicate records', async () => {
    const input = { ...projectInput(fixtures.a.tenantId, null), slug: 'concurrent-project' };
    const results = await Promise.allSettled([projects.create(input), projects.create(input)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(await projects.list({ tenantId: fixtures.a.tenantId, limit: 100 })).toHaveLength(2);
  });

  it('maps malformed identifiers and check violations to safe input errors', async () => {
    await expect(
      projects.getById({ tenantId: fixtures.a.tenantId, projectId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      projects.create({ ...projectInput(fixtures.a.tenantId, null), slug: 'Invalid Slug' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('propagates infrastructure failure as an explicit safe repository error', async () => {
    const connection = openDatabase(parseTestDatabaseUrl(process.env), {
      onIdleError: () => undefined,
    });
    await connection.close();
    const unavailable = new PostgresProjectRepository(connection.db);
    await expect(unavailable.getById(fixtures.a)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'The repository operation could not be completed.',
    });
  });
});
