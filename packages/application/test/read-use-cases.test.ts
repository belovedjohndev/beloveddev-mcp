import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import type { CursorCodec, PageCursor } from '../src/pagination.js';
import { PermissionAuthorization, permissionsForRole } from '../src/request-context.js';
import { RepositoryError } from '../src/repository-error.js';
import { GetProfile } from '../src/use-cases/get-profile.js';
import { ListProjects } from '../src/use-cases/list-projects.js';
import { GetProject } from '../src/use-cases/get-project.js';
import { GetBlockers } from '../src/use-cases/get-blockers.js';

describe('read use cases without MCP', () => {
  let fixture: ReturnType<typeof createReadFixture>;
  const authorization = new PermissionAuthorization();
  let decoded: PageCursor;
  let codec: CursorCodec;
  beforeEach(() => {
    fixture = createReadFixture();
    decoded = {
      version: 1,
      kind: 'projects',
      tenantId: fixture.context.tenantId,
      status: null,
      clientId: null,
      query: null,
      position: { id: fixture.project.id },
    };
    codec = { encode: vi.fn(() => 'opaque-next-page'), decode: vi.fn(() => decoded) };
  });

  it.each(['owner', 'member', 'viewer'] as const)(
    '%s has exactly the implemented read permissions',
    (role) => {
      expect(permissionsForRole(role)).toEqual(['profile:read', 'projects:read']);
      expect(Object.isFrozen(permissionsForRole(role))).toBe(true);
    },
  );

  it.each(['profile', 'projects', 'project', 'blockers'] as const)(
    '%s denies missing/unauthorized context before repository work',
    async (kind) => {
      const r = fixture.repositories;
      const operation =
        kind === 'profile'
          ? new GetProfile(r.profiles, authorization)
          : kind === 'projects'
            ? new ListProjects(r.projects, authorization, codec)
            : kind === 'project'
              ? new GetProject(r, authorization)
              : new GetBlockers(r.blockers, authorization, codec);
      const input = kind === 'project' ? { projectId: fixture.project.id } : {};
      await expect(operation.execute(null, input)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(
        operation.execute({ ...fixture.context, permissions: [] }, input),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fixture.calls).toEqual([]);
    },
  );

  it('loads the scoped parent before bounded child repositories', async () => {
    const result = await new GetProject(fixture.repositories, authorization).execute(
      fixture.context,
      { projectId: fixture.project.id },
    );
    expect(result.project.id).toBe(fixture.project.id);
    expect(fixture.calls[0]).toEqual({
      method: 'project',
      input: { tenantId: fixture.context.tenantId, projectId: fixture.project.id },
    });
    for (const [method, limit] of [
      ['evidence', 20],
      ['blockers', 20],
      ['notes', 10],
    ] as const) {
      expect(fixture.calls).toContainEqual({
        method,
        input: { tenantId: fixture.context.tenantId, projectId: fixture.project.id, limit },
      });
    }
  });

  it('stops aggregate loading when the parent is foreign or missing', async () => {
    const useCase = new GetProject(fixture.repositories, authorization);
    for (const projectId of [fixture.otherProject.id, fixtureId(999)]) {
      await expect(useCase.execute(fixture.context, { projectId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(fixture.calls.map((call) => call.method)).toEqual(['project', 'project']);
  });

  it('does not load a client for a no-client project', async () => {
    fixture.data.projects[0] = { ...fixture.project, clientId: null };
    const result = await new GetProject(fixture.repositories, authorization).execute(
      fixture.context,
      { projectId: fixture.project.id },
    );
    expect(result.client).toBeNull();
    expect(fixture.calls.map((call) => call.method)).not.toContain('client');
  });

  it.each(['INVALID_INPUT', 'UNAVAILABLE', 'CONFLICT'] as const)(
    'maps repository %s failures at the application boundary',
    async (code) => {
      vi.spyOn(fixture.repositories.profiles, 'getByTenant').mockRejectedValue(
        new RepositoryError(code),
      );
      await expect(
        new GetProfile(fixture.repositories.profiles, authorization).execute(fixture.context, {}),
      ).rejects.toMatchObject({
        code:
          code === 'INVALID_INPUT'
            ? 'VALIDATION_ERROR'
            : code === 'CONFLICT'
              ? 'CONFLICT'
              : 'INTERNAL_ERROR',
      });
    },
  );

  it('validates direct application input without trusting TypeScript alone', async () => {
    const useCase = new ListProjects(fixture.repositories.projects, authorization, codec);
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { status: 'bad' },
      { tenantId: fixture.otherContext.tenantId },
      { query: '   ' },
    ]) {
      await expect(useCase.execute(fixture.context, input)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(fixture.calls).toEqual([]);
  });

  it('propagates project cursor positions with trusted tenant scope', async () => {
    await new ListProjects(fixture.repositories.projects, authorization, codec).execute(
      fixture.context,
      { cursor: 'opaque' },
    );
    expect(fixture.calls[0]).toEqual({
      method: 'projects',
      input: { tenantId: fixture.context.tenantId, limit: 20, after: { id: fixture.project.id } },
    });
  });

  it.each(['tenant', 'status', 'client', 'query', 'kind'] as const)(
    'rejects project cursor %s mismatch before queries',
    async (field) => {
      if (field === 'tenant') decoded = { ...decoded, tenantId: fixture.otherContext.tenantId };
      if (decoded.kind === 'projects') {
        if (field === 'status') decoded = { ...decoded, status: 'paused' };
        if (field === 'client') decoded = { ...decoded, clientId: fixture.client.id };
        if (field === 'query') decoded = { ...decoded, query: 'different' };
      }
      if (field === 'kind')
        decoded = {
          version: 1,
          kind: 'blockers',
          tenantId: fixture.context.tenantId,
          projectId: null,
          severity: null,
          position: { id: fixture.blocker.id, blockedSince: '2026-02-01T09:00:00.000000Z' },
        };
      await expect(
        new ListProjects(fixture.repositories.projects, authorization, codec).execute(
          fixture.context,
          { cursor: 'opaque' },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(fixture.calls).toEqual([]);
    },
  );

  it.each(['tenant', 'project', 'severity', 'kind'] as const)(
    'rejects blocker cursor %s mismatch before queries',
    async (field) => {
      decoded = {
        version: 1,
        kind: 'blockers',
        tenantId: fixture.context.tenantId,
        projectId: null,
        severity: null,
        position: { id: fixture.blocker.id, blockedSince: '2026-02-01T09:00:00.000000Z' },
      };
      if (field === 'tenant') decoded = { ...decoded, tenantId: fixture.otherContext.tenantId };
      if (field === 'project') decoded = { ...decoded, projectId: fixture.project.id };
      if (field === 'severity') decoded = { ...decoded, severity: 'critical' };
      if (field === 'kind')
        decoded = {
          version: 1,
          kind: 'projects',
          tenantId: fixture.context.tenantId,
          status: null,
          clientId: null,
          query: null,
          position: { id: fixture.project.id },
        };
      await expect(
        new GetBlockers(fixture.repositories.blockers, authorization, codec).execute(
          fixture.context,
          { cursor: 'opaque' },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(fixture.calls).toEqual([]);
    },
  );

  it('only emits continuation when the repository reports another page', async () => {
    fixture.data.projects.push({ ...fixture.project, id: fixtureId(30) });
    const encodeSpy = vi.spyOn(codec, 'encode');

    const useCase = new ListProjects(fixture.repositories.projects, authorization, codec);
    const first = await useCase.execute(fixture.context, { limit: 1 });

    expect(first.nextCursor).toBe('opaque-next-page');

    expect(encodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: fixture.context.tenantId,
        kind: 'projects',
        position: { id: fixture.project.id },
      }),
    );
    const all = await useCase.execute(fixture.context, { limit: 100 });
    expect(all.nextCursor).toBeUndefined();
  });
});
