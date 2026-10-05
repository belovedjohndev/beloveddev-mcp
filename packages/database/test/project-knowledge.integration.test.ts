import { randomUUID } from 'node:crypto';
import { projectEvidence, projectBlockers, projectNotes } from '@beloveddev/database/schema';
import {
  evidenceTypes,
  blockerSeverities,
  blockerStatuses,
  noteCategories,
} from '@beloveddev/domain/entities';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
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

const tables = [
  ['project_evidence', projectEvidence, 'evidenceId'],
  ['project_blockers', projectBlockers, 'blockerId'],
  ['project_notes', projectNotes, 'noteId'],
] as const;

describe('project knowledge PostgreSQL invariants', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let knowledge: ProjectKnowledgeFixtures;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
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

  it.each(tables)(
    '%s rejects foreign-tenant and missing projects on inserts and updates',
    async (name, _table, key) => {
      for (const projectId of [tenants.b.projectId, randomUUID()]) {
        await expect(
          database.admin.pool.query(`UPDATE "${name}" SET project_id = $1 WHERE id = $2`, [
            projectId,
            knowledge.a[key],
          ]),
        ).rejects.toMatchObject({ code: '23503' });
        const insert =
          name === 'project_evidence'
            ? database.admin.db
                .insert(projectEvidence)
                .values({ ...evidenceInput(tenants.a), projectId })
            : name === 'project_blockers'
              ? database.admin.db
                  .insert(projectBlockers)
                  .values({ ...blockerInput(tenants.a), projectId })
              : database.admin.db
                  .insert(projectNotes)
                  .values({ ...noteInput(tenants.a), projectId, idempotencyKey: randomUUID() });
        await expect(insert).rejects.toMatchObject({ cause: { code: '23503' } });
      }
      for (const tenantId of [tenants.b.tenantId, randomUUID()]) {
        await expect(
          database.admin.pool.query(`UPDATE "${name}" SET tenant_id = $1 WHERE id = $2`, [
            tenantId,
            knowledge.a[key],
          ]),
        ).rejects.toMatchObject({ code: '23503' });
      }
    },
  );

  it.each(tables)('%s prevents deletion or reassignment of its project', async (name) => {
    // Leave only this child's rows so each test proves its own foreign key.
    for (const [other] of tables)
      if (other !== name) await database.admin.pool.query(`DELETE FROM "${other}"`);
    await expect(
      database.admin.pool.query('DELETE FROM projects WHERE id = $1', [tenants.a.projectId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      database.admin.pool.query(
        'UPDATE projects SET tenant_id = $1, client_id = NULL, slug = $2 WHERE id = $3',
        [tenants.b.tenantId, 'reassigned', tenants.a.projectId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  const requiredFields = [
    ...[
      'id',
      'tenant_id',
      'project_id',
      'type',
      'title',
      'summary',
      'details',
      'skills',
      'capabilities',
      'business_outcomes',
      'created_at',
      'updated_at',
    ].map((column) => ['project_evidence', column, 'evidenceId'] as const),
    ...[
      'id',
      'tenant_id',
      'project_id',
      'title',
      'description',
      'severity',
      'status',
      'blocked_since',
      'created_at',
      'updated_at',
    ].map((column) => ['project_blockers', column, 'blockerId'] as const),
    ...[
      'id',
      'tenant_id',
      'project_id',
      'author_user_id',
      'category',
      'content',
      'idempotency_key',
      'created_at',
    ].map((column) => ['project_notes', column, 'noteId'] as const),
  ];
  it.each(requiredFields)('requires %s.%s', async (name, column, key) => {
    await expect(
      database.admin.pool.query(`UPDATE "${name}" SET "${column}" = NULL WHERE id = $1`, [
        knowledge.a[key],
      ]),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it.each([
    ['project_evidence', 'title'],
    ['project_evidence', 'summary'],
    ['project_evidence', 'details'],
    ['project_blockers', 'title'],
    ['project_blockers', 'description'],
    ['project_notes', 'content'],
    ['project_notes', 'idempotency_key'],
  ])('rejects blank %s.%s', async (table, column) => {
    for (const blank of ['', '   ', '\t\r\n']) {
      await expect(
        database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1`, [blank]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it.each([
    ['project_evidence', 'type', evidenceTypes],
    ['project_blockers', 'severity', blockerSeverities],
    ['project_blockers', 'status', blockerStatuses],
    ['project_notes', 'category', noteCategories],
  ] as const)(
    'constrains %s.%s and accepts every specified value',
    async (table, column, values) => {
      await expect(
        database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1`, ['invalid']),
      ).rejects.toMatchObject({ code: '22P02' });
      for (const value of values) {
        const resolution =
          column === 'status'
            ? ", resolved_at = CASE WHEN $1::blocker_status = 'resolved' THEN blocked_since ELSE NULL END"
            : '';
        await database.admin.pool.query(`UPDATE "${table}" SET "${column}" = $1${resolution}`, [
          value,
        ]);
      }
    },
  );

  it.each(['skills', 'capabilities', 'business_outcomes'])(
    'enforces evidence string arrays: %s',
    async (column) => {
      for (const invalid of [
        '{}',
        '[1]',
        '[null]',
        '[{}]',
        '[[]]',
        '[["nested"]]',
        'null',
        '"text"',
      ]) {
        await expect(
          database.admin.pool.query(`UPDATE project_evidence SET "${column}" = $1::jsonb`, [
            invalid,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      }
      for (const valid of ['[]', '["TypeScript","PostgreSQL"]']) {
        await database.admin.pool.query(`UPDATE project_evidence SET "${column}" = $1::jsonb`, [
          valid,
        ]);
      }
    },
  );

  it('enforces blocker resolution and timestamp order on transitions', async () => {
    await expect(
      database.admin.pool.query("UPDATE project_blockers SET status = 'resolved'"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.admin.pool.query('UPDATE project_blockers SET resolved_at = blocked_since'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.admin.pool.query(
        "UPDATE project_blockers SET status = 'resolved', resolved_at = blocked_since - interval '1 second'",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await database.admin.pool.query(
      "UPDATE project_blockers SET status = 'resolved', resolved_at = blocked_since",
    );
    await expect(
      database.admin.pool.query("UPDATE project_blockers SET status = 'open'"),
    ).rejects.toMatchObject({ code: '23514' });
    await database.admin.pool.query(
      "UPDATE project_blockers SET status = 'open', resolved_at = NULL",
    );
  });

  it('requires an existing author and membership in the note tenant', async () => {
    for (const userId of [randomUUID(), tenants.b.userId]) {
      await expect(
        database.admin.pool.query('UPDATE project_notes SET author_user_id = $1 WHERE id = $2', [
          userId,
          knowledge.a.noteId,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    }
    await expect(
      database.admin.pool.query('DELETE FROM tenant_memberships WHERE id = $1', [
        tenants.a.membershipId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      database.admin.pool.query('UPDATE tenant_memberships SET user_id = $1 WHERE id = $2', [
        tenants.b.userId,
        tenants.a.membershipId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      database.admin.pool.query('DELETE FROM users WHERE id = $1', [tenants.a.userId]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('retains history when membership becomes inactive; active authorization is an application concern', async () => {
    await database.admin.pool.query(
      "UPDATE tenant_memberships SET status = 'inactive' WHERE id = $1",
      [tenants.a.membershipId],
    );
    const result = await database.admin.db
      .insert(projectNotes)
      .values({ ...noteInput(tenants.a), idempotencyKey: 'inactive-member-history' })
      .returning();
    expect(result).toHaveLength(1);
  });

  it('enforces idempotency across projects for the same tenant and author', async () => {
    const project = await database.admin.pool.query<{ id: string }>(
      "INSERT INTO projects (tenant_id, name, slug, summary, problem_statement, outcome) VALUES ($1, 'Second', 'second', '', '', '') RETURNING id",
      [tenants.a.tenantId],
    );
    const projectId = project.rows[0]?.id;
    if (!projectId) throw new Error('Missing test project');
    await expect(
      database.admin.db.insert(projectNotes).values({ ...noteInput(tenants.a), projectId }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows the same idempotency key for a different author or tenant', async () => {
    await database.admin.pool.query(
      "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')",
      [tenants.a.tenantId, tenants.b.userId],
    );
    await database.admin.db
      .insert(projectNotes)
      .values({ ...noteInput(tenants.a), authorUserId: tenants.b.userId });
    await database.admin.pool.query(
      "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')",
      [tenants.b.tenantId, tenants.a.userId],
    );
    await database.admin.db
      .insert(projectNotes)
      .values({ ...noteInput(tenants.b), authorUserId: tenants.a.userId });
  });

  it('lets PostgreSQL arbitrate concurrent duplicate note inserts', async () => {
    const input = { ...noteInput(tenants.a), idempotencyKey: 'concurrent-note' };
    const results = await Promise.allSettled([
      database.admin.db.insert(projectNotes).values(input),
      database.admin.db.insert(projectNotes).values(input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { cause: { code: '23505' } },
    });
  });

  it('provides UUID, timestamp, array, and open-blocker defaults', async () => {
    const evidence = await database.admin.pool.query<{
      id: string;
      created_at: Date;
      updated_at: Date;
      skills: unknown;
      capabilities: unknown;
      business_outcomes: unknown;
    }>(
      "INSERT INTO project_evidence (tenant_id, project_id, type, title, summary, details) VALUES ($1, $2, 'feature', 'Title', 'Summary', 'Details') RETURNING *",
      [tenants.a.tenantId, tenants.a.projectId],
    );
    const blocker = await database.admin.pool.query<{
      id: string;
      created_at: Date;
      updated_at: Date;
      blocked_since: Date;
      resolved_at: null;
      status: string;
    }>(
      "INSERT INTO project_blockers (tenant_id, project_id, title, description, severity) VALUES ($1, $2, 'Title', 'Description', 'low') RETURNING *",
      [tenants.a.tenantId, tenants.a.projectId],
    );
    const note = await database.admin.pool.query<{ id: string; created_at: Date }>(
      "INSERT INTO project_notes (tenant_id, project_id, author_user_id, category, content, idempotency_key) VALUES ($1, $2, $3, 'general', 'Content', 'default-note') RETURNING *",
      [tenants.a.tenantId, tenants.a.projectId, tenants.a.userId],
    );
    for (const row of [evidence.rows[0], blocker.rows[0], note.rows[0]]) {
      expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.created_at).toBeInstanceOf(Date);
    }
    expect(evidence.rows[0]).toMatchObject({ skills: [], capabilities: [], business_outcomes: [] });
    expect(evidence.rows[0]?.updated_at).toEqual(evidence.rows[0]?.created_at);
    expect(blocker.rows[0]).toMatchObject({ status: 'open', resolved_at: null });
    expect(blocker.rows[0]?.blocked_since).toEqual(blocker.rows[0]?.created_at);
    expect(blocker.rows[0]?.updated_at).toEqual(blocker.rows[0]?.created_at);
  });
});
