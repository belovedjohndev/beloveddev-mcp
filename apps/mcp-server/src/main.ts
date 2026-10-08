import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import {
  EnvironmentValidationError,
  parseMcpEnvironment,
} from '@beloveddev/infrastructure/environment';
import { createLogger } from '@beloveddev/infrastructure/logger';
import { openDatabase, type DatabaseConnection } from '@beloveddev/database/client';
import { PermissionAuthorization } from '@beloveddev/application/request-context';
import { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import { ListProjects } from '@beloveddev/application/use-cases/list-projects';
import { GetProject } from '@beloveddev/application/use-cases/get-project';
import { GetBlockers } from '@beloveddev/application/use-cases/get-blockers';
import { SearchProjectEvidence } from '@beloveddev/application/use-cases/search-project-evidence';
import { ListOpportunities } from '@beloveddev/application/use-cases/list-opportunities';
import { LocalRequestContextProvider } from '@beloveddev/infrastructure/local-request-context';
import { SignedCursorCodec } from '@beloveddev/infrastructure/signed-cursor';
import { PostgresMembershipRepository } from '@beloveddev/infrastructure/postgres/membership-repository';
import { PostgresDeveloperProfileRepository } from '@beloveddev/infrastructure/postgres/developer-profile-repository';
import { PostgresProjectRepository } from '@beloveddev/infrastructure/postgres/project-repository';
import { PostgresClientRepository } from '@beloveddev/infrastructure/postgres/client-repository';
import { PostgresEvidenceRepository } from '@beloveddev/infrastructure/postgres/evidence-repository';
import { PostgresBlockerRepository } from '@beloveddev/infrastructure/postgres/blocker-repository';
import { PostgresNoteRepository } from '@beloveddev/infrastructure/postgres/note-repository';
import { PostgresOpportunityRepository } from '@beloveddev/infrastructure/postgres/opportunity-repository';
import { createMcpServer } from '@beloveddev/mcp/server';

let database: DatabaseConnection | undefined;
let handle: StdioServerHandle | undefined;
let shutdown: Promise<void> | undefined;

try {
  const environment = parseMcpEnvironment(process.env);
  const logger = createLogger(environment.LOG_LEVEL);
  const close = () => {
    shutdown ??= Promise.resolve().then(async () => {
      await handle?.close();
      await database?.close();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      process.stdin.pause();
      logger.info({ event: 'mcp.stopped' }, 'MCP server stopped');
    });
    return shutdown;
  };
  const stop = () => {
    void close().catch(() => {
      logger.error({ event: 'mcp.shutdown_failed' }, 'Unable to close server resources');
      process.exitCode = 1;
    });
  };
  database = openDatabase(environment.DATABASE_URL, {
    onIdleError: () => {
      logger.error({ event: 'database.idle_error' }, 'Database connection failed');
      process.exitCode = 1;
      stop();
    },
  });
  const memberships = new PostgresMembershipRepository(database.db);
  const projects = new PostgresProjectRepository(database.db);
  const clients = new PostgresClientRepository(database.db);
  const evidence = new PostgresEvidenceRepository(database.db);
  const blockers = new PostgresBlockerRepository(database.db);
  const notes = new PostgresNoteRepository(database.db);
  const profiles = new PostgresDeveloperProfileRepository(database.db);
  const opportunities = new PostgresOpportunityRepository(database.db);
  const authorization = new PermissionAuthorization();
  const cursors = new SignedCursorCodec(environment.MCP_CURSOR_SECRET);
  const context = new LocalRequestContextProvider(
    environment.MCP_LOCAL_TENANT_ID !== undefined && environment.MCP_LOCAL_USER_ID !== undefined
      ? { tenantId: environment.MCP_LOCAL_TENANT_ID, userId: environment.MCP_LOCAL_USER_ID }
      : null,
    memberships,
  );
  const useCases = {
    getProfile: new GetProfile(profiles, authorization),
    listProjects: new ListProjects(projects, authorization, cursors),
    getProject: new GetProject({ projects, clients, evidence, blockers, notes }, authorization),
    getBlockers: new GetBlockers(blockers, authorization, cursors),
    searchProjectEvidence: new SearchProjectEvidence(evidence, authorization, cursors),
    listOpportunities: new ListOpportunities(opportunities, authorization, cursors),
  };
  const transport = new StdioServerTransport();
  handle = serveStdio(() => createMcpServer({ useCases, context, logger }), {
    transport,
    onerror: () => logger.error({ event: 'mcp.protocol_error' }, 'MCP protocol operation failed'),
  });
  // Discovery probes may be discarded; the shared pool follows the wire lifetime.
  const onTransportClose = transport.onclose;
  transport.onclose = () => {
    onTransportClose?.();
    stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logger.info(
    {
      event: 'mcp.ready',
      environment: environment.NODE_ENV,
      transport: 'stdio',
      authMode: 'local',
    },
    'MCP server listening',
  );
} catch (error: unknown) {
  const logger = createLogger('error');
  logger.error(
    {
      event:
        error instanceof EnvironmentValidationError
          ? 'configuration.invalid'
          : 'mcp.startup_failed',
      invalidVariables: error instanceof EnvironmentValidationError ? error.fields : [],
    },
    'Unable to initialize MCP server',
  );
  await handle?.close();
  await database?.close();
  process.exitCode = 1;
}
