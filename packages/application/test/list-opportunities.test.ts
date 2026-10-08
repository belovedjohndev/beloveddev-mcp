import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Opportunity } from '@beloveddev/domain/entities';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import { ApplicationError } from '../src/application-error.js';
import type { CursorCodec, PageCursor } from '../src/pagination.js';
import type { OpportunityListQuery, OpportunityPage } from '../src/repositories.js';
import { RepositoryError } from '../src/repository-error.js';
import { PermissionAuthorization } from '../src/request-context.js';
import { ListOpportunities } from '../src/use-cases/list-opportunities.js';

describe('ListOpportunities', () => {
  const authorization = new PermissionAuthorization();
  let fixture: ReturnType<typeof createReadFixture>;
  let opportunity: Opportunity;
  let listPage: ReturnType<typeof vi.fn<(input: OpportunityListQuery) => Promise<OpportunityPage>>>;
  let decoded: PageCursor;
  let encode: ReturnType<typeof vi.fn<(cursor: PageCursor) => string>>;
  let decode: ReturnType<typeof vi.fn<(token: string) => PageCursor>>;
  let cursors: CursorCodec;

  beforeEach(() => {
    fixture = createReadFixture();
    const time = new Date('2026-09-01T12:00:00Z');
    opportunity = {
      id: fixtureId(40),
      tenantId: fixture.context.tenantId,
      source: 'upwork',
      externalId: 'private-external-id',
      title: 'TypeScript platform',
      clientName: 'Example Client',
      description: 'Private complete description',
      projectType: 'SaaS',
      budgetType: 'fixed',
      amountMin: '5000.00',
      amountMax: '9000.00',
      currency: 'USD',
      requiredSkills: ['TypeScript'],
      preferredSkills: ['PostgreSQL'],
      status: 'reviewing',
      sourceUrl: 'https://example.test/opportunity/40',
      publishedAt: time,
      createdAt: time,
      updatedAt: time,
    };
    listPage = vi.fn(() => Promise.resolve({ items: [opportunity], nextPosition: null }));
    decoded = {
      version: 1,
      kind: 'opportunities',
      tenantId: fixture.context.tenantId,
      filterFingerprint: '0'.repeat(64),
      position: {
        id: opportunity.id,
        orderingTimestamp: '2026-09-01T12:00:00.000000Z',
      },
    };
    encode = vi.fn(() => 'opaque-next-page');
    decode = vi.fn(() => decoded);
    cursors = { encode, decode };
  });

  it('authorizes before input validation and repository work', async () => {
    const useCase = new ListOpportunities({ listPage }, authorization, cursors);
    await expect(
      useCase.execute(null, { tenantId: fixture.context.tenantId }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      useCase.execute({ ...fixture.context, permissions: [] }, { limit: 0 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listPage).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('uses trusted tenant scope, canonical filters, and the default limit', async () => {
    const result = await new ListOpportunities({ listPage }, authorization, cursors).execute(
      fixture.context,
      { status: 'reviewing', source: '  UPWORK  ', query: '  TYPESCRIPT  ' },
    );
    expect(listPage).toHaveBeenCalledWith({
      tenantId: fixture.context.tenantId,
      status: 'reviewing',
      source: 'upwork',
      query: 'typescript',
      limit: 20,
    });
    expect(result).toEqual({
      opportunities: [
        {
          id: opportunity.id,
          source: 'upwork',
          title: opportunity.title,
          clientName: opportunity.clientName,
          projectType: opportunity.projectType,
          budgetType: 'fixed',
          amountMin: '5000.00',
          amountMax: '9000.00',
          currency: 'USD',
          requiredSkills: ['TypeScript'],
          preferredSkills: ['PostgreSQL'],
          status: 'reviewing',
          sourceUrl: opportunity.sourceUrl,
          publishedAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    });
    expect(result.opportunities[0]).not.toHaveProperty('tenantId');
    expect(result.opportunities[0]).not.toHaveProperty('externalId');
    expect(result.opportunities[0]).not.toHaveProperty('description');
  });

  it('accepts the maximum limit and rejects invalid direct application inputs', async () => {
    const useCase = new ListOpportunities({ listPage }, authorization, cursors);
    await useCase.execute(fixture.context, { limit: 100 });
    expect(listPage).toHaveBeenLastCalledWith({ tenantId: fixture.context.tenantId, limit: 100 });
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { status: 'invalid' },
      { source: 'not valid' },
      { source: 'a'.repeat(101) },
      { query: '   ' },
      { query: 'a'.repeat(201) },
      { tenantId: fixture.otherContext.tenantId },
    ]) {
      await expect(useCase.execute(fixture.context, input)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('encodes and resumes a cursor bound to all normalized filter semantics', async () => {
    listPage.mockResolvedValueOnce({
      items: [opportunity],
      nextPosition: {
        id: opportunity.id,
        orderingTimestamp: '2026-09-01T12:00:00.000000Z',
      },
    });
    const useCase = new ListOpportunities({ listPage }, authorization, cursors);
    const first = await useCase.execute(fixture.context, {
      status: 'reviewing',
      source: 'upwork',
      query: 'typescript',
      limit: 1,
    });
    expect(first.nextCursor).toBe('opaque-next-page');
    const cursor = encode.mock.calls[0]?.[0];
    if (!cursor || cursor.kind !== 'opportunities') throw new Error('Expected opportunity cursor');
    expect(cursor.filterFingerprint).toMatch(/^[0-9a-f]{64}$/);
    decoded = cursor;
    listPage.mockClear();
    await useCase.execute(fixture.context, {
      status: 'reviewing',
      source: ' UPWORK ',
      query: ' TYPESCRIPT ',
      limit: 1,
      cursor: 'opaque',
    });
    expect(listPage).toHaveBeenCalledWith({
      tenantId: fixture.context.tenantId,
      status: 'reviewing',
      source: 'upwork',
      query: 'typescript',
      limit: 1,
      after: cursor.position,
    });
  });

  it.each([
    ['tenant', { source: 'upwork', query: 'typescript', status: 'reviewing' }],
    ['status', { source: 'upwork', query: 'typescript', status: 'new' }],
    ['source', { source: 'manual', query: 'typescript', status: 'reviewing' }],
    ['query', { source: 'upwork', query: 'postgresql', status: 'reviewing' }],
  ] as const)(
    'rejects a cursor with changed %s semantics before repository access',
    async (field, input) => {
      listPage.mockResolvedValueOnce({
        items: [],
        nextPosition: {
          id: opportunity.id,
          orderingTimestamp: '2026-09-01T12:00:00.000000Z',
        },
      });
      const useCase = new ListOpportunities({ listPage }, authorization, cursors);
      await useCase.execute(fixture.context, {
        source: 'upwork',
        query: 'typescript',
        status: 'reviewing',
      });
      const cursor = encode.mock.calls[0]?.[0];
      if (!cursor || cursor.kind !== 'opportunities')
        throw new Error('Expected opportunity cursor');
      decoded =
        field === 'tenant' ? { ...cursor, tenantId: fixture.otherContext.tenantId } : cursor;
      listPage.mockClear();
      await expect(
        useCase.execute(fixture.context, { ...input, cursor: 'opaque' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(listPage).not.toHaveBeenCalled();
    },
  );

  it('rejects wrong-kind and malformed cursors before repository access', async () => {
    const useCase = new ListOpportunities({ listPage }, authorization, cursors);
    decoded = {
      version: 1,
      kind: 'projects',
      tenantId: fixture.context.tenantId,
      status: null,
      clientId: null,
      query: null,
      position: { id: fixture.project.id },
    };
    await expect(useCase.execute(fixture.context, { cursor: 'opaque' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    decode.mockImplementationOnce(() => {
      throw new ApplicationError('VALIDATION_ERROR');
    });
    await expect(useCase.execute(fixture.context, { cursor: 'tampered' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_INPUT', 'VALIDATION_ERROR'],
    ['UNAVAILABLE', 'INTERNAL_ERROR'],
  ] as const)('maps repository %s failures to %s', async (repositoryCode, applicationCode) => {
    listPage.mockRejectedValueOnce(new RepositoryError(repositoryCode));
    await expect(
      new ListOpportunities({ listPage }, authorization, cursors).execute(fixture.context, {}),
    ).rejects.toMatchObject({ code: applicationCode });
  });
});
