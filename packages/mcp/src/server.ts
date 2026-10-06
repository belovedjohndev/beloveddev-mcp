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
import { safeErrorSchema, toolSchemas, type ToolName } from './schemas.js';

export interface ReadUseCases {
  readonly getProfile: Pick<GetProfile, 'execute'>;
  readonly listProjects: Pick<ListProjects, 'execute'>;
  readonly getProject: Pick<GetProject, 'execute'>;
  readonly getBlockers: Pick<GetBlockers, 'execute'>;
}
export interface InvocationLog {
  readonly event: 'mcp.invocation';
  readonly requestId: string;
  readonly toolName: ToolName | 'unknown';
  readonly actorUserId: string | null;
  readonly tenantId: string | null;
  readonly durationMs: number;
  readonly resultStatus: 'success' | 'error';
  readonly errorCategory?: ApplicationErrorCode;
}
export interface InvocationLogger {
  info(record: InvocationLog): void;
}

export function createMcpServer(dependencies: {
  useCases: ReadUseCases;
  context: RequestContextProvider;
  logger: InvocationLogger;
}): McpServer {
  const server = new McpServer({ name: 'beloveddev-mcp', version: '0.0.0' });
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
    let context: RequestContext | null = null;
    let errorCategory: ApplicationErrorCode | undefined;
    try {
      context = await dependencies.context.resolve(requestId);
      const result = await operation(context);
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new ApplicationError('INTERNAL_ERROR');
      }
      const validated = toolSchemas[name].output.safeParse({
        ...result,
        meta: { requestId },
      });
      if (!validated.success) throw new ApplicationError('INTERNAL_ERROR');
      return {
        content: [{ type: 'text', text: JSON.stringify(validated.data) }],
        structuredContent: validated.data,
      };
    } catch (error: unknown) {
      const safe = toApplicationError(error);
      errorCategory = safe.code;
      const payload = safeErrorSchema.parse({
        error: { code: safe.code, message: safe.message, requestId },
      });
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    } finally {
      dependencies.logger.info({
        event: 'mcp.invocation',
        requestId,
        toolName: name,
        actorUserId: context?.userId ?? null,
        tenantId: context?.tenantId ?? null,
        durationMs: Math.max(0, performance.now() - started),
        resultStatus: errorCategory === undefined ? 'success' : 'error',
        ...(errorCategory === undefined ? {} : { errorCategory }),
      });
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
  return server;
}
