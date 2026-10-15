import { noteCategories } from '@beloveddev/domain/entities';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../src/application-error.js';
import type { ProjectNoteCreationRepository } from '../src/repositories.js';
import { RepositoryError } from '../src/repository-error.js';
import {
  PermissionAuthorization,
  permissionsForRole,
  type RequestContext,
} from '../src/request-context.js';
import { CreateProjectNote } from '../src/use-cases/create-project-note.js';
import { createProjectNoteInput } from '../src/write-inputs.js';

describe('CreateProjectNote', () => {
  let fixture: ReturnType<typeof createReadFixture>;
  let context: RequestContext;
  let create: ReturnType<typeof vi.fn<ProjectNoteCreationRepository['create']>>;
  let operation: CreateProjectNote;

  beforeEach(() => {
    fixture = createReadFixture();
    context = { ...fixture.context, role: 'owner', permissions: permissionsForRole('owner') };
    create = vi.fn(() => Promise.resolve({ note: fixture.note, created: true }));
    operation = new CreateProjectNote({ create }, new PermissionAuthorization());
  });

  function input() {
    return {
      projectId: fixture.project.id,
      category: fixture.note.category,
      content: fixture.note.content,
      idempotencyKey: fixture.note.idempotencyKey,
    };
  }

  it('rejects missing context before input validation and persistence', async () => {
    await expect(operation.execute(null, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('denies viewers before validation and protected persistence', async () => {
    await expect(
      operation.execute(
        { ...context, role: 'viewer', permissions: permissionsForRole('viewer') },
        {},
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(permissionsForRole('viewer')).not.toContain('project_notes:create');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['owner', 'member'] as const)(
    'permits %s using trusted tenant and author',
    async (role) => {
      const scope = { ...context, role, permissions: permissionsForRole(role) };
      const result = await operation.execute(scope, input());
      expect(create).toHaveBeenCalledExactlyOnceWith({
        ...input(),
        tenantId: scope.tenantId,
        authorUserId: scope.userId,
        requestId: scope.requestId,
      });
      expect(result).toEqual({
        note: {
          id: fixture.note.id,
          projectId: fixture.note.projectId,
          category: fixture.note.category,
          content: fixture.note.content,
          createdAt: fixture.note.createdAt.toISOString(),
        },
        created: true,
      });
    },
  );

  it('requires the write permission independently of other read permissions', async () => {
    await expect(
      operation.execute({ ...context, permissions: ['projects:read'] }, input()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: 'invalid' },
    { category: 'invalid' },
    { content: '' },
    { content: ' \t\n\u2003' },
    { content: 'x'.repeat(10_001) },
    { content: 'invalid\0text' },
    { content: 'invalid\uD800text' },
    { idempotencyKey: 'short' },
    { idempotencyKey: ' '.repeat(8) },
    { idempotencyKey: 'x'.repeat(129) },
    { idempotencyKey: 'invalid\0key' },
    { idempotencyKey: 'invalid\uDC00key' },
    { tenantId: fixtureId(901) },
    { authorUserId: fixtureId(902) },
    { userId: fixtureId(902) },
    { requestId: fixtureId(903) },
    { permissions: ['project_notes:create'] },
  ])('rejects invalid or untrusted input fields: %j', async (change) => {
    await expect(operation.execute(context, { ...input(), ...change })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['projectId', 'category', 'content', 'idempotencyKey'] as const)(
    'requires %s',
    async (field) => {
      const data: Record<string, unknown> = input();
      delete data[field];
      await expect(operation.execute(context, data)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(noteCategories)('validates category %s and exact boundary text', (category) => {
    const data = {
      ...input(),
      category,
      content: ' '.repeat(9_999) + 'x',
      idempotencyKey: 'x'.repeat(128),
    };
    expect(createProjectNoteInput.parse(data)).toEqual(data);
    expect(
      createProjectNoteInput.safeParse({ ...data, content: 'x', idempotencyKey: '12345678' })
        .success,
    ).toBe(true);
  });

  it('preserves content, Unicode, and opaque key whitespace without normalization', async () => {
    const data = { ...input(), content: '  café 🚀\n\tcode  ', idempotencyKey: ' request-key ' };
    await operation.execute(context, data);
    expect(create.mock.calls[0]?.[0]).toMatchObject(data);
  });

  it('returns the original public note on an identical retry', async () => {
    create.mockResolvedValueOnce({ note: fixture.note, created: false });
    const result = await operation.execute(context, input());
    expect(result.created).toBe(false);
    expect(result.note.id).toBe(fixture.note.id);
    expect(result.note.createdAt).toBe(fixture.note.createdAt.toISOString());
    expect(result.note).not.toHaveProperty('tenantId');
    expect(result.note).not.toHaveProperty('authorUserId');
    expect(result.note).not.toHaveProperty('idempotencyKey');
  });

  it('maps a tenant-scoped missing project to NOT_FOUND', async () => {
    create.mockResolvedValueOnce(null);
    await expect(operation.execute(context, input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    [new RepositoryError('CONFLICT'), 'CONFLICT'],
    [new RepositoryError('UNAVAILABLE'), 'INTERNAL_ERROR'],
    [new Error('SQL password=secret C:\\private\\path'), 'INTERNAL_ERROR'],
  ] as const)('maps persistence failures safely', async (failure, code) => {
    create.mockRejectedValueOnce(failure);
    await expect(operation.execute(context, input())).rejects.toEqual(new ApplicationError(code));
  });
});
