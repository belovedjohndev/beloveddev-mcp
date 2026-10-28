import { randomUUID } from 'node:crypto';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  ApplicationError,
  toApplicationError,
  type ApplicationErrorCode,
} from '@beloveddev/application/application-error';
import type {
  RequestContext,
  RequestContextProvider,
} from '@beloveddev/application/request-context';
import type { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import type { ListProjects } from '@beloveddev/application/use-cases/list-projects';
import type { GetProject } from '@beloveddev/application/use-cases/get-project';
import type { GetBlockers } from '@beloveddev/application/use-cases/get-blockers';
import type { SearchProjectEvidence } from '@beloveddev/application/use-cases/search-project-evidence';
import type { ListOpportunities } from '@beloveddev/application/use-cases/list-opportunities';
import type { EvaluateOpportunity } from '@beloveddev/application/use-cases/evaluate-opportunity';
import type { CreateProjectNote } from '@beloveddev/application/use-cases/create-project-note';
import { safeErrorSchema, toolSchemas, type ToolName } from './schemas.js';
import {
  APPLICATION_RESPONSE_DEADLINE_MS,
  InvocationAdmission,
  MAX_SUCCESS_RESPONSE_BYTES,
} from './invocation-policy.js';

export interface McpUseCases {
  readonly getProfile: Pick<GetProfile, 'execute'>;
  readonly listProjects: Pick<ListProjects, 'execute'>;
  readonly getProject: Pick<GetProject, 'execute'>;
  readonly getBlockers: Pick<GetBlockers, 'execute'>;
  readonly searchProjectEvidence: Pick<SearchProjectEvidence, 'execute'>;
  readonly listOpportunities: Pick<ListOpportunities, 'execute'>;
  readonly evaluateOpportunity: Pick<EvaluateOpportunity, 'execute'>;
  readonly createProjectNote: Pick<CreateProjectNote, 'execute'>;
}
export type InvocationFailureKind =
  | 'admission'
  | 'context_resolution'
  | 'execution'
  | 'output_validation'
  | 'response_size'
  | 'deadline';

export interface InvocationLog {
  readonly event: 'mcp.invocation';
  readonly requestId: string;
  readonly toolName: ToolName | 'unknown';
  readonly actorUserId: string | null;
  readonly tenantId: string | null;
  readonly durationMs: number;
  readonly resultStatus: 'success' | 'error';
  readonly errorCategory?: ApplicationErrorCode;
  readonly failureKind?: InvocationFailureKind;
}
export interface InvocationLogger {
  info(record: InvocationLog): void;
  warn(record: InvocationLog): void;
  error(record: InvocationLog): void;
}

export function createMcpServer(dependencies: {
  useCases: McpUseCases;
  context: RequestContextProvider;
  logger: InvocationLogger;
  invocations?: { enter(): (() => void) | null };
  admission?: InvocationAdmission;
}): McpServer {
  const server = new McpServer({ name: 'beloveddev-mcp', version: '0.0.0' });
  const admission = dependencies.admission ?? new InvocationAdmission(dependencies.invocations);
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  async function invoke(
    name: ToolName,
    operation: (context: RequestContext | null) => Promise<unknown>,
  ): Promise<CallToolResult> {
    const requestId = randomUUID();
    const started = performance.now();
    const state: { context: RequestContext | null } = { context: null };
    let errorCategory: ApplicationErrorCode | undefined;
    let phase: InvocationFailureKind = 'admission';
    let failureKind: InvocationFailureKind | undefined;
    let release: (() => void) | undefined;
    let executing = false;
    let responseFinished = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseWhenFinished = () => {
      if (responseFinished && !executing) release?.();
    };
    const checkDeadline = () => {
      if (expired || performance.now() - started >= APPLICATION_RESPONSE_DEADLINE_MS) {
        expired = true;
        throw new ApplicationError('INTERNAL_ERROR');
      }
    };
    try {
      release = admission.enter();
      phase = 'context_resolution';
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new ApplicationError('INTERNAL_ERROR'));
        }, APPLICATION_RESPONSE_DEADLINE_MS);
      });
      executing = true;
      const execution = (async (): Promise<CallToolResult> => {
        const context = await dependencies.context.resolve(requestId);
        state.context = context;
        // An expired context lookup must not initiate a new application operation.
        checkDeadline();
        phase = 'execution';
        const result = await operation(context);
        phase = 'output_validation';
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
          throw new ApplicationError('INTERNAL_ERROR');
        }
        const validated = toolSchemas[name].output.safeParse({ ...result, meta: { requestId } });
        if (!validated.success) throw new ApplicationError('INTERNAL_ERROR');
        const response: CallToolResult = {
          content: [{ type: 'text', text: JSON.stringify(validated.data) }],
          structuredContent: validated.data,
        };
        // Count UTF-8 bytes of both success representations, including JSON escaping.
        // The SDK-owned JSON-RPC framing is outside the application response limit.
        phase = 'response_size';
        if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_SUCCESS_RESPONSE_BYTES) {
          throw new ApplicationError('INTERNAL_ERROR');
        }
        checkDeadline();
        return response;
      })().finally(() => {
        executing = false;
        releaseWhenFinished();
      });
      // Promise.race observes late rejection too; a deadline neither cancels nor
      // releases application work which may still commit an audited mutation.
      return await Promise.race([execution, deadline]);
    } catch (error: unknown) {
      const overdue =
        release !== undefined &&
        (expired || performance.now() - started >= APPLICATION_RESPONSE_DEADLINE_MS);
      const safe = overdue ? new ApplicationError('INTERNAL_ERROR') : toApplicationError(error);
      errorCategory = safe.code;
      if (safe.code === 'INTERNAL_ERROR' || safe.code === 'RATE_LIMITED') {
        failureKind = overdue ? 'deadline' : phase;
      }
      const payload = safeErrorSchema.parse({
        error: { code: safe.code, message: safe.message, requestId },
      });
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    } finally {
      clearTimeout(timer);
      try {
        const level =
          errorCategory === undefined
            ? 'info'
            : errorCategory === 'INTERNAL_ERROR'
              ? 'error'
              : 'warn';
        dependencies.logger[level]({
          event: 'mcp.invocation',
          requestId,
          toolName: name,
          actorUserId: state.context?.userId ?? null,
          tenantId: state.context?.tenantId ?? null,
          durationMs: Math.max(0, performance.now() - started),
          resultStatus: errorCategory === undefined ? 'success' : 'error',
          ...(errorCategory === undefined ? {} : { errorCategory }),
          ...(failureKind === undefined ? {} : { failureKind }),
        });
      } catch {
        // An unavailable diagnostic sink cannot replace a result (possibly a
        // committed write), strand capacity, or fall back to protocol stdout.
      } finally {
        responseFinished = true;
        releaseWhenFinished();
      }
    }
  }

  server.registerTool(
    'get_profile',
    {
      description: toolSchemas.get_profile.description,
      inputSchema: toolSchemas.get_profile.input,
      outputSchema: toolSchemas.get_profile.output,
      annotations,
    },
    (input) =>
      invoke('get_profile', (context) => dependencies.useCases.getProfile.execute(context, input)),
  );
  server.registerTool(
    'list_projects',
    {
      description: toolSchemas.list_projects.description,
      inputSchema: toolSchemas.list_projects.input,
      outputSchema: toolSchemas.list_projects.output,
      annotations,
    },
    (input) =>
      invoke('list_projects', (context) =>
        dependencies.useCases.listProjects.execute(context, input),
      ),
  );
  server.registerTool(
    'get_project',
    {
      description: toolSchemas.get_project.description,
      inputSchema: toolSchemas.get_project.input,
      outputSchema: toolSchemas.get_project.output,
      annotations,
    },
    (input) =>
      invoke('get_project', (context) => dependencies.useCases.getProject.execute(context, input)),
  );
  server.registerTool(
    'search_project_evidence',
    {
      description: toolSchemas.search_project_evidence.description,
      inputSchema: toolSchemas.search_project_evidence.input,
      outputSchema: toolSchemas.search_project_evidence.output,
      annotations,
    },
    (input) =>
      invoke('search_project_evidence', (context) =>
        dependencies.useCases.searchProjectEvidence.execute(context, input),
      ),
  );
  server.registerTool(
    'get_blockers',
    {
      description: toolSchemas.get_blockers.description,
      inputSchema: toolSchemas.get_blockers.input,
      outputSchema: toolSchemas.get_blockers.output,
      annotations,
    },
    (input) =>
      invoke('get_blockers', (context) =>
        dependencies.useCases.getBlockers.execute(context, input),
      ),
  );
  server.registerTool(
    'list_opportunities',
    {
      description: toolSchemas.list_opportunities.description,
      inputSchema: toolSchemas.list_opportunities.input,
      outputSchema: toolSchemas.list_opportunities.output,
      annotations,
    },
    (input) =>
      invoke('list_opportunities', (context) =>
        dependencies.useCases.listOpportunities.execute(context, input),
      ),
  );
  server.registerTool(
    'evaluate_opportunity',
    {
      description: toolSchemas.evaluate_opportunity.description,
      inputSchema: toolSchemas.evaluate_opportunity.input,
      outputSchema: toolSchemas.evaluate_opportunity.output,
      annotations,
    },
    (input) =>
      invoke('evaluate_opportunity', (context) =>
        dependencies.useCases.evaluateOpportunity.execute(context, input),
      ),
  );
  server.registerTool(
    'create_project_note',
    {
      description: toolSchemas.create_project_note.description,
      inputSchema: toolSchemas.create_project_note.input,
      outputSchema: toolSchemas.create_project_note.output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      invoke('create_project_note', (context) =>
        dependencies.useCases.createProjectNote.execute(context, input),
      ),
  );
  return server;
}
