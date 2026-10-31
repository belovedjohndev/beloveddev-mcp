import { approvedClusterUrl, type ApprovedTestCluster } from './approved-test-cluster.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  auditLogs,
  clients as clientTable,
  developerProfiles,
  opportunities,
  projects as projectTable,
  projectEvidence,
  projectBlockers,
  projectNotes,
  tenantMemberships,
  tenants as tenantTable,
  users,
} from '@beloveddev/database/schema';
import { createTestDatabase, cleanupTestResources } from '@beloveddev/test-support/test-database';
import { seedTwoTenants } from '@beloveddev/test-support/tenant-fixtures';
import { evidenceInput } from '@beloveddev/test-support/project-knowledge-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { agentScenarios } from './agent-evaluation-scenarios.js';
import { AgentFailure, bounded, type AgentScenario } from './agent-evaluation.js';
import { McpToolGateway } from './agent-tool-gateway.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PermissionAuthorization } from '@beloveddev/application/request-context';
import { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import { ListProjects } from '@beloveddev/application/use-cases/list-projects';
import { GetProject } from '@beloveddev/application/use-cases/get-project';
import { GetBlockers } from '@beloveddev/application/use-cases/get-blockers';
import { SearchProjectEvidence } from '@beloveddev/application/use-cases/search-project-evidence';
import { ListOpportunities } from '@beloveddev/application/use-cases/list-opportunities';
import { EvaluateOpportunity } from '@beloveddev/application/use-cases/evaluate-opportunity';
import { CreateProjectNote } from '@beloveddev/application/use-cases/create-project-note';
import { LocalRequestContextProvider } from '@beloveddev/infrastructure/local-request-context';
import { SignedCursorCodec } from '@beloveddev/infrastructure/signed-cursor';
import { PostgresMembershipRepository } from '@beloveddev/infrastructure/postgres/membership-repository';
import { PostgresDeveloperProfileRepository } from '@beloveddev/infrastructure/postgres/developer-profile-repository';
import { PostgresClientRepository } from '@beloveddev/infrastructure/postgres/client-repository';
import { PostgresProjectRepository } from '@beloveddev/infrastructure/postgres/project-repository';
import { PostgresEvidenceRepository } from '@beloveddev/infrastructure/postgres/evidence-repository';
import { PostgresBlockerRepository } from '@beloveddev/infrastructure/postgres/blocker-repository';
import { PostgresNoteRepository } from '@beloveddev/infrastructure/postgres/note-repository';
import { PostgresOpportunityRepository } from '@beloveddev/infrastructure/postgres/opportunity-repository';
import { PostgresProjectNoteCreationRepository } from '@beloveddev/infrastructure/postgres/project-note-creation-repository';
import type { TestDatabase } from '@beloveddev/test-support/test-database';
import { createMcpServer } from '../src/server.js';
import type { ToolName } from '../src/schemas.js';

export function composeEvaluationRuntime(
  database: TestDatabase,
  principal: { tenantId: string; userId: string },
  onCall: (name: ToolName) => void = () => {},
) {
  const db = database.runtime.db;
  const projects = new PostgresProjectRepository(db);
  const clients = new PostgresClientRepository(db);
  const evidence = new PostgresEvidenceRepository(db);
  const blockers = new PostgresBlockerRepository(db);
  const notes = new PostgresNoteRepository(db);
  const profiles = new PostgresDeveloperProfileRepository(db);
  const opportunities = new PostgresOpportunityRepository(db);
  const creation = new PostgresProjectNoteCreationRepository(db);
  const authorization = new PermissionAuthorization();
  const cursors = new SignedCursorCodec('synthetic-evaluation-cursor-secret-at-least-32-bytes');
  const server = createMcpServer({
    context: new LocalRequestContextProvider(principal, new PostgresMembershipRepository(db)),
    logger: { info() {} },
    useCases: {
      getProfile: new GetProfile(profiles, authorization),
      listProjects: new ListProjects(projects, authorization, cursors),
      getProject: new GetProject({ projects, clients, evidence, blockers, notes }, authorization),
      getBlockers: new GetBlockers(blockers, authorization, cursors),
      searchProjectEvidence: new SearchProjectEvidence(evidence, authorization, cursors),
      listOpportunities: new ListOpportunities(opportunities, authorization, cursors),
      evaluateOpportunity: new EvaluateOpportunity(
        { opportunities, profiles, evidence },
        authorization,
      ),
      createProjectNote: new CreateProjectNote(creation, authorization),
    },
  });
  const client = new Client(
    { name: 'beloveddev-workflow-evaluator', version: '1.0.0' },
    { listMaxPages: 1 },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Return connection separately so the outer finally owns partially connected SDK objects.
  return {
    projects,
    clients,
    evidence,
    blockers,
    notes,
    profiles,
    creation,
    client,
    server,
    async connect() {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    },
    async call(name: ToolName, args: Record<string, unknown>) {
      onCall(name);
      return client.callTool({ name, arguments: args });
    },
  };
}

const syntheticBrand: unique symbol = Symbol('synthetic-agent-fixture');
export interface SyntheticAgentFixture {
  readonly [syntheticBrand]: true;
}
export type AgentScenarioId = AgentScenario['id'];
type SyntheticState = {
  manifestDigest: string;
  scenarios: readonly AgentScenario[];
  gateway: McpToolGateway;
  snapshotDigest: () => Promise<string>;
  close: () => Promise<void>;
  claimed: boolean;
  closed: boolean;
};
const syntheticFixtures = new WeakMap<object, SyntheticState>();
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}
function syntheticState(fixture: SyntheticAgentFixture) {
  const state = syntheticFixtures.get(fixture);
  if (!state || state.closed) throw new AgentFailure('approval_invalid');
  return state;
}
/** No caller-provided database, principal, prompt, scenario or client can mint this capability. */
export async function createSyntheticAgentFixture(
  cluster: ApprovedTestCluster,
): Promise<SyntheticAgentFixture> {
  const administratorUrl = await approvedClusterUrl(cluster);
  const database = await createTestDatabase(administratorUrl, { mcpRuntime: true });
  let runtime: ReturnType<typeof composeEvaluationRuntime> | undefined;
  const retire = () =>
    cleanupTestResources([
      ...(runtime
        ? [
            {
              stage: 'sdk_client',
              run: () => bounded(() => runtime!.client.close(), 5000, 'cleanup_failed'),
            },
            {
              stage: 'sdk_server',
              run: () => bounded(() => runtime!.server.close(), 5000, 'cleanup_failed'),
            },
          ]
        : []),
      { stage: 'fixture', run: () => bounded(() => database.close(), 5000, 'cleanup_failed') },
    ]);
  try {
    // A fresh database may inherit a modified template; never authorize inherited application data.
    const inherited = await database.admin.pool.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM tenants UNION ALL SELECT 1 FROM users UNION ALL SELECT 1 FROM tenant_memberships UNION ALL SELECT 1 FROM developer_profiles UNION ALL SELECT 1 FROM clients UNION ALL SELECT 1 FROM projects UNION ALL SELECT 1 FROM project_evidence UNION ALL SELECT 1 FROM project_blockers UNION ALL SELECT 1 FROM project_notes UNION ALL SELECT 1 FROM opportunities UNION ALL SELECT 1 FROM audit_logs) AS present',
    );
    if (inherited.rows[0]?.present !== false) throw new AgentFailure('setup_failed');
    const seeded = await seedTwoTenants(database.admin.db);
    const [evidence] = await database.admin.db
      .insert(projectEvidence)
      .values(evidenceInput(seeded.a))
      .returning({ id: projectEvidence.id });
    await database.admin.db.insert(projectEvidence).values(evidenceInput(seeded.b));
    const opportunity = await seedOpportunity(database.admin.db, seeded.a.tenantId);
    const risk = await seedOpportunity(database.admin.db, seeded.a.tenantId, {
      title: 'Excluded project type opportunity',
      projectType: 'Gambling',
    });
    await seedOpportunity(database.admin.db, seeded.b.tenantId);
    if (!evidence) throw new AgentFailure('setup_failed');
    const resourceIds = {
      projectId: seeded.a.projectId,
      evidenceId: evidence.id,
      opportunityId: opportunity.id,
      riskOpportunityId: risk.id,
      missingProjectId: randomUUID(),
      foreignProjectId: seeded.b.projectId,
    };
    const scenarios = agentScenarios(resourceIds);
    freezeDeep(scenarios);
    runtime = composeEvaluationRuntime(database, seeded.a);
    await runtime.connect();
    const db = database.admin.db;
    const snapshotDigest = async () =>
      digest({
        version: 'synthetic-agent-fixture-v1',
        identity: database.identity,
        principal: seeded.a,
        resourceIds,
        tenants: await db.select().from(tenantTable).orderBy(tenantTable.id),
        users: await db.select().from(users).orderBy(users.id),
        memberships: await db.select().from(tenantMemberships).orderBy(tenantMemberships.id),
        profiles: await db.select().from(developerProfiles).orderBy(developerProfiles.id),
        clients: await db.select().from(clientTable).orderBy(clientTable.id),
        projects: await db.select().from(projectTable).orderBy(projectTable.id),
        evidence: await db.select().from(projectEvidence).orderBy(projectEvidence.id),
        blockers: await db.select().from(projectBlockers).orderBy(projectBlockers.id),
        notes: await db.select().from(projectNotes).orderBy(projectNotes.id),
        opportunities: await db.select().from(opportunities).orderBy(opportunities.id),
        audits: await db.select().from(auditLogs).orderBy(auditLogs.id),
      });
    const state: SyntheticState = {
      manifestDigest: await snapshotDigest(),
      scenarios,
      gateway: new McpToolGateway(runtime.client),
      snapshotDigest,
      claimed: false,
      closed: false,
      close: retire,
    };
    const fixture: SyntheticAgentFixture = Object.freeze({ [syntheticBrand]: true as const });
    syntheticFixtures.set(fixture, state);
    return fixture;
  } catch {
    try {
      await retire();
    } catch {
      throw new AgentFailure('cleanup_failed');
    }
    throw new AgentFailure('setup_failed');
  }
}
/** Only safe digests/inventory leave the private fixture; database credentials never do. */
export function fixtureApprovalBinding(
  fixture: SyntheticAgentFixture,
  scenarioId: AgentScenarioId,
) {
  const state = syntheticState(fixture);
  const scenario = state.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new AgentFailure('approval_mismatch');
  return Object.freeze({
    fixtureManifestDigest: state.manifestDigest,
    scenarioSetDigest: digest([scenario]),
    scenarioInventory: Object.freeze([scenarioId]),
  });
}
export async function claimSyntheticScenario(
  fixture: SyntheticAgentFixture,
  scenarioId: AgentScenarioId,
) {
  const state = syntheticState(fixture);
  if (state.claimed) throw new AgentFailure('approval_invalid');
  state.claimed = true;
  if (!isDeepStrictEqual(await state.snapshotDigest(), state.manifestDigest))
    throw new AgentFailure('approval_mismatch');
  const scenario = state.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new AgentFailure('approval_mismatch');
  return { scenario, gateway: state.gateway };
}
export function closeSyntheticFixture(fixture: SyntheticAgentFixture): Promise<void> {
  const state = syntheticFixtures.get(fixture);
  if (!state) throw new AgentFailure('approval_invalid');
  if (!state.closed) {
    state.closed = true;
    const closing = state.close();
    state.close = () => closing;
  }
  return state.close();
}
