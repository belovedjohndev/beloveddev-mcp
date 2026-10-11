import type { Opportunity } from '@beloveddev/domain/entities';
import { EvaluationPolicyV1 } from '@beloveddev/domain/evaluation-policy-v1';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeveloperProfileRepository,
  EvidenceRepository,
  EvidenceSearchPage,
  OpportunityRepository,
} from '../src/repositories.js';
import { RepositoryError } from '../src/repository-error.js';
import {
  PermissionAuthorization,
  permissionsForRole,
  type RequestContext,
} from '../src/request-context.js';
import {
  EvaluateOpportunity,
  opportunityEvaluationEvidenceLimit,
} from '../src/use-cases/evaluate-opportunity.js';

describe('EvaluateOpportunity', () => {
  const authorization = new PermissionAuthorization();
  let fixture: ReturnType<typeof createReadFixture>;
  let opportunity: Opportunity;
  let evidencePage: EvidenceSearchPage;
  let context: RequestContext;
  let getById: ReturnType<typeof vi.fn<OpportunityRepository['getById']>>;
  let getByTenant: ReturnType<typeof vi.fn<DeveloperProfileRepository['getByTenant']>>;
  let search: ReturnType<typeof vi.fn<EvidenceRepository['search']>>;

  beforeEach(() => {
    fixture = createReadFixture();
    opportunity = {
      id: fixtureId(40),
      tenantId: fixture.context.tenantId,
      source: 'upwork',
      externalId: null,
      title: 'TypeScript SaaS platform',
      clientName: 'Example Client',
      description: 'Build a reliable platform.',
      projectType: ' SaaS ',
      budgetType: 'fixed',
      amountMin: '5000.00',
      amountMax: '10000.00',
      currency: 'USD',
      requiredSkills: ['TypeScript', ' PostgreSQL ', 'typescript'],
      preferredSkills: ['Docker', 'POSTGRESQL'],
      status: 'reviewing',
      sourceUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-09-01T12:00:00Z'),
      updatedAt: new Date('2026-09-01T12:00:00Z'),
    };
    evidencePage = {
      items: [
        {
          evidenceId: fixture.evidence.id,
          projectId: fixture.project.id,
          projectName: fixture.project.name,
          type: fixture.evidence.type,
          title: fixture.evidence.title,
          summary: fixture.evidence.summary,
          skills: ['TypeScript', 'PostgreSQL', 'Docker'],
          capabilities: [],
          businessOutcomes: [],
          relevanceScore: 0.75,
        },
      ],
      nextPosition: null,
    };
    context = {
      ...fixture.context,
      role: 'owner',
      permissions: permissionsForRole('owner'),
    };
    getById = vi.fn(() => Promise.resolve(opportunity));
    getByTenant = vi.fn(() => Promise.resolve(fixture.profile));
    search = vi.fn(() => Promise.resolve(evidencePage));
  });

  function useCase(policy: Pick<EvaluationPolicyV1, 'evaluate'> = new EvaluationPolicyV1()) {
    return new EvaluateOpportunity(
      {
        opportunities: { getById },
        profiles: { getByTenant },
        evidence: { search },
      },
      authorization,
      policy,
    );
  }

  it('rejects UNAUTHENTICATED before validation or repository access', async () => {
    await expect(useCase().execute(null, { opportunityId: 'invalid' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(getById).not.toHaveBeenCalled();
    expect(getByTenant).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects a viewer before validation or repository access', async () => {
    await expect(
      useCase().execute(
        { ...fixture.context, role: 'viewer', permissions: permissionsForRole('viewer') },
        { opportunityId: 'invalid' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getById).not.toHaveBeenCalled();
    expect(getByTenant).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each(['owner', 'member'] as const)('permits the %s role', async (role) => {
    const result = await useCase().execute(
      { ...context, role, permissions: permissionsForRole(role) },
      { opportunityId: opportunity.id },
    );
    expect(result.evaluationVersion).toBe('v1');
  });

  it('validates only opportunityId before repository access', async () => {
    for (const input of [
      {},
      { opportunityId: 'invalid' },
      { opportunityId: opportunity.id, tenantId: fixture.otherContext.tenantId },
      { opportunityId: opportunity.id, profile: fixture.profile },
    ]) {
      await expect(useCase().execute(context, input)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(getById).not.toHaveBeenCalled();
  });

  it('loads through trusted tenant scope and performs a bounded OR evidence search', async () => {
    const result = await useCase().execute(context, { opportunityId: opportunity.id });

    expect(getById).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      opportunityId: opportunity.id,
    });
    expect(getByTenant).toHaveBeenCalledWith({ tenantId: context.tenantId });
    expect(search).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      query: '"typescript" OR "postgresql" OR "docker"',
      limit: opportunityEvaluationEvidenceLimit,
    });
    expect(opportunityEvaluationEvidenceLimit).toBe(10);
    expect(result.relevantEvidence).toEqual([
      {
        projectId: fixture.project.id,
        projectName: fixture.project.name,
        evidenceId: fixture.evidence.id,
        title: fixture.evidence.title,
        summary: fixture.evidence.summary,
        relevanceScore: 0.75,
      },
    ]);
  });

  it('falls back from skills to project type and then title', async () => {
    opportunity = {
      ...opportunity,
      requiredSkills: [],
      preferredSkills: [],
      projectType: ' SaaS ',
    };
    await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).toHaveBeenLastCalledWith({
      tenantId: context.tenantId,
      query: '"saas"',
      limit: 10,
    });

    opportunity = { ...opportunity, projectType: null, title: '  API   Platform  ' };
    await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).toHaveBeenLastCalledWith({
      tenantId: context.tenantId,
      query: '"api platform"',
      limit: 10,
    });
  });

  it('returns identical NOT_FOUND errors for foreign and unknown opportunities', async () => {
    getById.mockResolvedValue(null);
    for (const opportunityId of [fixtureId(41), fixtureId(999)]) {
      await expect(useCase().execute(context, { opportunityId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      });
    }
    expect(getById).toHaveBeenNthCalledWith(1, {
      tenantId: context.tenantId,
      opportunityId: fixtureId(41),
    });
    expect(getByTenant).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('bounds oversized collections deterministically with required terms first', async () => {
    const requiredSkills = Array.from({ length: 100 }, (_, index) => `required-${index}`);
    opportunity = {
      ...opportunity,
      requiredSkills,
      preferredSkills: ['preferred-skill'],
    };
    search.mockResolvedValue({ items: [], nextPosition: null });
    const first = await useCase().execute(context, { opportunityId: opportunity.id });
    const second = await useCase().execute(context, { opportunityId: opportunity.id });
    const query = search.mock.calls[0]?.[0].query;
    if (query === undefined) throw new Error('Expected evidence query.');
    expect(query.length).toBeLessThanOrEqual(1000);
    expect(query).toMatch(/^"required-0" OR "required-1"/u);
    expect(query).not.toContain('preferred-skill');
    expect(query).toMatch(/^"[^"]+"(?: OR "[^"]+")*$/u);
    expect(search.mock.calls[1]?.[0]).toEqual(search.mock.calls[0]?.[0]);
    expect(search.mock.calls[0]?.[0]).toMatchObject({ tenantId: context.tenantId, limit: 10 });
    expect(first).toEqual(second);
    expect(first.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
    expect(first.riskFlags.map(({ code }) => code)).not.toContain('no_portfolio_evidence');
  });

  it('omits an individually oversized skill and still searches complete fitting terms', async () => {
    opportunity = {
      ...opportunity,
      requiredSkills: ['x'.repeat(1001), 'PostgreSQL'],
      preferredSkills: ['Docker'],
    };
    const result = await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      query: '"postgresql" OR "docker"',
      limit: 10,
    });
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
  });

  it('skips search safely when no complete skill term fits', async () => {
    opportunity = {
      ...opportunity,
      requiredSkills: ['x'.repeat(1001)],
      preferredSkills: [],
    };
    const result = await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).not.toHaveBeenCalled();
    expect(result.relevantEvidence).toEqual([]);
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
    expect(result.riskFlags.map(({ code }) => code)).not.toContain('no_portfolio_evidence');
  });

  it.each(['projectType', 'title'] as const)('bounds oversized fallback %s text', async (field) => {
    opportunity = {
      ...opportunity,
      requiredSkills: [],
      preferredSkills: [],
      projectType: null,
      [field]: 'a'.repeat(997) + '\u{1F680}' + 'z'.repeat(500),
    };
    const result = await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      query: `"${'a'.repeat(997)}"`,
      limit: 10,
    });
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
  });

  it('keeps model-like operators and embedded quotes inside valid quoted phrases', async () => {
    opportunity = {
      ...opportunity,
      requiredSkills: ['PostgreSQL " OR -Docker', 'TypeScript'],
      preferredSkills: [],
    };
    const result = await useCase().execute(context, { opportunityId: opportunity.id });
    expect(search).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      query: '"postgresql or -docker" OR "typescript"',
      limit: 10,
    });
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
  });

  it('marks a ten-record page incomplete when more repository matches exist', async () => {
    const item = evidencePage.items[0];
    if (!item) throw new Error('Expected evidence fixture.');
    search.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, index) => ({
        ...item,
        evidenceId: fixtureId(100 + index),
      })),
      nextPosition: { id: fixtureId(109), relevanceScore: '0.75' },
    });
    const result = await useCase().execute(context, { opportunityId: opportunity.id });
    expect(result.relevantEvidence).toHaveLength(10);
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
  });

  it('returns NOT_FOUND for a missing developer profile before evidence search', async () => {
    getByTenant.mockResolvedValue(null);
    await expect(
      useCase().execute(context, { opportunityId: opportunity.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(search).not.toHaveBeenCalled();
  });

  it.each(['opportunity', 'profile', 'evidence'] as const)(
    'maps %s repository failures to a safe INTERNAL_ERROR',
    async (repository) => {
      if (repository === 'opportunity') {
        getById.mockRejectedValueOnce(new RepositoryError('UNAVAILABLE'));
      } else if (repository === 'profile') {
        getByTenant.mockRejectedValueOnce(new RepositoryError('UNAVAILABLE'));
      } else {
        search.mockRejectedValueOnce(new RepositoryError('UNAVAILABLE'));
      }
      await expect(
        useCase().execute(context, { opportunityId: opportunity.id }),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'The operation could not be completed.',
      });
    },
  );

  it('propagates the deterministic policy result without changing it', async () => {
    const expected = new EvaluationPolicyV1().evaluate({
      profile: fixture.profile,
      opportunity,
      evidence: evidencePage.items,
    });
    const evaluate = vi.fn(() => expected);
    const result = await useCase({ evaluate }).execute(context, {
      opportunityId: opportunity.id,
    });

    expect(result).toBe(expected);
    expect(evaluate).toHaveBeenCalledWith({
      profile: fixture.profile,
      opportunity,
      evidenceRetrievalIncomplete: false,
      evidence: evidencePage.items.map(
        ({ projectId, projectName, evidenceId, title, summary, skills, relevanceScore }) => ({
          projectId,
          projectName,
          evidenceId,
          title,
          summary,
          skills,
          relevanceScore,
        }),
      ),
    });
  });
});
