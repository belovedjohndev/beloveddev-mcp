import { randomUUID } from 'node:crypto';
import { it, vi } from 'vitest';
import { auditLogs, projectEvidence, projectNotes } from '@beloveddev/database/schema';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import {
  createTestDatabase,
  cleanupTestResources,
  type TestDatabase,
} from '@beloveddev/test-support/test-database';
import { seedTwoTenants } from '@beloveddev/test-support/tenant-fixtures';
import { evidenceInput } from '@beloveddev/test-support/project-knowledge-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { composeEvaluationRuntime } from './evaluation-fixture.js';
import { requireEqual } from './evaluation-contract.js';
import { agentScenarios, type AgentFixtureIds } from './agent-evaluation-scenarios.js';
import { McpToolGateway } from './agent-tool-gateway.js';
import {
  failedAgentReport,
  offlineModel,
  runAgentScenario,
  scenarioIds,
  type AgentReport,
} from './agent-evaluation.js';

declare module 'vitest' {
  interface TaskMeta {
    agentEvaluation?: AgentReport;
  }
}

/** Independent programmed adapter responses: these are simulation controls, not a live model. */
function programmedActions(scenario: (typeof scenarioIds)[number], ids: AgentFixtureIds) {
  const noFacts = {
    availability: 'unavailable',
    projectIds: [],
    evidenceIds: [],
    opportunityIds: [],
    overallScore: null,
    recommendation: null,
    riskCodes: [],
    concernCodes: [],
    errorCodes: [],
  };
  switch (scenario) {
    case 'evidence_retrieval':
      return [
        {
          type: 'tool_call',
          name: 'search_project_evidence',
          arguments: { query: 'TypeScript PostgreSQL' },
        },
        {
          type: 'final',
          claims: {
            ...noFacts,
            availability: 'available',
            projectIds: [ids.projectId],
            evidenceIds: [ids.evidenceId],
          },
        },
      ];
    case 'opportunity_selection':
      return [
        {
          type: 'tool_call',
          name: 'list_opportunities',
          arguments: { source: 'manual', status: 'new' },
        },
        {
          type: 'final',
          claims: {
            ...noFacts,
            availability: 'available',
            opportunityIds: [ids.opportunityId, ids.riskOpportunityId],
          },
        },
      ];
    case 'score_interpretation':
      return [
        {
          type: 'tool_call',
          name: 'evaluate_opportunity',
          arguments: { opportunityId: ids.riskOpportunityId },
        },
        {
          type: 'final',
          claims: {
            ...noFacts,
            availability: 'available',
            projectIds: [ids.projectId],
            evidenceIds: [ids.evidenceId],
            opportunityIds: [ids.riskOpportunityId],
            overallScore: 61,
            recommendation: 'skip',
            riskCodes: ['excluded_project_type'],
            concernCodes: ['budget_not_comparable'],
          },
        },
      ];
    case 'unavailable_information':
      return [
        { type: 'tool_call', name: 'get_project', arguments: { projectId: ids.missingProjectId } },
        { type: 'final', claims: { ...noFacts, errorCodes: ['NOT_FOUND'] } },
      ];
    case 'tenant_boundary':
      return [
        { type: 'tool_call', name: 'get_project', arguments: { projectId: ids.foreignProjectId } },
        { type: 'final', claims: { ...noFacts, errorCodes: ['NOT_FOUND'] } },
      ];
    case 'mutation_refusal':
      return [{ type: 'final', claims: { ...noFacts, availability: 'refused' } }];
  }
}
async function snapshot(database: TestDatabase) {
  return {
    notes: await database.admin.db.select().from(projectNotes).orderBy(projectNotes.id),
    audits: await database.admin.db.select().from(auditLogs).orderBy(auditLogs.id),
  };
}
for (const id of scenarioIds) {
  it(id, { timeout: 60_000 }, async ({ task }) => {
    let database: TestDatabase | undefined;
    let runtime: ReturnType<typeof composeEvaluationRuntime> | undefined;
    let report = failedAgentReport(id, 'setup_failed');
    task.meta.agentEvaluation = report;
    try {
      database = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
      const tenants = await seedTwoTenants(database.admin.db);
      const [evidence] = await database.admin.db
        .insert(projectEvidence)
        .values(evidenceInput(tenants.a))
        .returning({ id: projectEvidence.id });
      await database.admin.db.insert(projectEvidence).values(evidenceInput(tenants.b));
      const opportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId);
      const riskOpportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId, {
        title: 'Excluded project type opportunity',
        projectType: 'Gambling',
      });
      await seedOpportunity(database.admin.db, tenants.b.tenantId);
      if (!evidence) throw new Error('Synthetic evidence missing.');
      const ids: AgentFixtureIds = {
        projectId: tenants.a.projectId,
        evidenceId: evidence.id,
        opportunityId: opportunity.id,
        riskOpportunityId: riskOpportunity.id,
        missingProjectId: randomUUID(),
        foreignProjectId: tenants.b.projectId,
      };
      const scenario = agentScenarios(ids).find((scenario) => scenario.id === id);
      runtime = composeEvaluationRuntime(database, tenants.a);
      const create = vi.spyOn(runtime.creation, 'create');
      await runtime.connect();
      const before = await snapshot(database);
      requireEqual(before, { notes: [], audits: [] });
      report = await runAgentScenario(
        scenario,
        offlineModel(programmedActions(id, ids)),
        new McpToolGateway(runtime.client),
      );
      task.meta.agentEvaluation = report;
      requireEqual(report.status, 'passed');
      requireEqual(create.mock.calls.length, 0);
      requireEqual(await snapshot(database), before);
    } catch {
      report.status = 'failed';
      report.failure ??= 'incorrect_outcome';
    } finally {
      const activeRuntime = runtime;
      const activeDatabase = database;
      try {
        await cleanupTestResources([
          ...(activeRuntime
            ? [
                { stage: 'sdk_client', run: () => activeRuntime.client.close() },
                { stage: 'sdk_server', run: () => activeRuntime.server.close() },
              ]
            : []),
          ...(activeDatabase ? [{ stage: 'fixture', run: () => activeDatabase.close() }] : []),
        ]);
      } catch {
        report.status = 'failed';
        report.failure = 'cleanup_failed';
        report.cleanup = 'failed';
      }
      task.meta.agentEvaluation = report;
    }
    if (report.status !== 'passed')
      throw new Error('Offline agent evaluation failed; see safe report.');
  });
}
