import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { it, vi } from 'vitest';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { auditLogs, projectNotes } from '@beloveddev/database/schema';
import {
  cleanupTestResources,
  createTestDatabase,
  type TestDatabase,
} from '@beloveddev/test-support/test-database';
import { seedTwoTenants } from '@beloveddev/test-support/tenant-fixtures';
import { seedProjectKnowledge } from '@beloveddev/test-support/project-knowledge-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { composeEvaluationRuntime } from './evaluation-fixture.js';
import { toolSchemas } from '../src/schemas.js';
import {
  requireEqual,
  requireGroundedResult,
  requireSafeError,
  scenarioDefinitions,
  validateScenarioDefinitions,
  type EvaluationObservation,
} from './evaluation-contract.js';

declare module 'vitest' {
  interface TaskMeta {
    evaluation?: EvaluationObservation;
  }
}

validateScenarioDefinitions(scenarioDefinitions);

async function compose(database: TestDatabase, observation: EvaluationObservation) {
  const tenants = await seedTwoTenants(database.admin.db);
  const knowledge = await seedProjectKnowledge(database.admin.db, tenants);
  const opportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId);
  await seedOpportunity(database.admin.db, tenants.b.tenantId);
  return {
    ...composeEvaluationRuntime(database, tenants.a, (name) => observation.tools.push(name)),
    tenants,
    knowledge,
    opportunity,
  };
}
type Harness = Awaited<ReturnType<typeof compose>>;

async function mutationSnapshot(database: TestDatabase) {
  return {
    notes: await database.admin.db.select().from(projectNotes).orderBy(projectNotes.id),
    audits: await database.admin.db.select().from(auditLogs).orderBy(auditLogs.id),
  };
}

async function evidenceWorkflow(
  h: Harness,
  database: TestDatabase,
  observation: EvaluationObservation,
) {
  const before = await mutationSnapshot(database);
  type Profile = z.infer<typeof toolSchemas.get_profile.output>['profile'];
  type Evidence = Pick<
    z.infer<typeof toolSchemas.search_project_evidence.output>['results'][number],
    'type' | 'title' | 'summary' | 'skills' | 'capabilities' | 'businessOutcomes'
  > & { id: string };
  const {
    rows: [profile],
  } = await database.admin.pool.query<Profile>(
    'SELECT id, display_name AS "displayName", headline, summary, location, years_experience AS "yearsExperience", hourly_rate AS "hourlyRate", availability, skills, service_areas AS "serviceAreas", preferred_project_types AS "preferredProjectTypes", excluded_project_types AS "excludedProjectTypes", portfolio_url AS "portfolioUrl", github_url AS "githubUrl" FROM developer_profiles WHERE tenant_id=$1 AND id=$2',
    [h.tenants.a.tenantId, h.tenants.a.profileId],
  );
  const {
    rows: [evidence],
  } = await database.admin.pool.query<Evidence>(
    'SELECT id, type, title, summary, skills, capabilities, business_outcomes AS "businessOutcomes" FROM project_evidence WHERE tenant_id=$1 AND id=$2',
    [h.tenants.a.tenantId, h.knowledge.a.evidenceId],
  );
  const {
    rows: [project],
  } = await database.admin.pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects WHERE tenant_id=$1 AND id=$2',
    [h.tenants.a.tenantId, h.tenants.a.projectId],
  );
  if (!profile || !evidence || !project) throw new Error('Missing synthetic fixture.');
  requireGroundedResult('get_profile', await h.call('get_profile', {}), {
    profile: {
      id: profile.id,
      displayName: profile.displayName,
      headline: profile.headline,
      summary: profile.summary,
      location: profile.location,
      yearsExperience: profile.yearsExperience,
      hourlyRate: profile.hourlyRate,
      availability: profile.availability,
      skills: profile.skills,
      serviceAreas: profile.serviceAreas,
      preferredProjectTypes: profile.preferredProjectTypes,
      excludedProjectTypes: profile.excludedProjectTypes,
      portfolioUrl: profile.portfolioUrl,
      githubUrl: profile.githubUrl,
    },
  });
  const o = h.opportunity;
  const listed = await h.call('list_opportunities', { source: 'manual', status: 'new' });
  requireGroundedResult('list_opportunities', listed, {
    opportunities: [
      {
        id: o.id,
        source: o.source,
        title: o.title,
        clientName: o.clientName,
        projectType: o.projectType,
        budgetType: o.budgetType,
        amountMin: o.amountMin,
        amountMax: o.amountMax,
        currency: o.currency,
        requiredSkills: o.requiredSkills,
        preferredSkills: o.preferredSkills,
        status: o.status,
        sourceUrl: o.sourceUrl,
        publishedAt: o.publishedAt?.toISOString() ?? null,
      },
    ],
  });
  const selected = toolSchemas.list_opportunities.output.parse(listed.structuredContent)
    .opportunities[0];
  if (!selected) throw new Error('Missing selected opportunity.');
  const query = 'TypeScript PostgreSQL';
  const ranks = await database.admin.pool.query<{ search_rank: number; evaluation_rank: number }>(
    "SELECT ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS search_rank, ts_rank_cd(search_vector, websearch_to_tsquery('english', $2)) AS evaluation_rank FROM project_evidence WHERE tenant_id=$3 AND id=$4",
    [query, '"typescript" OR "postgresql" OR "docker"', h.tenants.a.tenantId, evidence.id],
  );
  const rank = ranks.rows[0];
  if (!rank) throw new Error('Missing evidence rank oracle.');
  requireGroundedResult(
    'search_project_evidence',
    await h.call('search_project_evidence', { query }),
    {
      results: [
        {
          evidenceId: evidence.id,
          projectId: project.id,
          projectName: project.name,
          type: evidence.type,
          title: evidence.title,
          summary: evidence.summary,
          skills: evidence.skills,
          capabilities: evidence.capabilities,
          businessOutcomes: evidence.businessOutcomes,
          relevanceScore: rank.search_rank,
        },
      ],
    },
  );
  observation.checks.push('stored_data');
  requireGroundedResult(
    'evaluate_opportunity',
    await h.call('evaluate_opportunity', { opportunityId: selected.id }),
    {
      opportunity: { id: o.id, title: o.title, source: o.source },
      fit: { overallScore: 85, recommendation: 'strong_match' },
      scores: { skills: 80, projectType: 100, budget: null, experienceEvidence: 80 },
      matchedSkills: ['typescript', 'postgresql'],
      missingSkills: [],
      strengths: [
        {
          code: 'all_required_skills_matched',
          message: 'All required skills are present in the developer profile.',
        },
        {
          code: 'preferred_project_type',
          message: 'The opportunity matches a preferred project type.',
        },
        {
          code: 'strong_portfolio_evidence',
          message: 'Portfolio evidence demonstrates at least 80% of the requested skill coverage.',
        },
      ],
      concerns: [
        {
          code: 'budget_not_comparable',
          message:
            'Budget compatibility cannot be scored because the profile rate has no currency.',
        },
      ],
      riskFlags: [],
      relevantEvidence: [
        {
          projectId: project.id,
          projectName: project.name,
          evidenceId: evidence.id,
          title: evidence.title,
          summary: evidence.summary,
          relevanceScore: rank.evaluation_rank,
        },
      ],
      evaluationVersion: 'v1',
    },
  );
  observation.checks.push('grounded_evaluation');
  requireEqual(await mutationSnapshot(database), before);
  observation.checks.push('no_writes');
}

