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
import {
  openDatabase,
  DatabasePolicyError,
  type DatabaseConnection,
} from '@beloveddev/database/client';
import { assertRuntimeDatabaseReady, DatabaseReadinessError } from '@beloveddev/database/readiness';
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
import { PostgresProjectRepository } from '@beloveddev/infrastructure/postgres/project-repository';
import { PostgresClientRepository } from '@beloveddev/infrastructure/postgres/client-repository';
import { PostgresEvidenceRepository } from '@beloveddev/infrastructure/postgres/evidence-repository';
import { PostgresBlockerRepository } from '@beloveddev/infrastructure/postgres/blocker-repository';
import { PostgresNoteRepository } from '@beloveddev/infrastructure/postgres/note-repository';
import { PostgresProjectNoteCreationRepository } from '@beloveddev/infrastructure/postgres/project-note-creation-repository';
import { PostgresOpportunityRepository } from '@beloveddev/infrastructure/postgres/opportunity-repository';
import { createMcpServer } from '@beloveddev/mcp/server';
import { InvocationAdmission } from '@beloveddev/mcp/invocation-policy';
import { StdioLifecycle } from './lifecycle.js';

let database: DatabaseConnection | undefined;
let handle: StdioServerHandle | undefined;
let transport: StdioServerTransport | undefined;
let transportClosed = false;
let lifecycle: StdioLifecycle | undefined;

try {
  const environment = parseMcpEnvironment(process.env);
  const logger = createLogger(environment.LOG_LEVEL);
  const onSigint = () => {
    void lifecycle?.stop('SIGINT');
  };
  const onSigterm = () => {
    void lifecycle?.stop('SIGTERM');
  };
  lifecycle = new StdioLifecycle({
    logger,
    pauseInput: () => {
      process.stdin.pause();
    },
    closeTransport: async () => {
      try {
        await handle?.close();
      } finally {
        // serveStdio may fail after starting the wire but before returning a handle.
        if (!transportClosed) {
          await transport?.close();
          transportClosed = true;
        }
      }
    },
    closeDatabase: async () => {
      await database?.close();
    },
    finishOutput: async () => {
      process.stdin.destroy();
      // Flush complete protocol messages before normal termination, within the same deadline.
      await new Promise<void>((resolve, reject) => {
        process.stdout.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    },
    terminate: (code) => process.exit(code),
  });
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  database = openDatabase(environment.DATABASE_URL, {
    ...(environment.DATABASE_TLS_CA === undefined ? {} : { tlsCa: environment.DATABASE_TLS_CA }),
    onClientError: () => {
      void lifecycle?.databaseError('client');
    },
    onIdleError: () => {
      void lifecycle?.databaseError('idle');
    },
  });
  const readiness = assertRuntimeDatabaseReady(database.pool);
  // Observe immediately, including a constructor failure before serveStdio attaches its factory.
  void readiness.catch(() => {});
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
    evaluateOpportunity: new EvaluateOpportunity(
      { opportunities, profiles, evidence },
      authorization,
    ),
    createProjectNote: new CreateProjectNote(
      new PostgresProjectNoteCreationRepository(database.db),
      authorization,
    ),
  };
  transport = new StdioServerTransport();
  const invocations = lifecycle;
  // Discovery/legacy factories share one capacity budget and lifecycle accounting.
  const admission = new InvocationAdmission(invocations);
  handle = serveStdio(
    async () => {
      await readiness;
      if (invocations.isStopping) throw new Error('MCP server is stopping.');
      return createMcpServer({ useCases, context, logger, admission });
    },
    {
      transport,
      onerror: () => logger.error({ event: 'mcp.protocol_error' }, 'MCP protocol operation failed'),
    },
  );
  // Discovery probes may be discarded; the shared pool follows the wire lifetime.
  const onTransportClose = transport.onclose;
  transport.onclose = () => {
    transportClosed = true;
    void lifecycle?.stop('transport_closed');
    onTransportClose?.();
  };
  await readiness;
  if (!lifecycle.isStopping) {
    logger.info(
      {
        event: 'mcp.ready',
        environment: environment.NODE_ENV,
        transport: 'stdio',
        authMode: 'local',
      },
      'MCP server listening',
    );
  }
} catch (error: unknown) {
  // EOF or a signal during startup uses the same shutdown, without upgrading a
  // normal closure to startup failure when the pool is being closed underneath it.
  if (lifecycle?.isStopping) {
    await lifecycle.stop('transport_closed');
  } else {
    const logger = createLogger('error');
    try {
      logger.error(
        {
          event:
            error instanceof EnvironmentValidationError
              ? 'configuration.invalid'
              : 'mcp.startup_failed',
          invalidVariables: error instanceof EnvironmentValidationError ? error.fields : [],
          ...(error instanceof DatabaseReadinessError ? { category: error.category } : {}),
          ...(error instanceof DatabasePolicyError ? { category: 'TRANSPORT_POLICY' } : {}),
        },
        'Unable to initialize MCP server',
      );
    } catch {
      // A broken stderr sink must not skip cleanup or fall back to protocol stdout.
    }
    if (lifecycle !== undefined) await lifecycle.stop('startup_error');
    else process.exitCode = 1;
  }
}
