import { randomUUID } from 'node:crypto';
import { ApplicationError } from '@beloveddev/application/application-error';
import {
  CreateProjectNote,
  type CreateProjectNoteResult,
} from '@beloveddev/application/use-cases/create-project-note';
import {
  PermissionAuthorization,
  permissionsForRole,
  type RequestContext,
} from '@beloveddev/application/request-context';
import { auditLogs, projectNotes, projects, tenantMemberships } from '@beloveddev/database/schema';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { LocalRequestContextProvider } from '../src/local-request-context.js';
import { PostgresMembershipRepository } from '../src/postgres/membership-repository.js';
import { PostgresProjectNoteCreationRepository } from '../src/postgres/project-note-creation-repository.js';

describe('transactional project note creation with PostgreSQL', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let operation: CreateProjectNote;
  let context: RequestContext;
  let role: string;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      projectNoteWrites: true,
    });
    role = new URL(database.runtimeUrl).username;
    if (!/^beloveddev_test_[0-9a-f]{32}_runtime$/.test(role))
      throw new Error('Unexpected test role');
    const priorGrant = await database.runtime.pool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'projects', 'INSERT') AS allowed",
    );
    expect(priorGrant.rows).toEqual([{ allowed: true }]);
    // Preserve earlier helper grants; prove this command works without that grant.
    await database.admin.pool.query(`REVOKE INSERT ON projects FROM "${role}"`);
    operation = new CreateProjectNote(
      new PostgresProjectNoteCreationRepository(database.runtime.db),
      new PermissionAuthorization(),
    );
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
      tenants.b.membershipId,
    ]);
    context = {
      requestId: randomUUID(),
      tenantId: tenants.a.tenantId,
      userId: tenants.a.userId,
      membershipId: tenants.a.membershipId,
      role: 'owner',
      permissions: permissionsForRole('owner'),
    };
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  function input() {
    return {
      projectId: tenants.a.projectId,
      category: 'decision' as const,
      content: '  Use PostgreSQL. 🚀\n',
      idempotencyKey: 'request-note-001',
    };
  }
  async function records() {
    return {
      notes: await database.admin.db.select().from(projectNotes),
      audits: await database.admin.db.select().from(auditLogs),
    };
  }

  // Hold inserts at an actual PostgreSQL lock until every competing connection
  // reaches it; Promise.all alone would not prove overlap at the insert boundary.
  async function race(payloads: ReturnType<typeof input>[]) {
    const blocker = await database.admin.pool.connect();
    const requestIds = payloads.map(() => randomUUID());
    let pending: Promise<PromiseSettledResult<CreateProjectNoteResult>[]> | undefined;
    let waiters = 0;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE project_notes IN SHARE MODE');
      pending = Promise.allSettled(
        payloads.map((payload, index) =>
          operation.execute(
            { ...context, requestId: requestIds[index] ?? context.requestId },
            payload,
          ),
        ),
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && waiters < payloads.length) {
        const locks = await database.admin.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
          [role],
        );
        waiters = locks.rows[0]?.count ?? 0;
        if (waiters < payloads.length) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release(true);
        // Drain all attempts even on a failed barrier, before fixture cleanup.
        await pending;
      }
    }
    expect(waiters).toBe(payloads.length);
    if (pending === undefined) throw new Error('Concurrent requests were not started');
    return { results: await pending, requestIds };
  }

  it('creates a note and one safe audit atomically using trusted identity', async () => {
    const result = await operation.execute(context, input());
    expect(result.created).toBe(true);
    expect(result.note).toMatchObject({
      projectId: input().projectId,
      category: 'decision',
      content: input().content,
    });
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.notes[0]).toMatchObject({
      id: result.note.id,
      tenantId: context.tenantId,
      authorUserId: context.userId,
      idempotencyKey: input().idempotencyKey,
    });
    expect(saved.audits[0]).toMatchObject({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      requestId: context.requestId,
      action: 'project_note.created',
      resourceType: 'project_note',
      resourceId: result.note.id,
      metadata: { projectId: tenants.a.projectId, category: 'decision' },
    });
    expect(saved.audits[0]?.createdAt).toEqual(saved.notes[0]?.createdAt);
    expect(JSON.stringify(saved.audits)).not.toContain(input().content);
    expect(JSON.stringify(saved.audits)).not.toContain(input().idempotencyKey);
    expect(result.note).not.toHaveProperty('tenantId');
    expect(result.note).not.toHaveProperty('authorUserId');
  });

  it('returns the exact original note on retries and keeps the original audit request ID', async () => {
    const first = await operation.execute(context, input());
    const again = await operation.execute({ ...context, requestId: randomUUID() }, input());
    expect(again).toEqual({ ...first, created: false });
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]?.requestId).toBe(context.requestId);
  });

  it('allows note creation on an archived project', async () => {
    await database.admin.pool.query("UPDATE projects SET status='archived' WHERE id=$1", [
      tenants.a.projectId,
    ]);
    const result = await operation.execute(context, input());
    expect(result.created).toBe(true);
    expect(result.note.projectId).toBe(tenants.a.projectId);
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
  });

  it('returns the original note for repeated uppercase UUID inputs', async () => {
    const projectId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    await database.admin.db.insert(projects).values({
      ...projectInput(tenants.a.tenantId, null),
      id: projectId,
      slug: 'uuid-case',
    });
    const command = { ...input(), projectId: projectId.toUpperCase() };
    const original = await operation.execute(context, command);
    const retry = await operation.execute({ ...context, requestId: randomUUID() }, command);
    const canonicalRetry = await operation.execute(context, { ...command, projectId });
    expect(retry).toEqual({ ...original, created: false });
    expect(canonicalRetry).toEqual(retry);
    expect(original.note.projectId).toBe(projectId);
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]?.metadata.projectId).toBe(projectId);
  });

  it('enforces author membership in the trusted tenant and rolls back a foreign author', async () => {
    await expect(
      operation.execute({ ...context, userId: tenants.b.userId }, input()),
    ).rejects.toEqual(new ApplicationError('INTERNAL_ERROR'));
    expect(await records()).toEqual({ notes: [], audits: [] });
  });

  it.each([
    { projectId: 'invalid' },
    { category: 'invalid' },
    { content: ' \t\n' },
    { content: 'x'.repeat(10_001) },
    { content: 'invalid\0text' },
    { idempotencyKey: 'short' },
    { idempotencyKey: ' '.repeat(8) },
    { idempotencyKey: 'x'.repeat(129) },
    { tenantId: randomUUID() },
    { authorUserId: randomUUID() },
  ])('rejects malformed command input without either write: %j', async (change) => {
    await expect(operation.execute(context, { ...input(), ...change })).rejects.toEqual(
      new ApplicationError('VALIDATION_ERROR'),
    );
    expect(await records()).toEqual({ notes: [], audits: [] });
  });

  it.each(['content', 'category', 'projectId'] as const)(
    'rejects conflicting %s reuse without side effects',
    async (field) => {
      const original = await operation.execute(context, input());
      const secondProjectId = randomUUID();
      if (field === 'projectId')
        await database.admin.db.insert(projects).values({
          ...projectInput(tenants.a.tenantId, null),
          id: secondProjectId,
          slug: 'another-project',
        });
      const conflicting = {
        ...input(),
        ...(field === 'content'
          ? { content: 'Different note' }
          : field === 'category'
            ? { category: 'technical' }
            : { projectId: secondProjectId }),
      };
      await expect(operation.execute(context, conflicting)).rejects.toEqual(
        new ApplicationError('CONFLICT'),
      );
      const saved = await records();
      expect(saved.notes).toHaveLength(1);
      expect(saved.notes[0]?.id).toBe(original.note.id);
      expect(saved.audits).toHaveLength(1);
    },
  );

  it('returns indistinguishable NOT_FOUND for foreign and unknown projects before key lookup', async () => {
    await operation.execute(context, input());
    for (const projectId of [tenants.b.projectId, randomUUID()]) {
      await expect(operation.execute(context, { ...input(), projectId })).rejects.toEqual(
        new ApplicationError('NOT_FOUND'),
      );
    }
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
  });

  it('keeps identical keys independent across tenants and authors', async () => {
    const first = await operation.execute(context, input());
    const member: RequestContext = {
      requestId: randomUUID(),
      tenantId: tenants.b.tenantId,
      userId: tenants.b.userId,
      membershipId: tenants.b.membershipId,
      role: 'member',
      permissions: permissionsForRole('member'),
    };
    const otherTenant = await operation.execute(member, {
      ...input(),
      projectId: tenants.b.projectId,
    });
    const [membership] = await database.admin.db
      .insert(tenantMemberships)
      .values({ tenantId: tenants.a.tenantId, userId: tenants.b.userId, role: 'member' })
      .returning();
    if (membership === undefined) throw new Error('Expected member fixture');
    const otherAuthor = await operation.execute(
      {
        ...member,
        tenantId: tenants.a.tenantId,
        membershipId: membership.id,
        requestId: randomUUID(),
      },
      input(),
    );
    expect(new Set([first.note.id, otherTenant.note.id, otherAuthor.note.id]).size).toBe(3);
    const saved = await records();
    expect(saved.notes).toHaveLength(3);
    expect(saved.audits).toHaveLength(3);
  });

  it('denies unauthenticated and viewer contexts without writing', async () => {
    await expect(operation.execute(null, input())).rejects.toEqual(
      new ApplicationError('UNAUTHENTICATED'),
    );
    await expect(
      operation.execute(
        { ...context, role: 'viewer', permissions: permissionsForRole('viewer') },
        input(),
      ),
    ).rejects.toEqual(new ApplicationError('FORBIDDEN'));
    expect(await records()).toEqual({ notes: [], audits: [] });
  });

  it('honors revocation through the trusted context provider', async () => {
    const provider = new LocalRequestContextProvider(
      { tenantId: tenants.a.tenantId, userId: tenants.a.userId },
      new PostgresMembershipRepository(database.runtime.db),
    );
    const active = await provider.resolve(randomUUID());
    expect(active?.permissions).toContain('project_notes:create');
    await database.admin.pool.query("UPDATE tenant_memberships SET status='inactive' WHERE id=$1", [
      tenants.a.membershipId,
    ]);
    await expect(operation.execute(await provider.resolve(randomUUID()), input())).rejects.toEqual(
      new ApplicationError('UNAUTHENTICATED'),
    );
    expect(await records()).toEqual({ notes: [], audits: [] });
  });

  it('arbitrates overlapping identical requests into exactly one note and audit', async () => {
    const { results, requestIds } = await race(Array.from({ length: 6 }, input));
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const fulfilled = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(fulfilled.filter(({ created }) => created)).toHaveLength(1);
    expect(fulfilled.filter(({ created }) => !created)).toHaveLength(5);
    expect(new Set(fulfilled.map(({ note }) => note.id)).size).toBe(1);
    expect(
      fulfilled.every(({ note }) => JSON.stringify(note) === JSON.stringify(fulfilled[0]?.note)),
    ).toBe(true);
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    const winner = results.findIndex(
      (result) => result.status === 'fulfilled' && result.value.created,
    );
    expect(saved.audits[0]?.requestId).toBe(requestIds[winner]);
  });

  it('arbitrates overlapping conflicting requests into one commit and one CONFLICT', async () => {
    const { results } = await race([input(), { ...input(), content: 'Different concurrent note' }]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status !== 'rejected') throw new Error('Expected a conflicting request');
    expect(failed.reason).toEqual(new ApplicationError('CONFLICT'));
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
  });

  it.each(['note', 'audit', 'commit'] as const)(
    'rolls back both records on %s failure and allows a safe retry',
    async (stage) => {
      const table = stage === 'note' ? 'project_notes' : 'audit_logs';
      await database.admin.pool.query(
        `CREATE FUNCTION fail_note_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL failure' USING ERRCODE = '23514'; END; $$`,
      );
      try {
        await database.admin.pool.query(
          stage === 'commit'
            ? `CREATE CONSTRAINT TRIGGER fail_note_write AFTER INSERT ON audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_note_write()`
            : `CREATE TRIGGER fail_note_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_note_write()`,
        );
        await expect(operation.execute(context, input())).rejects.toEqual(
          new ApplicationError('INTERNAL_ERROR'),
        );
        expect(await records()).toEqual({ notes: [], audits: [] });
      } finally {
        await database.admin.pool.query(`DROP TRIGGER IF EXISTS fail_note_write ON ${table}`);
        await database.admin.pool.query('DROP FUNCTION fail_note_write()');
      }
      expect((await operation.execute(context, input())).created).toBe(true);
      const saved = await records();
      expect(saved.notes).toHaveLength(1);
      expect(saved.audits).toHaveLength(1);
    },
  );

  it('rolls back if audit INSERT privileges are absent', async () => {
    await database.admin.pool.query(`REVOKE INSERT ON audit_logs FROM "${role}"`);
    try {
      await expect(operation.execute(context, input())).rejects.toEqual(
        new ApplicationError('INTERNAL_ERROR'),
      );
      expect(await records()).toEqual({ notes: [], audits: [] });
    } finally {
      await database.admin.pool.query(`GRANT INSERT ON audit_logs TO "${role}"`);
    }
  });

  it('uses append-only, non-owner runtime permissions without unrelated writes or audit reads', async () => {
    const privileges = await database.runtime.pool.query<{
      can_note_insert: boolean;
      can_audit_insert: boolean;
      can_note_update: boolean;
      can_note_delete: boolean;
      can_audit_update: boolean;
      can_audit_delete: boolean;
      can_audit_read: boolean;
      can_project_insert: boolean;
      can_create: boolean;
      superuser: boolean;
    }>(
      `SELECT has_table_privilege(current_user, 'project_notes', 'INSERT') AS can_note_insert,
       has_table_privilege(current_user, 'audit_logs', 'INSERT') AS can_audit_insert,
       has_table_privilege(current_user, 'project_notes', 'UPDATE') AS can_note_update,
       has_table_privilege(current_user, 'project_notes', 'DELETE') AS can_note_delete,
       has_table_privilege(current_user, 'audit_logs', 'UPDATE') AS can_audit_update,
       has_table_privilege(current_user, 'audit_logs', 'DELETE') AS can_audit_delete,
       has_table_privilege(current_user, 'audit_logs', 'SELECT') AS can_audit_read,
       has_table_privilege(current_user, 'projects', 'INSERT') AS can_project_insert,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
       (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`,
    );
    expect(privileges.rows).toEqual([
      {
        can_note_insert: true,
        can_audit_insert: true,
        can_note_update: false,
        can_note_delete: false,
        can_audit_update: false,
        can_audit_delete: false,
        can_audit_read: false,
        can_project_insert: false,
        can_create: false,
        superuser: false,
      },
    ]);
    const created = await operation.execute(context, input());
    await expect(
      database.runtime.pool.query('UPDATE project_notes SET content=$1 WHERE id=$2', [
        'Changed',
        created.note.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(database.runtime.pool.query('DELETE FROM audit_logs')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      database.runtime.pool.query('TRUNCATE project_notes CASCADE'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
