import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projects, projectBlockers } from '@beloveddev/database/schema';
import type { BlockerPosition, ProjectPosition } from '@beloveddev/application/pagination';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import {
  blockerInput,
  seedProjectKnowledge,
} from '@beloveddev/test-support/project-knowledge-fixtures';
import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresProjectRepository } from '../src/postgres/project-repository.js';
import { PostgresBlockerRepository } from '../src/postgres/blocker-repository.js';
import { PostgresMembershipRepository } from '../src/postgres/membership-repository.js';

describe('PostgreSQL read pagination and active identity', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let projectRepository: PostgresProjectRepository;
  let blockerRepository: PostgresBlockerRepository;
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    projectRepository = new PostgresProjectRepository(database.runtime.db);
    blockerRepository = new PostgresBlockerRepository(database.runtime.db);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    await seedProjectKnowledge(database.admin.db, tenants);
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('pages by project UUID without duplicates, including no-client rows and tenant-scoped joins', async () => {
    await database.admin.db.insert(projects).values([
      { ...projectInput(tenants.a.tenantId, null), id: fixtureId(20), slug: 'second' },
      { ...projectInput(tenants.a.tenantId, tenants.a.clientId), id: fixtureId(30), slug: 'third' },
    ]);
    const ids: string[] = [];
    let after: ProjectPosition | null = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await projectRepository.listPage({
        tenantId: tenants.a.tenantId,
        limit: 1,
        ...(after ? { after } : {}),
      });
      ids.push(...page.items.map((row) => row.project.id));
      for (const row of page.items) {
        expect(row.project.tenantId).toBe(tenants.a.tenantId);
        if (row.project.clientId === null) expect(row.client).toBeNull();
        else expect(row.client?.id).toBe(tenants.a.clientId);
      }
      after = page.nextPosition;
      if (after === null) break;
    }
    expect(ids).toEqual([tenants.a.projectId, fixtureId(20), fixtureId(30)].sort());
    expect(after).toBeNull();
  });

  it('continues after a deleted cursor row and ignores inserts before the cursor', async () => {
    await database.admin.db.insert(projects).values([
      { ...projectInput(tenants.a.tenantId, null), id: fixtureId(20), slug: 'cursor-row' },
      { ...projectInput(tenants.a.tenantId, null), id: fixtureId(30), slug: 'later-row' },
    ]);
    const first = await projectRepository.listPage({ tenantId: tenants.a.tenantId, limit: 1 });
    expect(first.items[0]?.project.id).toBe(fixtureId(20));
    const after = first.nextPosition;
    if (!after) throw new Error('Expected another page');
    await database.admin.pool.query('DELETE FROM projects WHERE id=$1', [fixtureId(20)]);
    await database.admin.db.insert(projects).values({
      ...projectInput(tenants.a.tenantId, null),
      id: fixtureId(10),
      slug: 'earlier-row',
    });
    const next = await projectRepository.listPage({
      tenantId: tenants.a.tenantId,
      limit: 100,
      after,
    });
    expect(next.items.map((row) => row.project.id)).toEqual(
      [fixtureId(30), tenants.a.projectId].sort(),
    );
    expect(next.nextPosition).toBeNull();
  });

  it('combines status, client, and literal case-insensitive name/summary filters', async () => {
    await database.admin.db.insert(projects).values([
      {
        ...projectInput(tenants.a.tenantId, null),
        id: fixtureId(20),
        slug: 'literal',
        name: '100%_done\\ready',
        summary: 'Unique summary',
        status: 'paused',
      },
      {
        ...projectInput(tenants.a.tenantId, null),
        id: fixtureId(30),
        slug: 'near-match',
        name: '100xxdone ready',
        summary: 'Different',
        status: 'paused',
      },
    ]);
    for (const query of ['%', '_', '\\', 'UNIQUE SUMMARY']) {
      const page = await projectRepository.listPage({
        tenantId: tenants.a.tenantId,
        query,
        status: 'paused',
        limit: 100,
      });
      expect(page.items.map((row) => row.project.id)).toEqual([fixtureId(20)]);
    }
    expect(
      (
        await projectRepository.listPage({
          tenantId: tenants.a.tenantId,
          clientId: tenants.a.clientId,
          status: 'active',
          query: 'portfolio',
          limit: 20,
        })
      ).items.map((row) => row.project.id),
    ).toEqual([tenants.a.projectId]);
    expect(
      (
        await projectRepository.listPage({
          tenantId: tenants.a.tenantId,
          clientId: tenants.b.clientId,
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await projectRepository.listPage({
          tenantId: tenants.a.tenantId,
          query: "' OR true --",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
  });

  it('keeps blocker keysets at PostgreSQL microsecond precision with UUID ties', async () => {
    await database.admin.pool.query('DELETE FROM project_blockers WHERE tenant_id=$1', [
      tenants.a.tenantId,
    ]);
    for (const [id, time] of [
      [fixtureId(30), '2026-03-01T00:00:00.123456Z'],
      [fixtureId(20), '2026-03-01T00:00:00.123456Z'],
      [fixtureId(10), '2026-03-01T00:00:00.123457Z'],
    ]) {
      await database.admin.pool.query(
        "INSERT INTO project_blockers (id,tenant_id,project_id,title,description,severity,blocked_since) VALUES ($1,$2,$3,'Title','Description','high',$4)",
        [id, tenants.a.tenantId, tenants.a.projectId, time],
      );
    }
    const ids: string[] = [];
    let after: BlockerPosition | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await blockerRepository.listOpenPage({
        tenantId: tenants.a.tenantId,
        limit: 1,
        ...(after ? { after } : {}),
      });
      ids.push(...page.items.map((row) => row.blocker.id));
      for (const row of page.items) expect(row.projectName).toBe('Portfolio Platform');
      after = page.nextPosition;
      if (ids.length === 1) {
        expect(after?.blockedSince).toBe('2026-03-01T00:00:00.123456Z');
        await database.admin.pool.query('DELETE FROM project_blockers WHERE id=$1', [
          fixtureId(20),
        ]);
      }
      if (after === null) break;
    }
    expect(ids).toEqual([fixtureId(20), fixtureId(30), fixtureId(10)]);
    expect(after).toBeNull();
  });

  it('combines open-only, project, severity, and tenant predicates on blocker pages', async () => {
    const secondId = randomUUID();
    await database.admin.db
      .insert(projects)
      .values({ ...projectInput(tenants.a.tenantId, null), id: secondId, slug: 'second' });
    await database.admin.db.insert(projectBlockers).values([
      { ...blockerInput(tenants.a), id: fixtureId(20), severity: 'critical', projectId: secondId },
      {
        ...blockerInput(tenants.a),
        id: fixtureId(30),
        status: 'resolved',
        resolvedAt: new Date('2026-03-01T00:00:00Z'),
      },
    ]);
    const scope = { tenantId: tenants.a.tenantId, limit: 100 };
    expect((await blockerRepository.listOpenPage(scope)).items).toHaveLength(2);
    expect(
      (
        await blockerRepository.listOpenPage({
          ...scope,
          projectId: secondId,
          severity: 'critical',
        })
      ).items.map((row) => row.blocker.id),
    ).toEqual([fixtureId(20)]);
    expect(
      (await blockerRepository.listOpenPage({ ...scope, projectId: secondId, severity: 'high' }))
        .items,
    ).toEqual([]);
    expect(
      (await blockerRepository.listOpenPage({ ...scope, projectId: tenants.b.projectId })).items,
    ).toEqual([]);
    expect(
      (await blockerRepository.listOpenPage({ tenantId: tenants.b.tenantId, limit: 100 })).items,
    ).toHaveLength(1);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects invalid page limits %s', async (limit) => {
    for (const operation of [
      () => projectRepository.listPage({ tenantId: tenants.a.tenantId, limit }),
      () => blockerRepository.listOpenPage({ tenantId: tenants.a.tenantId, limit }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('maps malformed identifiers and timestamp positions safely', async () => {
    for (const operation of [
      () => projectRepository.listPage({ tenantId: 'invalid', limit: 20 }),
      () =>
        projectRepository.listPage({
          tenantId: tenants.a.tenantId,
          limit: 20,
          after: { id: 'invalid' },
        }),
      () =>
        projectRepository.listPage({
          tenantId: tenants.a.tenantId,
          limit: 20,
          clientId: 'invalid',
        }),
      () =>
        blockerRepository.listOpenPage({
          tenantId: tenants.a.tenantId,
          limit: 20,
          projectId: 'invalid',
        }),
      () =>
        blockerRepository.listOpenPage({
          tenantId: tenants.a.tenantId,
          limit: 20,
          after: { id: fixtureId(1), blockedSince: 'invalid' },
        }),
      () =>
        blockerRepository.listOpenPage({
          tenantId: tenants.a.tenantId,
          limit: 20,
          after: { id: 'invalid', blockedSince: '2026-01-01T00:00:00.000000Z' },
        }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['tenant_memberships', 'tenants', 'users'] as const)(
    'active context lookup rejects inactive %s',
    async (table) => {
      const repository = new PostgresMembershipRepository(database.runtime.db);
      expect(await repository.getActiveByUser(tenants.a)).toMatchObject({
        id: tenants.a.membershipId,
      });
      const id =
        table === 'tenants'
          ? tenants.a.tenantId
          : table === 'users'
            ? tenants.a.userId
            : tenants.a.membershipId;
      await database.admin.pool.query(`UPDATE "${table}" SET status='inactive' WHERE id=$1`, [id]);
      expect(await repository.getActiveByUser(tenants.a)).toBeNull();
      expect(await repository.getActiveByUser(tenants.b)).not.toBeNull();
    },
  );

  it('does not resolve a user in another tenant without membership or read unrelated identity columns', async () => {
    const repository = new PostgresMembershipRepository(database.runtime.db);
    expect(
      await repository.getActiveByUser({ tenantId: tenants.a.tenantId, userId: tenants.b.userId }),
    ).toBeNull();
    await expect(database.runtime.pool.query('SELECT email FROM users')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
