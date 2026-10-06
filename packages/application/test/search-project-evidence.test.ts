import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceSearchPage, EvidenceSearchQuery } from '../src/repositories.js';
import type { CursorCodec, PageCursor } from '../src/pagination.js';
import { ApplicationError } from '../src/application-error.js';
import { RepositoryError } from '../src/repository-error.js';
import { PermissionAuthorization } from '../src/request-context.js';
import { SearchProjectEvidence } from '../src/use-cases/search-project-evidence.js';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';

describe('SearchProjectEvidence', () => {
  const authorization = new PermissionAuthorization();
  let fixture: ReturnType<typeof createReadFixture>;
  let search: ReturnType<typeof vi.fn<(input: EvidenceSearchQuery) => Promise<EvidenceSearchPage>>>;
  let decoded: PageCursor;
  let cursors: CursorCodec;
  let encode: ReturnType<typeof vi.fn<(cursor: PageCursor) => string>>;
  let decode: ReturnType<typeof vi.fn<(token: string) => PageCursor>>;

  beforeEach(() => {
    fixture = createReadFixture();
    search = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            evidenceId: fixture.evidence.id,
            projectId: fixture.project.id,
            projectName: fixture.project.name,
            type: fixture.evidence.type,
            title: fixture.evidence.title,
            summary: fixture.evidence.summary,
            skills: fixture.evidence.skills,
            capabilities: fixture.evidence.capabilities,
            businessOutcomes: fixture.evidence.businessOutcomes,
            relevanceScore: 0.5,
          },
        ],
        nextPosition: null,
      }),
    );
    decoded = {
      version: 1,
      kind: 'evidence_search',
      tenantId: fixture.context.tenantId,
      queryFingerprint: '0'.repeat(64),
      position: { id: fixture.evidence.id, relevanceScore: '0.5' },
    };
    encode = vi.fn(() => 'opaque-next-page');
    decode = vi.fn(() => decoded);
    cursors = { encode, decode };
  });

  it('authorizes before validation and repository work', async () => {
    const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
    await expect(useCase.execute(null, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      useCase.execute({ ...fixture.context, permissions: [] }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(search).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('uses trusted tenant scope and propagates normalized filters with the default limit', async () => {
    const result = await new SearchProjectEvidence({ search }, authorization, cursors).execute(
      fixture.context,
      {
        query: '  multi tenant PostgreSQL  ',
        projectIds: [fixtureId(30), fixture.project.id, fixtureId(30)],
        evidenceTypes: ['security', 'architecture', 'security'],
        skills: [' PostgreSQL ', 'react', 'POSTGRESQL'],
      },
    );
    expect(search).toHaveBeenCalledWith({
      tenantId: fixture.context.tenantId,
      query: 'multi tenant PostgreSQL',
      projectIds: [fixture.project.id, fixtureId(30)],
      evidenceTypes: ['architecture', 'security'],
      skills: ['postgresql', 'react'],
      limit: 20,
    });
    expect(result.results).toHaveLength(1);
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('accepts the maximum limit and rejects invalid direct application inputs', async () => {
    const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
    await useCase.execute(fixture.context, { query: 'dashboard', limit: 100 });
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: fixture.context.tenantId, limit: 100 }),
    );
    for (const input of [
      {},
      { query: '   ' },
      { query: 'x', limit: 0 },
      { query: 'x', limit: 101 },
      { query: 'x', projectIds: [] },
      { query: 'x', projectIds: ['invalid'] },
      { query: 'x', evidenceTypes: ['invalid'] },
      { query: 'x', skills: ['   '] },
      { query: 'x', tenantId: fixture.otherContext.tenantId },
    ])
      await expect(useCase.execute(fixture.context, input)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
  });

  it('encodes a signed-cursor payload bound to normalized search semantics', async () => {
    search.mockResolvedValueOnce({
      items: [],
      nextPosition: { id: fixture.evidence.id, relevanceScore: '0.75' },
    });
    const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
    const result = await useCase.execute(fixture.context, {
      query: 'API integration',
      skills: ['React'],
    });
    expect(result.nextCursor).toBe('opaque-next-page');
    const cursor = encode.mock.calls[0]?.[0];
    expect(cursor).toMatchObject({
      version: 1,
      kind: 'evidence_search',
      tenantId: fixture.context.tenantId,
      position: { id: fixture.evidence.id, relevanceScore: '0.75' },
    });
    if (!cursor || cursor.kind !== 'evidence_search') throw new Error('Expected search cursor');
    expect(cursor.queryFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('decodes a compatible cursor and passes its rank position to the repository', async () => {
    search.mockResolvedValueOnce({
      items: [],
      nextPosition: { id: fixture.evidence.id, relevanceScore: '0.75' },
    });
    const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
    await useCase.execute(fixture.context, { query: 'API integration', skills: ['React'] });
    const encoded = encode.mock.calls[0]?.[0];
    if (!encoded) throw new Error('Expected encoded cursor');
    decoded = encoded;
    search.mockClear();
    await useCase.execute(fixture.context, {
      query: 'API integration',
      skills: ['REACT', 'react'],
      cursor: 'opaque',
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: fixture.context.tenantId,
        skills: ['react'],
        after: { id: fixture.evidence.id, relevanceScore: '0.75' },
      }),
    );
  });

  it.each(['kind', 'tenant', 'fingerprint'] as const)(
    'rejects a cursor with incompatible %s before repository access',
    async (field) => {
      const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
      await useCase.execute(fixture.context, { query: 'dashboard' });
      const encoded = encode.mock.calls[0]?.[0];
      // Force a page so the generated fingerprint is available.
      if (!encoded) {
        search.mockResolvedValueOnce({
          items: [],
          nextPosition: { id: fixture.evidence.id, relevanceScore: '0.5' },
        });
        await useCase.execute(fixture.context, { query: 'dashboard' });
      }
      const cursor = encode.mock.calls.at(-1)?.[0];
      if (!cursor || cursor.kind !== 'evidence_search') throw new Error('Expected search cursor');
      decoded =
        field === 'kind'
          ? {
              version: 1,
              kind: 'projects',
              tenantId: fixture.context.tenantId,
              status: null,
              clientId: null,
              query: null,
              position: { id: fixture.project.id },
            }
          : field === 'tenant'
            ? { ...cursor, tenantId: fixture.otherContext.tenantId }
            : { ...cursor, queryFingerprint: 'f'.repeat(64) };
      search.mockClear();
      await expect(
        useCase.execute(fixture.context, { query: 'dashboard', cursor: 'opaque' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('maps malformed cursor and repository failures through application errors', async () => {
    const useCase = new SearchProjectEvidence({ search }, authorization, cursors);
    decode.mockImplementationOnce(() => {
      throw new ApplicationError('VALIDATION_ERROR');
    });
    await expect(
      useCase.execute(fixture.context, { query: 'dashboard', cursor: 'tampered' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    search.mockRejectedValueOnce(new RepositoryError('UNAVAILABLE'));
    await expect(useCase.execute(fixture.context, { query: 'dashboard' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
