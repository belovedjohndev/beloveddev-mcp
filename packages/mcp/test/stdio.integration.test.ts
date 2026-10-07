import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { projectEvidence } from '@beloveddev/database/schema';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import {
  evidenceInput,
  seedProjectKnowledge,
  type ProjectKnowledgeFixtures,
} from '@beloveddev/test-support/project-knowledge-fixtures';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';

const main = fileURLToPath(new URL('../../../apps/mcp-server/dist/main.js', import.meta.url));
const secret = 'private-stdio-test-signing-key-at-least-32-bytes';
const logSchema = z.object({
  event: z.string(),
  requestId: z.uuid().optional(),
  toolName: z.string().optional(),
  actorUserId: z.uuid().nullable().optional(),
  tenantId: z.uuid().nullable().optional(),
  resultStatus: z.enum(['success', 'error']).optional(),
  errorCategory: z.string().optional(),
});
function logs(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => logSchema.parse(JSON.parse(line)));
}
function safeError(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected safe error text');
  return safeErrorSchema.parse(JSON.parse(content.text)).error;
}

// Raw JSON-RPC verifies every stdout line, including discovery-to-legacy fallback.
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Response = z.infer<typeof responseSchema>;
function rawServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [main], { env, stdio: 'pipe', windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const failures: unknown[] = [];
  const output: string[] = [];
  let stderr = '';
  let nextId = 1;
  const pending = new Map<number, (response: Response) => void>();
  lines.on('line', (line) => {
    output.push(line);
    try {
      const response = responseSchema.parse(JSON.parse(line));
      pending.get(response.id)?.(response);
    } catch (error: unknown) {
      failures.push(error);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return {
    failures,
    output,
    get stderr() {
      return stderr;
    },
    async request(method: string, params?: Record<string, unknown>) {
      const id = nextId++;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Response>((resolve, reject) => {
          pending.set(id, resolve);
          timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 8000);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      } finally {
        clearTimeout(timeout);
        pending.delete(id);
      }
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    async close() {
      child.stdin.end();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              child.kill();
              reject(new Error('MCP process did not exit after EOF'));
            }, 8000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}

describe('compiled MCP stdio composition with PostgreSQL', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let knowledge: ProjectKnowledgeFixtures;
  let extraEvidenceIds: { a: string; b: string };
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env));
    const role = new URL(database.runtimeUrl).username;
    if (!/^beloveddev_test_[0-9a-f]{32}_runtime$/.test(role))
      throw new Error('Unexpected test role');
    await database.admin.pool.query(`REVOKE INSERT ON projects FROM "${role}"`);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    knowledge = await seedProjectKnowledge(database.admin.db, tenants);
    extraEvidenceIds = { a: randomUUID(), b: randomUUID() };
    await database.admin.db.insert(projectEvidence).values(
      (['a', 'b'] as const).map((tenant) => ({
        ...evidenceInput(tenants[tenant]),
        id: extraEvidenceIds[tenant],
        type: 'automation' as const,
        title: 'PostgreSQL dashboard automation',
        summary: 'A searchable operations dashboard',
        details: 'React interface with reliable automation.',
        skills: ['React'],
        capabilities: ['Dashboard delivery'],
        businessOutcomes: ['Workflow automation'],
      })),
    );
  });
  afterEach(async () => {
    if (tenants) await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database?.close();
  });

  function environment(identity?: TenantFixtures['a']) {
    return {
      ...getDefaultEnvironment(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: database.runtimeUrl,
      MCP_AUTH_MODE: 'local',
      MCP_CURSOR_SECRET: secret,
      ...(identity
        ? { MCP_LOCAL_TENANT_ID: identity.tenantId, MCP_LOCAL_USER_ID: identity.userId }
        : {}),
    };
  }

  it.each(['a', 'b'] as const)(
    'SDK client reads all five tools as tenant %s through SELECT-only credentials',
    async (tenant) => {
      const identity = tenants[tenant];
      const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [main],
        env: environment(identity),
        stderr: 'pipe',
      });
      let stderr = '';
      const protocolErrors: Error[] = [];
      client.onerror = (error) => {
        protocolErrors.push(error);
      };
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const requestIds: string[] = [];
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools).toHaveLength(5);
        const profile = toolSchemas.get_profile.output.parse(
          (await client.callTool({ name: 'get_profile', arguments: {} })).structuredContent,
        );
        expect(profile.profile.id).toBe(identity.profileId);
        requestIds.push(profile.meta.requestId);
        const projects = toolSchemas.list_projects.output.parse(
          (await client.callTool({ name: 'list_projects', arguments: {} })).structuredContent,
        );
        expect(projects.projects.map((project) => project.id)).toEqual([identity.projectId]);
        requestIds.push(projects.meta.requestId);
        const project = toolSchemas.get_project.output.parse(
          (
            await client.callTool({
              name: 'get_project',
              arguments: { projectId: identity.projectId },
            })
          ).structuredContent,
        );
        expect(project.client?.id).toBe(identity.clientId);
        expect(project.evidenceSummary).toHaveLength(2);
        expect(project.openBlockers).toHaveLength(1);
        expect(project.recentNotes).toHaveLength(1);
        requestIds.push(project.meta.requestId);
        const blockers = toolSchemas.get_blockers.output.parse(
          (await client.callTool({ name: 'get_blockers', arguments: {} })).structuredContent,
        );
        expect(blockers.blockers.map((blocker) => blocker.projectId)).toEqual([identity.projectId]);
        requestIds.push(blockers.meta.requestId);
        const firstSearchPage = toolSchemas.search_project_evidence.output.parse(
          (
            await client.callTool({
              name: 'search_project_evidence',
              arguments: { query: 'PostgreSQL', limit: 1 },
            })
          ).structuredContent,
        );
        expect(firstSearchPage.results).toHaveLength(1);
        expect(firstSearchPage.results[0]).toMatchObject({
          evidenceId: extraEvidenceIds[tenant],
          projectId: identity.projectId,
          projectName: 'Portfolio Platform',
          type: 'automation',
          title: 'PostgreSQL dashboard automation',
        });
        expect(firstSearchPage.results[0]?.relevanceScore).toBeTypeOf('number');
        expect(firstSearchPage.nextCursor).toBeTypeOf('string');
        requestIds.push(firstSearchPage.meta.requestId);
        const secondSearchPage = toolSchemas.search_project_evidence.output.parse(
          (
            await client.callTool({
              name: 'search_project_evidence',
              arguments: {
                query: 'PostgreSQL',
                limit: 1,
                cursor: firstSearchPage.nextCursor,
              },
            })
          ).structuredContent,
        );
        expect(secondSearchPage.results.map((result) => result.evidenceId)).toEqual([
          knowledge[tenant].evidenceId,
        ]);
        expect(secondSearchPage.nextCursor).toBeUndefined();
        requestIds.push(secondSearchPage.meta.requestId);
        const filteredSearch = toolSchemas.search_project_evidence.output.parse(
          (
            await client.callTool({
              name: 'search_project_evidence',
              arguments: {
                query: 'PostgreSQL',
                evidenceTypes: ['architecture'],
                skills: ['postgresql'],
              },
            })
          ).structuredContent,
        );
        expect(filteredSearch.results.map((result) => result.evidenceId)).toEqual([
          knowledge[tenant].evidenceId,
        ]);
        requestIds.push(filteredSearch.meta.requestId);
        const other = tenant === 'a' ? tenants.b : tenants.a;
        const foreignSearch = toolSchemas.search_project_evidence.output.parse(
          (
            await client.callTool({
              name: 'search_project_evidence',
              arguments: { query: 'PostgreSQL', projectIds: [other.projectId] },
            })
          ).structuredContent,
        );
        expect(foreignSearch.results).toEqual([]);
        requestIds.push(foreignSearch.meta.requestId);
        expect(
          safeError(
            await client.callTool({
              name: 'get_project',
              arguments: { projectId: other.projectId },
            }),
          ).code,
        ).toBe('NOT_FOUND');
        const malformed = await client.callTool({
          name: 'get_project',
          arguments: { projectId: 'invalid' },
        });
        expect(malformed.isError).toBe(true);
        // Active identity is re-resolved; revocation is effective on the next call.
        await database.admin.pool.query(
          "UPDATE tenant_memberships SET status='inactive' WHERE id=$1",
          [identity.membershipId],
        );
        expect(safeError(await client.callTool({ name: 'get_profile', arguments: {} })).code).toBe(
          'UNAUTHENTICATED',
        );
      } finally {
        await client.close();
      }
      expect(protocolErrors).toEqual([]);
      expect(new Set(requestIds).size).toBe(8);
      const records = logs(stderr);
      const invocations = records.filter((record) => record.event === 'mcp.invocation');
      expect(invocations).toHaveLength(10); // SDK-rejected input never enters the application wrapper.
      expect(
        invocations
          .filter((record) => record.resultStatus === 'success')
          .map((record) => record.requestId),
      ).toEqual(requestIds);
      expect(
        invocations
          .filter((record) => record.resultStatus === 'success')
          .every(
            (record) =>
              record.tenantId === identity.tenantId && record.actorUserId === identity.userId,
          ),
      ).toBe(true);
      expect(records.some((record) => record.event === 'mcp.stopped')).toBe(true);
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain(database.runtimeUrl);
      expect(stderr).not.toContain('Composite references');
    },
  );

  it('preserves protocol-only stdout across a discovery probe, legacy initialization, tools, and EOF', async () => {
    const server = rawServer(environment(tenants.a));
    try {
      const discovery = await server.request('server/discover', {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'raw-stdio-smoke',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      });
      expect(discovery.error).toBeUndefined();
      const initialized = await server.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-stdio-smoke', version: '1.0.0' },
      });
      expect(initialized.error).toBeUndefined();
      server.notify('notifications/initialized');
      expect((await server.request('tools/list')).result).toHaveProperty('tools');
      for (const name of [
        'get_profile',
        'list_projects',
        'get_project',
        'search_project_evidence',
        'get_blockers',
      ] as const) {
        const response = await server.request('tools/call', {
          name,
          arguments:
            name === 'get_project'
              ? { projectId: tenants.a.projectId }
              : name === 'search_project_evidence'
                ? { query: 'PostgreSQL' }
                : {},
        });
        expect(response.error).toBeUndefined();
        const result = z
          .object({
            content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
            structuredContent: z.unknown(),
          })
          .parse(response.result);
        expect(toolSchemas[name].output.safeParse(result.structuredContent).success).toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
      }
      expect(
        (await server.request('tools/call', { name: 'unknown_tool', arguments: {} })).error,
      ).toHaveProperty('code');
      expect((await server.request('tools/call', { name: 123 })).error).toHaveProperty('code');
    } finally {
      expect(await server.close()).toBe(0);
    }
    expect(server.failures).toEqual([]);
    expect(server.output).toHaveLength(10);
    const records = logs(server.stderr);
    expect(records.filter((record) => record.event === 'mcp.invocation')).toHaveLength(5);
    expect(records.filter((record) => record.event === 'mcp.stopped')).toHaveLength(1);
    expect(server.output.join('')).not.toContain(secret);
    expect(server.stderr).not.toContain(secret);
    expect(server.stderr).not.toContain(database.runtimeUrl);
  });

  it('starts without a local principal and returns a safe unauthenticated application error', async () => {
    const client = new Client({ name: 'unconfigured-principal', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [main],
      env: environment(),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const error = safeError(await client.callTool({ name: 'get_profile', arguments: {} }));
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(logs(stderr)).toContainEqual(
        expect.objectContaining({
          event: 'mcp.invocation',
          requestId: error.requestId,
          actorUserId: null,
          tenantId: null,
        }),
      );
    } finally {
      await client.close();
    }
  });
});
