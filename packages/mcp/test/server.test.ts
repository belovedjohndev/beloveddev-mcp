import {
  Client,
  InMemoryTransport,
  ProtocolError,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import {
  PermissionAuthorization,
  type RequestContext,
} from '@beloveddev/application/request-context';
import { ApplicationError } from '@beloveddev/application/application-error';
import { RepositoryError } from '@beloveddev/application/repository-error';
import { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import { ListProjects } from '@beloveddev/application/use-cases/list-projects';
import { GetProject } from '@beloveddev/application/use-cases/get-project';
import { GetBlockers } from '@beloveddev/application/use-cases/get-blockers';
import { SignedCursorCodec } from '@beloveddev/infrastructure/signed-cursor';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, type InvocationLog } from '../src/server.js';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';

function errorPayload(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected JSON error text');
  return safeErrorSchema.parse(JSON.parse(first.text));
}

describe('MCP SDK and application contracts', () => {
  let fixture: ReturnType<typeof createReadFixture>;
  let principal: RequestContext | null;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let logs: InvocationLog[];
  let useCases: {
    getProfile: GetProfile;
    listProjects: ListProjects;
    getProject: GetProject;
    getBlockers: GetBlockers;
  };
  let resolve: ReturnType<typeof vi.fn<(requestId: string) => Promise<RequestContext | null>>>;

  beforeEach(async () => {
    fixture = createReadFixture();
    principal = fixture.context;
    logs = [];
    const authorization = new PermissionAuthorization();
    const cursors = new SignedCursorCodec('contract-test-secret-at-least-32-bytes');
    const r = fixture.repositories;
    useCases = {
      getProfile: new GetProfile(r.profiles, authorization),
      listProjects: new ListProjects(r.projects, authorization, cursors),
      getProject: new GetProject(r, authorization),
      getBlockers: new GetBlockers(r.blockers, authorization, cursors),
    };
    resolve = vi.fn((requestId: string) =>
      Promise.resolve(principal === null ? null : { ...principal, requestId }),
    );
    server = createMcpServer({
      useCases,
      context: { resolve },
      logger: {
        info: (record) => {
          logs.push(record);
        },
      },
    });
    client = new Client({ name: 'contract-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('advertises exactly four read-only tools with strict input and success-output schemas', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'get_profile',
      'list_projects',
      'get_project',
      'get_blockers',
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema['additionalProperties']).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('tenantId');
      expect(tool.inputSchema.properties).not.toHaveProperty('userId');
      expect(tool.inputSchema.properties).not.toHaveProperty('role');
      expect(tool.inputSchema.properties).not.toHaveProperty('permissions');
      expect(tool.outputSchema).toHaveProperty('type', 'object');
    }
  });

  it.each([
    ['get_profile', { tenantId: 'private-tenant' }],
    ['get_profile', { role: 'owner' }],
    ['get_profile', { permissions: ['profile:read'] }],
    ['list_projects', { limit: 0 }],
    ['list_projects', { limit: 101 }],
    ['list_projects', { clientId: 'invalid' }],
    ['get_project', { projectId: 'invalid' }],
    ['get_project', {}],
    ['get_blockers', { severity: 'invalid' }],
    ['get_blockers', { userId: 'private-user' }],
  ])(
    'SDK rejects malformed %s arguments before context, use cases, or repositories',
    async (name, args) => {
      const spies = [
        vi.spyOn(useCases.getProfile, 'execute'),
        vi.spyOn(useCases.listProjects, 'execute'),
        vi.spyOn(useCases.getProject, 'execute'),
        vi.spyOn(useCases.getBlockers, 'execute'),
      ];
      const result = await client.callTool({
        name,
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(fixture.calls).toEqual([]);
      expect(logs).toEqual([]);
    },
  );

  it('unknown tools stay at the SDK boundary', async () => {
    await expect(client.callTool({ name: 'unknown_tool', arguments: {} })).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each(['get_profile', 'list_projects', 'get_project', 'get_blockers'] as const)(
    'valid %s calls share request IDs, context, safe output, and invocation logs',
    async (name) => {
      const result = await client.callTool({
        name,
        arguments: name === 'get_project' ? { projectId: fixture.project.id } : {},
      });
      expect(result.isError).not.toBe(true);
      const output = toolSchemas[name].output.parse(result.structuredContent);
      const first = result.content[0];
      if (first?.type !== 'text') throw new Error('Missing JSON response');
      expect(JSON.parse(first.text) as unknown).toEqual(output);
      expect(output.meta.requestId).toBe(resolve.mock.calls[0]?.[0]);
      expect(logs).toEqual([
        expect.objectContaining({
          requestId: output.meta.requestId,
          toolName: name,
          actorUserId: fixture.context.userId,
          tenantId: fixture.context.tenantId,
          resultStatus: 'success',
        }),
      ]);
      expect(logs[0]?.durationMs).toBeTypeOf('number');
      expect(fixture.calls.length).toBeGreaterThan(0);
      expect(first.text).not.toContain('tenantId');
      expect(first.text).not.toContain('idempotencyKey');
    },
  );

  it.each(['get_profile', 'list_projects', 'get_project', 'get_blockers'] as const)(
    '%s rejects missing principal before protected repository work',
    async (name) => {
      principal = null;
      const result = await client.callTool({
        name,
        arguments: name === 'get_project' ? { projectId: fixture.project.id } : {},
      });
      const payload = errorPayload(result);
      expect(payload.error.code).toBe('UNAUTHENTICATED');
      expect(payload.error.requestId).toBe(logs[0]?.requestId);
      expect(fixture.calls).toEqual([]);
    },
  );

  it.each(['get_profile', 'list_projects', 'get_project', 'get_blockers'] as const)(
    '%s requires its permission before repository work',
    async (name) => {
      principal = {
        ...fixture.context,
        permissions: name === 'get_profile' ? ['projects:read'] : ['profile:read'],
      };
      const payload = errorPayload(
        await client.callTool({
          name,
          arguments: name === 'get_project' ? { projectId: fixture.project.id } : {},
        }),
      );
      expect(payload.error.code).toBe('FORBIDDEN');
      expect(logs[0]).toMatchObject({
        resultStatus: 'error',
        errorCategory: 'FORBIDDEN',
        requestId: payload.error.requestId,
      });
      expect(fixture.calls).toEqual([]);
    },
  );

  it('get_profile returns NOT_FOUND without exposing foreign profiles', async () => {
    fixture.data.profiles.splice(0, 1);
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(fixture.calls).toEqual([
      { method: 'profile', input: { tenantId: fixture.context.tenantId } },
    ]);
  });

  it('lists projects with defaults, filters, tenant scope, and signed continuation', async () => {
    fixture.data.projects.push({ ...fixture.project, id: fixtureId(20), slug: 'second' });
    const first = toolSchemas.list_projects.output.parse(
      (
        await client.callTool({
          name: 'list_projects',
          arguments: {
            limit: 1,
            status: 'active',
            clientId: fixture.client.id,
            query: 'Portfolio',
          },
        })
      ).structuredContent,
    );
    expect(first.projects.map((p) => p.id)).toEqual([fixture.project.id]);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = toolSchemas.list_projects.output.parse(
      (
        await client.callTool({
          name: 'list_projects',
          arguments: {
            limit: 1,
            status: 'active',
            clientId: fixture.client.id,
            query: 'Portfolio',
            cursor: first.nextCursor,
          },
        })
      ).structuredContent,
    );
    expect(second.projects.map((p) => p.id)).toEqual([fixtureId(20)]);
    expect(second.nextCursor).toBeUndefined();
    const defaults = toolSchemas.list_projects.output.parse(
      (await client.callTool({ name: 'list_projects', arguments: {} })).structuredContent,
    );
    expect(defaults.projects).toHaveLength(2);
    expect(fixture.calls.at(-1)).toEqual({
      method: 'projects',
      input: { tenantId: fixture.context.tenantId, limit: 20 },
    });
  });

  it.each(['list_projects', 'get_blockers'] as const)(
    '%s rejects malformed cursors as application errors without repository access',
    async (name) => {
      const payload = errorPayload(
        await client.callTool({ name, arguments: { cursor: 'malformed' } }),
      );
      expect(payload.error.code).toBe('VALIDATION_ERROR');
      expect(logs[0]?.requestId).toBe(payload.error.requestId);
      expect(fixture.calls).toEqual([]);
    },
  );

  it('get_project returns a bounded aggregate and excludes internal fields', async () => {
    for (let i = 0; i < 30; i++) {
      fixture.data.evidence.push({ ...fixture.evidence, id: fixtureId(100 + i) });
      fixture.data.blockers.push({ ...fixture.blocker, id: fixtureId(200 + i) });
      fixture.data.notes.push({ ...fixture.note, id: fixtureId(300 + i) });
    }
    const result = await client.callTool({
      name: 'get_project',
      arguments: { projectId: fixture.project.id },
    });
    const output = toolSchemas.get_project.output.parse(result.structuredContent);
    expect(output.client).toEqual({ id: fixture.client.id, name: fixture.client.name });
    expect(output.evidenceSummary).toHaveLength(20);
    expect(output.openBlockers).toHaveLength(20);
    expect(output.recentNotes).toHaveLength(10);
    expect(output.evidenceSummary[0]).not.toHaveProperty('details');
    expect(output.recentNotes[0]).not.toHaveProperty('authorUserId');
  });

  it('get_project handles a project without a client', async () => {
    fixture.data.projects[0] = { ...fixture.project, clientId: null };
    const output = toolSchemas.get_project.output.parse(
      (await client.callTool({ name: 'get_project', arguments: { projectId: fixture.project.id } }))
        .structuredContent,
    );
    expect(output.client).toBeNull();
    expect(fixture.calls.some((call) => call.method === 'client')).toBe(false);
  });

  it('cross-tenant and missing projects produce identical NOT_FOUND categories and messages', async () => {
    const foreign = errorPayload(
      await client.callTool({
        name: 'get_project',
        arguments: { projectId: fixture.otherProject.id },
      }),
    );
    const missing = errorPayload(
      await client.callTool({ name: 'get_project', arguments: { projectId: fixtureId(999) } }),
    );
    expect(foreign.error.code).toBe('NOT_FOUND');
    expect(missing.error.code).toBe(foreign.error.code);
    expect(missing.error.message).toBe(foreign.error.message);
    expect(fixture.calls.map((call) => call.method)).toEqual(['project', 'project']);
  });

  it('get_blockers combines tenant/project/severity scope, open-only default, and pagination', async () => {
    fixture.data.blockers.push(
      { ...fixture.blocker, id: fixtureId(21) },
      { ...fixture.blocker, id: fixtureId(22), severity: 'low' },
      { ...fixture.blocker, id: fixtureId(23), status: 'resolved', resolvedAt: new Date() },
      {
        ...fixture.blocker,
        id: fixtureId(24),
        tenantId: fixture.otherContext.tenantId,
        projectId: fixture.otherProject.id,
      },
    );
    const args = { projectId: fixture.project.id, severity: 'high', limit: 1 };
    const first = toolSchemas.get_blockers.output.parse(
      (await client.callTool({ name: 'get_blockers', arguments: args })).structuredContent,
    );
    expect(first.blockers.map((row) => row.id)).toEqual([fixture.blocker.id]);
    const second = toolSchemas.get_blockers.output.parse(
      (
        await client.callTool({
          name: 'get_blockers',
          arguments: { ...args, cursor: first.nextCursor },
        })
      ).structuredContent,
    );
    expect(second.blockers.map((row) => row.id)).toEqual([fixtureId(21)]);
    expect(second.nextCursor).toBeUndefined();
    const all = toolSchemas.get_blockers.output.parse(
      (await client.callTool({ name: 'get_blockers', arguments: {} })).structuredContent,
    );
    expect(all.blockers).toHaveLength(3);
    const foreign = toolSchemas.get_blockers.output.parse(
      (
        await client.callTool({
          name: 'get_blockers',
          arguments: { projectId: fixture.otherProject.id },
        })
      ).structuredContent,
    );
    expect(foreign.blockers).toEqual([]);
  });

  it.each([new RepositoryError('UNAVAILABLE'), new Error('private SQL /internal/path')])(
    'infrastructure errors never leak raw detail',
    async (failure) => {
      vi.spyOn(fixture.repositories.profiles, 'getByTenant').mockRejectedValue(failure);
      const result = await client.callTool({ name: 'get_profile', arguments: {} });
      expect(errorPayload(result).error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result)).not.toMatch(/private SQL|internal\/path|stack|cause/);
    },
  );

  it('invalid application output is safely rejected by the wrapper', async () => {
    vi.spyOn(useCases.getProfile, 'execute').mockResolvedValue({
      profile: { ...fixture.profile, yearsExperience: -1 },
    });
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(logs[0]?.errorCategory).toBe('INTERNAL_ERROR');
  });

  it('context-provider failures use the safe application boundary', async () => {
    resolve.mockRejectedValue(new ApplicationError('INTERNAL_ERROR'));
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.requestId).toBe(logs[0]?.requestId);
    expect(fixture.calls).toEqual([]);
  });
});
