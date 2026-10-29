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