async function authorizationWorkflow(
  h: Harness,
  database: TestDatabase,
  observation: EvaluationObservation,
) {
  const before = await mutationSnapshot(database);
  const lookup = vi.spyOn(h.projects, 'getById');
  const children = [
    vi.spyOn(h.clients, 'getById'),
    vi.spyOn(h.evidence, 'listByProject'),
    vi.spyOn(h.blockers, 'listOpen'),
    vi.spyOn(h.notes, 'listRecentByProject'),
  ];
  requireSafeError(await h.call('get_project', { projectId: h.tenants.b.projectId }), 'NOT_FOUND');
  requireEqual(lookup.mock.calls, [
    [{ tenantId: h.tenants.a.tenantId, projectId: h.tenants.b.projectId }],
  ]);
  for (const child of children) requireEqual(child.mock.calls.length, 0);
  observation.checks.push('scoped_lookup');
  await database.admin.pool.query(
    'UPDATE tenant_memberships SET role=$1 WHERE tenant_id=$2 AND id=$3',
    ['viewer', h.tenants.a.tenantId, h.tenants.a.membershipId],
  );
  const create = vi.spyOn(h.creation, 'create');
  requireSafeError(
    await h.call('create_project_note', {
      projectId: h.tenants.a.projectId,
      category: 'decision',
      content: 'Synthetic denied decision.',
      idempotencyKey: 'evaluation-denied-note',
    }),
    'FORBIDDEN',
  );
  requireEqual(create.mock.calls.length, 0);
  requireEqual(lookup.mock.calls.length, 1);
  observation.checks.push('permission_before_repository');
  requireEqual(await mutationSnapshot(database), before);
  observation.checks.push('no_writes');
}

