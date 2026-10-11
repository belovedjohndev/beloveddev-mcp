import { EvaluateOpportunity } from '@beloveddev/application/use-cases/evaluate-opportunity';
import {
  PermissionAuthorization,
  permissionsForRole,
  type RequestContext,
} from '@beloveddev/application/request-context';
import { projectEvidence } from '@beloveddev/database/schema';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresDeveloperProfileRepository } from '../src/postgres/developer-profile-repository.js';
import { PostgresEvidenceRepository } from '../src/postgres/evidence-repository.js';
import { PostgresOpportunityRepository } from '../src/postgres/opportunity-repository.js';

describe('opportunity evaluation with PostgreSQL repositories', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let operation: EvaluateOpportunity;
  let ownerContext: RequestContext;
  let ownOpportunityId: string;
  let foreignOpportunityId: string;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
  });

  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    const ownOpportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      id: fixtureId(700),
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      preferredSkills: [],
      projectType: 'SaaS',
    });
    const foreignOpportunity = await seedOpportunity(database.admin.db, tenants.b.tenantId, {
      id: fixtureId(701),
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      preferredSkills: [],
      projectType: 'SaaS',
    });
    ownOpportunityId = ownOpportunity.id;
    foreignOpportunityId = foreignOpportunity.id;
    await database.admin.db.insert(projectEvidence).values([
      {
        id: fixtureId(702),
        tenantId: tenants.a.tenantId,
        projectId: tenants.a.projectId,
        type: 'architecture',
        title: 'Type-safe persistence',
        summary: 'Implemented tenant-safe PostgreSQL storage.',
        details: 'A production TypeScript service with explicit tenant predicates.',
        skills: ['TypeScript', 'PostgreSQL'],
        capabilities: ['Multi-tenancy'],
        businessOutcomes: ['Reliable delivery'],
      },
      {
        id: fixtureId(703),
        tenantId: tenants.b.tenantId,
        projectId: tenants.b.projectId,
        type: 'architecture',
        title: 'Foreign evidence',
        summary: 'Must never contribute to tenant A.',
        details: 'Private tenant B evidence.',
        skills: ['TypeScript', 'PostgreSQL'],
        capabilities: [],
        businessOutcomes: [],
      },
    ]);

    const opportunities = new PostgresOpportunityRepository(database.runtime.db);
    const profiles = new PostgresDeveloperProfileRepository(database.runtime.db);
    const evidence = new PostgresEvidenceRepository(database.runtime.db);
    operation = new EvaluateOpportunity(
      { opportunities, profiles, evidence },
      new PermissionAuthorization(),
    );
    ownerContext = {
      requestId: fixtureId(704),
      userId: tenants.a.userId,
      tenantId: tenants.a.tenantId,
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

  it('evaluates deterministically from only the trusted tenant records', async () => {
    const before = await database.admin.pool.query<{ opportunities: string; evidence: string }>(
      `SELECT
         (SELECT count(*) FROM opportunities WHERE tenant_id = $1)::text AS opportunities,
         (SELECT count(*) FROM project_evidence WHERE tenant_id = $1)::text AS evidence`,
      [tenants.a.tenantId],
    );
    const first = await operation.execute(ownerContext, { opportunityId: ownOpportunityId });
    const second = await operation.execute(ownerContext, { opportunityId: ownOpportunityId });
    const after = await database.admin.pool.query<{ opportunities: string; evidence: string }>(
      `SELECT
         (SELECT count(*) FROM opportunities WHERE tenant_id = $1)::text AS opportunities,
         (SELECT count(*) FROM project_evidence WHERE tenant_id = $1)::text AS evidence`,
      [tenants.a.tenantId],
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      fit: { overallScore: 100, recommendation: 'strong_match' },
      scores: { skills: 100, projectType: 100, budget: null, experienceEvidence: 100 },
      evaluationVersion: 'v1',
    });
    expect(first.relevantEvidence.map(({ evidenceId }) => evidenceId)).toEqual([fixtureId(702)]);
    expect(first.relevantEvidence).not.toContainEqual(
      expect.objectContaining({ evidenceId: fixtureId(703) }),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('returns NOT_FOUND when a trusted tenant requests a foreign opportunity', async () => {
    await expect(
      operation.execute(ownerContext, { opportunityId: foreignOpportunityId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs an oversized required-first query through PostgreSQL without crossing tenants', async () => {
    const opportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
      requiredSkills: [
        'PostgreSQL',
        ...Array.from({ length: 100 }, (_, index) => `skill-${index}`),
      ],
      preferredSkills: ['Docker'],
    });
    const first = await operation.execute(ownerContext, { opportunityId: opportunity.id });
    const second = await operation.execute(ownerContext, { opportunityId: opportunity.id });
    expect(first).toEqual(second);
    expect(first.relevantEvidence.map(({ evidenceId }) => evidenceId)).toEqual([fixtureId(702)]);
    expect(first.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
  });

  it.each(['projectType', 'title'] as const)(
    'accepts an oversized %s fallback through websearch_to_tsquery',
    async (field) => {
      const opportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
        requiredSkills: [],
        preferredSkills: [],
        projectType: null,
        [field]: 'PostgreSQL " OR -Docker '.repeat(100),
      });
      const result = await operation.execute(ownerContext, { opportunityId: opportunity.id });
      expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
      expect(result.riskFlags.map(({ code }) => code)).not.toContain('no_portfolio_evidence');
      expect(result.relevantEvidence.length).toBeLessThanOrEqual(10);
    },
  );

  it('denies a viewer before PostgreSQL evaluation reads', async () => {
    const viewerContext: RequestContext = {
      ...ownerContext,
      userId: tenants.b.userId,
      tenantId: tenants.b.tenantId,
      membershipId: tenants.b.membershipId,
      role: 'viewer',
      permissions: permissionsForRole('viewer'),
    };
    await expect(
      operation.execute(viewerContext, { opportunityId: foreignOpportunityId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
