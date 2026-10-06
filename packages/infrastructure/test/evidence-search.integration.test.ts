import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectEvidence, projects } from '@beloveddev/database/schema';
import type { EvidenceSearchQuery } from '@beloveddev/application/repositories';
import type { EvidenceType } from '@beloveddev/domain/entities';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { parseTestDatabaseUrl } from '../src/environment.js';
import { PostgresEvidenceRepository } from '../src/postgres/evidence-repository.js';

const secondProjectId = fixtureId(50);
const evidenceIds = {
  strongest: fixtureId(100),
  hvac: fixtureId(200),
  tieA: fixtureId(300),
  tieB: fixtureId(400),
  otherTenant: fixtureId(900),
};

describe('PostgreSQL project evidence full-text search', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let repository: PostgresEvidenceRepository;

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    repository = new PostgresEvidenceRepository(database.runtime.db);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    await database.admin.db.insert(projects).values({
      ...projectInput(tenants.a.tenantId, null),
      id: secondProjectId,
      slug: 'hvac-estimator',
      name: 'HVAC Estimator',
    });
    const common = {
      tenantId: tenants.a.tenantId,
      type: 'architecture' as const,
      summary: 'Reliable delivery evidence',
      details: 'Production implementation details',
      skills: ['TypeScript'],
      capabilities: ['Software delivery'],
      businessOutcomes: ['Operational improvement'],
    };
    await database.admin.db.insert(projectEvidence).values([
      {
        ...common,
        id: evidenceIds.strongest,
        projectId: tenants.a.projectId,
        title: 'PostgreSQL multi tenant SaaS dashboard',
        summary: 'Secure portfolio dashboard with tenant isolation',
        details: 'The application stores reliable project context.',
        skills: ['PostgreSQL', 'React'],
        capabilities: ['API integration', 'Multi tenancy'],
        businessOutcomes: ['Business automation'],
      },
      {
        ...common,
        id: evidenceIds.hvac,
        projectId: secondProjectId,
        type: 'automation',
        title: 'HVAC lead capture estimator',
        summary: 'Estimator dashboard for qualified leads',
        details: 'PostgreSQL powers the configurable estimator workflow.',
        skills: ['React', 'Node.js'],
        capabilities: ['Lead capture', 'API integration'],
        businessOutcomes: ['Faster sales automation'],
      },
      {
        ...common,
        id: evidenceIds.tieA,
        projectId: tenants.a.projectId,
        title: 'AI reliability dashboard',
      },
      {
        ...common,
        id: evidenceIds.tieB,
        projectId: secondProjectId,
        title: 'AI reliability dashboard',
      },
      {
        ...common,
        id: evidenceIds.otherTenant,
        tenantId: tenants.b.tenantId,
        projectId: tenants.b.projectId,
        title: 'PostgreSQL multi tenant SaaS dashboard',
        skills: ['PostgreSQL'],
      },
    ]);
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  const search = (
    query: string,
    input: Omit<Partial<EvidenceSearchQuery>, 'tenantId' | 'query' | 'limit'> = {},
  ) => repository.search({ tenantId: tenants.a.tenantId, query, limit: 100, ...input });

  it('finds ordinary multi-word queries and ranks a title match above a details match', async () => {
    const result = await search('PostgreSQL');
    expect(result.items.map((item) => item.evidenceId)).toEqual([
      evidenceIds.strongest,
      evidenceIds.hvac,
    ]);
    expect(result.items[0]?.relevanceScore).toBeGreaterThan(
      result.items[1]?.relevanceScore ?? Number.POSITIVE_INFINITY,
    );
    expect(result.items[0]).toMatchObject({
      projectId: tenants.a.projectId,
      projectName: 'Portfolio Platform',
      title: 'PostgreSQL multi tenant SaaS dashboard',
      skills: ['PostgreSQL', 'React'],
      capabilities: ['API integration', 'Multi tenancy'],
      businessOutcomes: ['Business automation'],
    });
  });

  it.each([
    ['HVAC', evidenceIds.hvac],
    ['qualified leads', evidenceIds.hvac],
    ['configurable workflow', evidenceIds.hvac],
    ['React', evidenceIds.strongest],
    ['integration', evidenceIds.strongest],
    ['automation', evidenceIds.hvac],
  ])('searches title, summary, details, and structured text for %s', async (query, expected) => {
    const result = await search(query);
    expect(result.items.map((item) => item.evidenceId)).toContain(expected);
  });

  it('uses UUID ascending as the deterministic tie-breaker for equal ranks', async () => {
    const result = await search('AI reliability');
    expect(result.items.map((item) => item.evidenceId)).toEqual([
      evidenceIds.tieA,
      evidenceIds.tieB,
    ]);
    expect(result.items[0]?.relevanceScore).toBe(result.items[1]?.relevanceScore);
  });

  it('isolates identical search text in both tenant directions', async () => {
    const a = await repository.search({
      tenantId: tenants.a.tenantId,
      query: 'PostgreSQL multi tenant SaaS dashboard',
      limit: 100,
    });
    const b = await repository.search({
      tenantId: tenants.b.tenantId,
      query: 'PostgreSQL multi tenant SaaS dashboard',
      limit: 100,
    });
    expect(a.items.map((item) => item.evidenceId)).toEqual([evidenceIds.strongest]);
    expect(b.items.map((item) => item.evidenceId)).toEqual([evidenceIds.otherTenant]);
  });

  it('applies project, multiple-project, evidence-type, and exact normalized skill filters in SQL', async () => {
    expect(
      (await search('dashboard', { projectIds: [secondProjectId] })).items.map(
        (item) => item.evidenceId,
      ),
    ).toEqual([evidenceIds.tieB, evidenceIds.hvac]);
    expect(
      (
        await search('dashboard', {
          projectIds: [tenants.a.projectId, secondProjectId],
          evidenceTypes: ['automation'] satisfies EvidenceType[],
          skills: ['react'],
        })
      ).items.map((item) => item.evidenceId),
    ).toEqual([evidenceIds.hvac]);
    expect(
      (await search('dashboard', { skills: ['postgreSQL'] })).items.map((item) => item.evidenceId),
    ).toEqual([evidenceIds.strongest]);
  });

  it('does not reveal foreign-tenant projects through project filters', async () => {
    expect((await search('PostgreSQL', { projectIds: [tenants.b.projectId] })).items).toEqual([]);
    expect(
      (
        await search('PostgreSQL', {
          projectIds: [tenants.a.projectId, tenants.b.projectId],
        })
      ).items.map((item) => item.evidenceId),
    ).toEqual([evidenceIds.strongest]);
  });

  it('returns an empty page for a no-result user query', async () => {
    expect(await search('quantum submarine')).toEqual({ items: [], nextPosition: null });
  });

  it('paginates a stable ranked dataset without offsets, duplicates, or skipped rows', async () => {
    const expected = (await search('dashboard')).items.map((item) => item.evidenceId);
    const actual: string[] = [];
    let after: { id: string; relevanceScore: string } | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await repository.search({
        tenantId: tenants.a.tenantId,
        query: 'dashboard',
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      actual.push(...page.items.map((item) => item.evidenceId));
      after = page.nextPosition ?? undefined;
      if (after === undefined) break;
    }
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('rejects malformed repository inputs without exposing PostgreSQL details', async () => {
    for (const input of [
      { tenantId: 'invalid', query: 'dashboard', limit: 20 },
      { tenantId: tenants.a.tenantId, query: '   ', limit: 20 },
      { tenantId: tenants.a.tenantId, query: 'dashboard', limit: 0 },
      { tenantId: tenants.a.tenantId, query: 'dashboard', projectIds: ['invalid'], limit: 20 },
      {
        tenantId: tenants.a.tenantId,
        query: 'dashboard',
        after: { id: evidenceIds.tieA, relevanceScore: 'NaN' },
        limit: 20,
      },
    ])
      await expect(repository.search(input as EvidenceSearchQuery)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });
});