async function idempotencyWorkflow(
  h: Harness,
  database: TestDatabase,
  observation: EvaluationObservation,
) {
  const before = await mutationSnapshot(database);
  const input = {
    projectId: h.tenants.a.projectId,
    category: 'decision',
    content: 'Synthetic evaluation decision.',
    idempotencyKey: 'evaluation-explicit-repeat',
  };
  const firstResponse = await h.call('create_project_note', input);
  const first = toolSchemas.create_project_note.output.parse(firstResponse.structuredContent);
  requireGroundedResult('create_project_note', firstResponse, { note: first.note, created: true });
  requireEqual(
    { projectId: first.note.projectId, category: first.note.category, content: first.note.content },
    { projectId: input.projectId, category: input.category, content: input.content },
  );
  const repeatedResponse = await h.call('create_project_note', input);
  const repeated = toolSchemas.create_project_note.output.parse(repeatedResponse.structuredContent);
  requireGroundedResult('create_project_note', repeatedResponse, {
    note: first.note,
    created: false,
  });
  requireEqual(first.meta.requestId === repeated.meta.requestId, false);
  observation.checks.push('original_result');
  const after = await mutationSnapshot(database);
  const addedNotes = after.notes.filter(
    (note) => !before.notes.some((previous) => previous.id === note.id),
  );
  const addedAudits = after.audits.filter(
    (audit) => !before.audits.some((previous) => previous.id === audit.id),
  );
  requireEqual(after.notes.length, before.notes.length + 1);
  requireEqual(after.audits.length, before.audits.length + 1);
  const note = addedNotes[0];
  const audit = addedAudits[0];
  if (!note || !audit) throw new Error('Missing committed fixture mutation.');
  requireEqual(
    {
      id: note.id,
      projectId: note.projectId,
      category: note.category,
      content: note.content,
      createdAt: note.createdAt.toISOString(),
    },
    first.note,
  );
  requireEqual(
    {
      tenantId: note.tenantId,
      authorUserId: note.authorUserId,
      idempotencyKey: note.idempotencyKey,
    },
    {
      tenantId: h.tenants.a.tenantId,
      authorUserId: h.tenants.a.userId,
      idempotencyKey: input.idempotencyKey,
    },
  );
  requireEqual(
    {
      tenantId: audit.tenantId,
      actorUserId: audit.actorUserId,
      action: audit.action,
      resourceType: audit.resourceType,
      resourceId: audit.resourceId,
      requestId: audit.requestId,
      metadata: audit.metadata,
    },
    {
      tenantId: h.tenants.a.tenantId,
      actorUserId: h.tenants.a.userId,
      action: 'project_note.created',
      resourceType: 'project_note',
      resourceId: note.id,
      requestId: first.meta.requestId,
      metadata: { projectId: input.projectId, category: input.category },
    },
  );
  requireEqual(
    after.notes.filter((row) => row.id !== note.id),
    before.notes,
  );
  requireEqual(
    after.audits.filter((row) => row.id !== audit.id),
    before.audits,
  );
  observation.checks.push('one_note_one_audit');
  requireSafeError(
    await h.call('create_project_note', { ...input, content: 'Conflicting synthetic decision.' }),
    'CONFLICT',
  );
  requireEqual(await mutationSnapshot(database), after);
  observation.checks.push('safe_conflict');
}

async function failureWorkflow(
  h: Harness,
  database: TestDatabase,
  observation: EvaluationObservation,
) {
  const before = await mutationSnapshot(database);
  requireSafeError(await h.call('get_project', { projectId: randomUUID() }), 'NOT_FOUND');
  observation.checks.push('safe_unavailable');
  await database.admin.pool.query(
    'UPDATE tenant_memberships SET status=$1 WHERE tenant_id=$2 AND id=$3',
    ['inactive', h.tenants.a.tenantId, h.tenants.a.membershipId],
  );
  const profile = vi.spyOn(h.profiles, 'getByTenant');
  requireSafeError(await h.call('get_profile', {}), 'UNAUTHENTICATED');
  requireEqual(profile.mock.calls.length, 0);
  observation.checks.push('inactive_membership');
  requireEqual(await mutationSnapshot(database), before);
  observation.checks.push('no_writes');
}

const workflows = {
  evidence_grounding: evidenceWorkflow,
  authorization_isolation: authorizationWorkflow,
  note_idempotency: idempotencyWorkflow,
  safe_failure: failureWorkflow,
};
for (const definition of scenarioDefinitions) {
  it(definition.id, { timeout: 60_000 }, async ({ task }) => {
    const observation: EvaluationObservation = {
      id: definition.id,
      tools: [],
      checks: [],
      phase: 'setup',
      cleanup: 'pending',
    };
    task.meta.evaluation = observation;
    let database: TestDatabase | undefined;
    let harness: Harness | undefined;
    let failed = false;
    try {
      database = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
      harness = await compose(database, observation);
      await harness.connect();
      observation.phase = 'workflow';
      await workflows[definition.id](harness, database, observation);
      observation.phase = 'cleanup';
    } catch {
      // Fixed diagnostics only; progress/check IDs identify the failing workflow boundary.
      failed = true;
    } finally {
      try {
        const activeHarness = harness;
        const activeDatabase = database;
        await cleanupTestResources([
          ...(activeHarness
            ? [
                { stage: 'sdk_client', run: () => activeHarness.client.close() },
                { stage: 'sdk_server', run: () => activeHarness.server.close() },
              ]
            : []),
          ...(activeDatabase ? [{ stage: 'fixture', run: () => activeDatabase.close() }] : []),
        ]);
        observation.cleanup = 'passed';
      } catch {
        observation.cleanup = 'failed';
        failed = true;
      }
    }
    if (failed) throw new Error('Deterministic evaluation failed; inspect safe scenario progress.');
  });
}
