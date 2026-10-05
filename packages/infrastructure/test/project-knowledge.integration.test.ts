import { randomUUID } from 'node:crypto';
import type { ProjectKnowledgeQuery } from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import { openDatabase } from '@beloveddev/database/client';
import {
  projects,
  projectEvidence,
  projectBlockers,
  projectNotes,
} from '@beloveddev/database/schema';
import type { BlockerSeverity } from '@beloveddev/domain/entities';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import {
  evidenceInput,
  blockerInput,
  noteInput,
  seedProjectKnowledge,
  type ProjectKnowledgeFixtures,
} from '@beloveddev/test-support/project-knowledge-fixtures';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresEvidenceRepository } from '../src/postgres/evidence-repository.js';
import { PostgresBlockerRepository } from '../src/postgres/blocker-repository.js';
import { PostgresNoteRepository } from '../src/postgres/note-repository.js';

describe('project knowledge tenant-scoped reads', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let knowledge: ProjectKnowledgeFixtures;
  let evidence: PostgresEvidenceRepository;
  let blockers: PostgresBlockerRepository;
  let notes: PostgresNoteRepository;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    evidence = new PostgresEvidenceRepository(database.runtime.db);
    blockers = new PostgresBlockerRepository(database.runtime.db);
    notes = new PostgresNoteRepository(database.runtime.db);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    knowledge = await seedProjectKnowledge(database.admin.db, tenants);
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  const readers = [
    {
      name: 'evidence',
      key: 'evidenceId',
      read: (input: ProjectKnowledgeQuery) => evidence.listByProject(input),
    },
    {
      name: 'blockers',
      key: 'blockerId',
      read: (input: ProjectKnowledgeQuery) => blockers.listOpen(input),
    },
    {
      name: 'notes',
      key: 'noteId',
      read: (input: ProjectKnowledgeQuery) => notes.listRecentByProject(input),
    },
  ] as const;

  describe.each(readers)('$name', ({ key, read }) => {
    it.each(['a', 'b'] as const)('returns only tenant %s project records', async (tenantKey) => {
      const own = tenants[tenantKey];
      const other = tenants[tenantKey === 'a' ? 'b' : 'a'];
      const result = await read({ ...own, limit: 100 });
      expect(result.map((row) => row.id)).toEqual([knowledge[tenantKey][key]]);
      expect(result[0]).toMatchObject({ tenantId: own.tenantId, projectId: own.projectId });
      expect(result[0]?.createdAt).toEqual(new Date('2026-02-01T09:00:00Z'));
      expect(
        await read({ tenantId: own.tenantId, projectId: other.projectId, limit: 100 }),
      ).toEqual([]);
    });

    it('returns empty results for unknown projects and tenants', async () => {
      expect(await read({ ...tenants.a, projectId: randomUUID(), limit: 100 })).toEqual([]);
      expect(await read({ ...tenants.a, tenantId: randomUUID(), limit: 100 })).toEqual([]);
    });

    it.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects limit %s',
      async (limit) => {
        await expect(read({ ...tenants.a, limit })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
      },
    );

    it.each(['tenantId', 'projectId'] as const)(
      'maps invalid %s to a safe error',
      async (field) => {
        let failure: unknown;
        try {
          await read({ ...tenants.a, limit: 10, [field]: 'malformed-id' });
        } catch (error: unknown) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(RepositoryError);
        expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
        if (!(failure instanceof RepositoryError)) throw new Error('Missing repository error');
        expect(failure.cause).toBeUndefined();
        expect(failure.message).not.toMatch(/malformed-id|SELECT|postgres|uuid/i);
      },
    );
  });

  it('orders evidence by newest creation and descending UUID ties before applying the limit', async () => {
    const sameTimeId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const newerId = randomUUID();
    const olderId = randomUUID();
    await database.admin.db.insert(projectEvidence).values([
      { ...evidenceInput(tenants.a), id: olderId, createdAt: new Date('2026-01-01T00:00:00Z') },
      { ...evidenceInput(tenants.a), id: sameTimeId },
      { ...evidenceInput(tenants.a), id: newerId, createdAt: new Date('2026-03-01T00:00:00Z') },
    ]);
    const expected = [newerId, sameTimeId, knowledge.a.evidenceId, olderId];
    expect(
      (await evidence.listByProject({ ...tenants.a, limit: 100 })).map((row) => row.id),
    ).toEqual(expected);
    expect((await evidence.listByProject({ ...tenants.a, limit: 2 })).map((row) => row.id)).toEqual(
      expected.slice(0, 2),
    );
    const result = await evidence.listByProject({ ...tenants.a, limit: 1 });
    expect(result[0]).toMatchObject({
      summary: evidenceInput(tenants.a).summary,
      details: evidenceInput(tenants.a).details,
      skills: ['TypeScript', 'PostgreSQL'],
      capabilities: ['Data integrity'],
      businessOutcomes: ['Isolated client records'],
    });
  });

  it('orders recent notes by creation and descending UUID ties before applying the limit', async () => {
    const sameTimeId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const newerId = randomUUID();
    const olderId = randomUUID();
    await database.admin.db.insert(projectNotes).values([
      {
        ...noteInput(tenants.a),
        id: olderId,
        idempotencyKey: 'older',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      { ...noteInput(tenants.a), id: sameTimeId, idempotencyKey: 'tie' },
      {
        ...noteInput(tenants.a),
        id: newerId,
        idempotencyKey: 'newer',
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
    ]);
    const expected = [newerId, sameTimeId, knowledge.a.noteId, olderId];
    expect(
      (await notes.listRecentByProject({ ...tenants.a, limit: 100 })).map((row) => row.id),
    ).toEqual(expected);
    expect(
      (await notes.listRecentByProject({ ...tenants.a, limit: 2 })).map((row) => row.id),
    ).toEqual(expected.slice(0, 2));
    expect((await notes.listRecentByProject({ ...tenants.a, limit: 1 }))[0]).toMatchObject({
      authorUserId: tenants.a.userId,
      category: 'decision',
      content: noteInput(tenants.a).content,
    });
  });

  it('keeps project evidence and notes separate inside one tenant', async () => {
    const secondId = randomUUID();
    await database.admin.db
      .insert(projects)
      .values({ ...projectInput(tenants.a.tenantId, null), id: secondId, slug: 'second-project' });
    await database.admin.db
      .insert(projectEvidence)
      .values({ ...evidenceInput(tenants.a), projectId: secondId });
    await database.admin.db
      .insert(projectNotes)
      .values({ ...noteInput(tenants.a), projectId: secondId, idempotencyKey: 'second-project' });
    expect(
      (await evidence.listByProject({ ...tenants.a, limit: 100 })).map((row) => row.id),
    ).toEqual([knowledge.a.evidenceId]);
    expect(
      (await notes.listRecentByProject({ ...tenants.a, limit: 100 })).map((row) => row.id),
    ).toEqual([knowledge.a.noteId]);
  });

  it('returns tenant-wide open blockers with optional project and severity filters, oldest first', async () => {
    const secondId = randomUUID();
    await database.admin.db
      .insert(projects)
      .values({ ...projectInput(tenants.a.tenantId, null), id: secondId, slug: 'second-project' });
    const oldestId = randomUUID();
    const tiedId = '00000000-0000-4000-8000-000000000000';
    const secondBlockerId = randomUUID();
    await database.admin.db.insert(projectBlockers).values([
      {
        ...blockerInput(tenants.a),
        id: oldestId,
        severity: 'low',
        blockedSince: new Date('2026-01-01T00:00:00Z'),
      },
      { ...blockerInput(tenants.a), id: tiedId },
      {
        ...blockerInput(tenants.a),
        id: secondBlockerId,
        projectId: secondId,
        severity: 'critical',
        blockedSince: new Date('2026-03-01T00:00:00Z'),
      },
      {
        ...blockerInput(tenants.a),
        status: 'resolved',
        resolvedAt: new Date('2026-02-02T00:00:00Z'),
      },
    ]);
    const scope = { tenantId: tenants.a.tenantId, limit: 100 };
    const expected = [oldestId, tiedId, knowledge.a.blockerId, secondBlockerId];
    expect((await blockers.listOpen(scope)).map((row) => row.id)).toEqual(expected);
    expect((await blockers.listOpen({ ...scope, limit: 2 })).map((row) => row.id)).toEqual(
      expected.slice(0, 2),
    );
    expect(
      (await blockers.listOpen({ ...scope, projectId: tenants.a.projectId })).map((row) => row.id),
    ).toEqual(expected.slice(0, 3));
    expect((await blockers.listOpen({ ...scope, severity: 'high' })).map((row) => row.id)).toEqual([
      tiedId,
      knowledge.a.blockerId,
    ]);
    expect(
      (
        await blockers.listOpen({ ...scope, projectId: secondId, severity: 'critical', limit: 1 })
      ).map((row) => row.id),
    ).toEqual([secondBlockerId]);
    expect(await blockers.listOpen({ ...scope, projectId: secondId, severity: 'high' })).toEqual(
      [],
    );
    expect(await blockers.listOpen({ ...scope, severity: 'medium' })).toEqual([]);
    expect(
      await blockers.listOpen({ ...scope, projectId: tenants.b.projectId, severity: 'high' }),
    ).toEqual([]);
    expect(
      (await blockers.listOpen({ tenantId: tenants.b.tenantId, severity: 'high', limit: 100 })).map(
        (row) => row.id,
      ),
    ).toEqual([knowledge.b.blockerId]);
  });

  it('safely rejects malformed blocker severity', async () => {
    await expect(
      blockers.listOpen({
        tenantId: tenants.a.tenantId,
        severity: 'invalid' as BlockerSeverity,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('uses a read-only grant on the three knowledge tables', async () => {
    for (const table of ['project_evidence', 'project_blockers', 'project_notes']) {
      const privileges = await database.runtime.pool.query<{
        can_read: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        "SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_read, has_table_privilege(current_user, $1, 'INSERT') AS can_insert, has_table_privilege(current_user, $1, 'UPDATE') AS can_update, has_table_privilege(current_user, $1, 'DELETE') AS can_delete",
        [table],
      );
      expect(privileges.rows).toEqual([
        { can_read: true, can_insert: false, can_update: false, can_delete: false },
      ]);
    }
  });

  it('maps connection failures to safe errors for all three adapters', async () => {
    const closed = openDatabase(parseTestDatabaseUrl(process.env), {
      onIdleError: () => undefined,
    });
    await closed.close();
    const input = { ...tenants.a, limit: 10 };
    for (const operation of [
      () => new PostgresEvidenceRepository(closed.db).listByProject(input),
      () => new PostgresBlockerRepository(closed.db).listOpen(input),
      () => new PostgresNoteRepository(closed.db).listRecentByProject(input),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: 'The repository operation could not be completed.',
      });
    }
  });
});
