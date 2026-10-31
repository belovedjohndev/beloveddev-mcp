import { ProcessDiagnostics, probeOptions } from '../../test-support/test/process-diagnostics.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { auditLogs, projectEvidence, projectNotes, projects } from '@beloveddev/database/schema';
import {
  createTestDatabase,
  cleanupTestResources,
  withTestResourceCleanup,
  type TestDatabase,
} from '@beloveddev/test-support/test-database';
import {
  projectInput,
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import {
  evidenceInput,
  seedProjectKnowledge,
  type ProjectKnowledgeFixtures,
} from '@beloveddev/test-support/project-knowledge-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const entrypoint = fileURLToPath(new URL('../../../apps/mcp-server/dist/main.js', import.meta.url));
const secret = 'private-stdio-test-signing-key-at-least-32-bytes';
const logSchema = z.object({
  event: z.string(),
  category: z.string().optional(),
  requestId: z.uuid().optional(),
  toolName: z.string().optional(),
  actorUserId: z.uuid().nullable().optional(),
  tenantId: z.uuid().nullable().optional(),
  resultStatus: z.enum(['success', 'error']).optional(),
  errorCategory: z.string().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  reason: z
    .enum(['SIGINT', 'SIGTERM', 'transport_closed', 'database_error', 'startup_error'])
    .optional(),
  phase: z.enum(['input', 'transport', 'database', 'output']).optional(),
  exitCode: z.union([z.literal(0), z.literal(1)]).optional(),
  activeInvocations: z.number().int().nonnegative().optional(),
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

const activeRawServers = new Set<() => Promise<number | null>>();
function closeRawServers() {
  return cleanupTestResources(
    [...activeRawServers].map((close) => ({
      stage: 'raw_stdio_process',
      run: async () => {
        await close();
      },
    })),
  );
}
// Raw JSON-RPC verifies every stdout line, including discovery-to-legacy fallback.
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Response = z.infer<typeof responseSchema>;
function rawServer(
  env: Record<string, string>,
  launch: { command?: string; args?: string[]; cwd?: string } = {},
) {
  const diagnostic = new ProcessDiagnostics(
    expect.getState().currentTestName ?? 'stdio subprocess',
  );
  const probe = probeOptions(env);
  diagnostic.mark('spawn_called');
  const child = spawn(launch.command ?? process.execPath, launch.args ?? [entrypoint], {
    cwd: launch.cwd ?? tmpdir(),
    env: probe.env,
    stdio: probe.ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe',
    windowsHide: true,
  });
  const { stdin, stdout, stderr: stderrStream } = child;
  if (!stdin || !stdout || !stderrStream) {
    child.kill('SIGKILL');
    throw new Error('Owned subprocess pipes unavailable.');
  }
  child.once('spawn', () => diagnostic.mark('spawned'));
  child.on('message', (message: unknown) => diagnostic.message(message));
  child.once('error', () => diagnostic.mark('spawn_error'));
  const lines = createInterface({ input: stdout });
  const failures: unknown[] = [];
  const output: string[] = [];
  let stderr = '';
  let nextId = 1;
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }
  >();
  lines.on('line', (line) => {
    output.push(line);
    try {
      const response = responseSchema.parse(JSON.parse(line));
      diagnostic.mark('response');
      diagnostic.response(pending.get(response.id)?.method ?? 'other', response.error);
      pending.get(response.id)?.resolve(response);
    } catch (error: unknown) {
      diagnostic.mark('protocol_invalid');
      failures.push(error);
    }
  });
  stderrStream.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    diagnostic.stderr(chunk.toString());
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    // Wait for pipe closure as well as exit so assertions see the final stderr records.
    child.once('close', (code, signal) => {
      diagnostic.exit(code, signal);
      if (code === null) diagnostic.mark('process_terminated');
      else if (code !== 0) diagnostic.mark('process_exit_nonzero');
      diagnostic.mark('closed');
      diagnostic.publish();
      resolve(code);
    });
    child.once('error', reject);
  });
  void exited.then(
    () => {
      for (const request of pending.values()) request.reject(new Error('MCP process closed'));
    },
    () => {
      for (const request of pending.values()) request.reject(new Error('MCP process failed'));
    },
  );
  async function waitForExit() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            diagnostic.mark('cleanup_timeout');
            child.kill('SIGKILL');
            reject(new Error('MCP process did not exit within its shutdown deadline'));
          }, 18_000);
        }),
      ]);
    } catch (error: unknown) {
      child.kill('SIGKILL');
      await exited.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
      lines.close();
    }
  }
  const close = async () => {
    diagnostic.mark('close_requested');
    stdin.end();
    return waitForExit();
  };
  activeRawServers.add(close);
  void exited.then(
    () => activeRawServers.delete(close),
    () => activeRawServers.delete(close),
  );
  return {
    failures,
    output,
    get stderr() {
      return stderr;
    },
    async request(method: string, params?: Record<string, unknown>) {
      diagnostic.mark(
        method === 'server/discover'
          ? 'discovery_probe_sent'
          : method === 'initialize'
            ? 'initialize_sent'
            : method === 'tools/list'
              ? 'discovery_sent'
              : 'tool_sent',
      );
      const id = nextId++;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Response>((resolve, reject) => {
          pending.set(id, { method, resolve, reject });
          timeout = setTimeout(() => {
            diagnostic.mark('response_timeout');
            reject(new Error('Timed out waiting for MCP response'));
          }, 8000);
          stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      } finally {
        clearTimeout(timeout);
        pending.delete(id);
      }
    },
    notify(method: string) {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    endInput() {
      stdin.end();
    },
    signal(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    waitForExit,
    close,
  };
}

describe('compiled MCP stdio composition with PostgreSQL', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let knowledge: ProjectKnowledgeFixtures;
  let extraEvidenceIds: { a: string; b: string };
  let opportunityIds: Record<
    'a' | 'b',
    {
      newer: string;
      older: string;
      statusExcluded: string;
      sourceExcluded: string;
      queryExcluded: string;
    }
  >;
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
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
    opportunityIds = {
      a: {
        newer: randomUUID(),
        older: randomUUID(),
        statusExcluded: randomUUID(),
        sourceExcluded: randomUUID(),
        queryExcluded: randomUUID(),
      },
      b: {
        newer: randomUUID(),
        older: randomUUID(),
        statusExcluded: randomUUID(),
        sourceExcluded: randomUUID(),
        queryExcluded: randomUUID(),
      },
    };
    for (const tenant of ['a', 'b'] as const) {
      await seedOpportunity(database.admin.db, tenants[tenant].tenantId, {
        id: opportunityIds[tenant].newer,
        source: 'upwork',
        status: 'reviewing',
        title: 'PostgreSQL platform opportunity',
        publishedAt: new Date('2026-09-03T12:00:00Z'),
      });
      await seedOpportunity(database.admin.db, tenants[tenant].tenantId, {
        id: opportunityIds[tenant].older,
        source: 'upwork',
        status: 'reviewing',
        title: 'Second PostgreSQL opportunity',
        publishedAt: new Date('2026-09-02T12:00:00Z'),
      });
      await seedOpportunity(database.admin.db, tenants[tenant].tenantId, {
        id: opportunityIds[tenant].statusExcluded,
        source: 'upwork',
        status: 'new',
        title: 'Status-excluded PostgreSQL opportunity',
        publishedAt: new Date('2026-09-04T12:00:00Z'),
      });
      await seedOpportunity(database.admin.db, tenants[tenant].tenantId, {
        id: opportunityIds[tenant].sourceExcluded,
        source: 'manual',
        status: 'reviewing',
        title: 'Source-excluded PostgreSQL opportunity',
        publishedAt: new Date('2026-09-05T12:00:00Z'),
      });
      await seedOpportunity(database.admin.db, tenants[tenant].tenantId, {
        id: opportunityIds[tenant].queryExcluded,
        source: 'upwork',
        status: 'reviewing',
        title: 'Query-excluded unrelated record',
        description: 'No matching technology term.',
        projectType: 'Other',
        publishedAt: new Date('2026-09-06T12:00:00Z'),
      });
    }
  });
  afterEach(async () => {
    await cleanupTestResources([
      { stage: 'raw_stdio_processes', run: closeRawServers },
      {
        stage: 'tenant_rows',
        run: async () => {
          if (tenants) await removeTenantFixtures(database.admin.db, tenants);
        },
      },
    ]);
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
    'SDK client reads all seven read tools as tenant %s through restricted runtime credentials',
    async (tenant) => {
      const identity = tenants[tenant];
      // Tenant A is an owner; exercise tenant B with the member role here.
      if (tenant === 'b')
        await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
          identity.membershipId,
        ]);
      const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        cwd: tmpdir(),
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
        expect((await client.listTools()).tools).toHaveLength(8);
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
        const opportunityArguments = {
          status: 'reviewing',
          source: ' UPWORK ',
          query: ' POSTGRESQL ',
          limit: 1,
        } as const;
        const firstOpportunityPage = toolSchemas.list_opportunities.output.parse(
          (
            await client.callTool({
              name: 'list_opportunities',
              arguments: opportunityArguments,
            })
          ).structuredContent,
        );
        expect(firstOpportunityPage.opportunities.map((row) => row.id)).toEqual([
          opportunityIds[tenant].newer,
        ]);
        expect(firstOpportunityPage.nextCursor).toBeTypeOf('string');
        expect(firstOpportunityPage.opportunities[0]).not.toHaveProperty('tenantId');
        expect(firstOpportunityPage.opportunities[0]).not.toHaveProperty('externalId');
        expect(firstOpportunityPage.opportunities[0]).not.toHaveProperty('description');
        requestIds.push(firstOpportunityPage.meta.requestId);
        const secondOpportunityPage = toolSchemas.list_opportunities.output.parse(
          (
            await client.callTool({
              name: 'list_opportunities',
              arguments: {
                ...opportunityArguments,
                cursor: firstOpportunityPage.nextCursor,
              },
            })
          ).structuredContent,
        );
        expect(secondOpportunityPage.opportunities.map((row) => row.id)).toEqual([
          opportunityIds[tenant].older,
        ]);
        expect(secondOpportunityPage.nextCursor).toBeUndefined();
        requestIds.push(secondOpportunityPage.meta.requestId);
        const evaluationArguments = { opportunityId: opportunityIds[tenant].newer };
        const evaluationResult = await client.callTool({
          name: 'evaluate_opportunity',
          arguments: evaluationArguments,
        });
        const evaluation = toolSchemas.evaluate_opportunity.output.parse(
          evaluationResult.structuredContent,
        );
        expect(evaluationResult.isError).not.toBe(true);
        const evaluationContent = evaluationResult.content[0];
        if (evaluationContent?.type !== 'text') throw new Error('Expected evaluation JSON content');
        expect(JSON.parse(evaluationContent.text)).toEqual(evaluation);
        expect(evaluation).toMatchObject({
          opportunity: { id: opportunityIds[tenant].newer, source: 'upwork' },
          scores: { skills: 80, projectType: 100, budget: null, experienceEvidence: 80 },
          fit: { overallScore: 85, recommendation: 'strong_match' },
          evaluationVersion: 'v1',
        });
        expect(evaluation.relevantEvidence.map(({ evidenceId }) => evidenceId).sort()).toEqual(
          [knowledge[tenant].evidenceId, extraEvidenceIds[tenant]].sort(),
        );
        expect(
          evaluation.relevantEvidence.every(({ projectId }) => projectId === identity.projectId),
        ).toBe(true);
        expect(evaluation.opportunity).not.toHaveProperty('tenantId');
        expect(evaluation.opportunity).not.toHaveProperty('externalId');
        requestIds.push(evaluation.meta.requestId);
        const repeated = toolSchemas.evaluate_opportunity.output.parse(
          (await client.callTool({ name: 'evaluate_opportunity', arguments: evaluationArguments }))
            .structuredContent,
        );
        expect({ ...repeated, meta: evaluation.meta }).toEqual(evaluation);
        expect(repeated.meta.requestId).not.toBe(evaluation.meta.requestId);
        requestIds.push(repeated.meta.requestId);
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
        const otherKey = tenant === 'a' ? 'b' : 'a';
        for (const opportunityId of [opportunityIds[otherKey].newer, randomUUID()]) {
          const error = safeError(
            await client.callTool({ name: 'evaluate_opportunity', arguments: { opportunityId } }),
          );
          expect(error.code).toBe('NOT_FOUND');
          expect(error.message).toBe('The requested resource was not found.');
        }
        expect(
          (
            await client.callTool({
              name: 'evaluate_opportunity',
              arguments: { opportunityId: 'invalid' },
            })
          ).isError,
        ).toBe(true);
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
      expect(new Set(requestIds).size).toBe(12);
      const records = logs(stderr);
      const invocations = records.filter((record) => record.event === 'mcp.invocation');
      expect(invocations).toHaveLength(16); // SDK-rejected input never enters the application wrapper.
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
      const evaluations = invocations.filter(
        (record) => record.toolName === 'evaluate_opportunity',
      );
      expect(evaluations.map((record) => record.resultStatus)).toEqual([
        'success',
        'success',
        'error',
        'error',
      ]);
      expect(
        evaluations
          .filter((record) => record.resultStatus === 'error')
          .every((record) => record.errorCategory === 'NOT_FOUND'),
      ).toBe(true);
    },
  );

  it.each([
    'administrator',
    'missing_grant',
    'schema_drift',
    'unavailable',
    'wrong_credentials',
    'insecure_remote',
  ] as const)(
    'rejects %s database configuration before MCP application execution',
    async (failure) => {
      const role = new URL(database.runtimeUrl).username;
      const url = new URL(
        failure === 'administrator' ? parseTestDatabaseUrl(process.env) : database.runtimeUrl,
      );
      if (failure === 'administrator') url.pathname = new URL(database.runtimeUrl).pathname;
      if (failure === 'unavailable') url.port = '1';
      if (failure === 'wrong_credentials') url.password = `private-incorrect-${randomUUID()}`;
      if (failure === 'insecure_remote') url.hostname = 'db.invalid';
      if (failure === 'missing_grant')
        await database.admin.pool.query(`REVOKE INSERT ON audit_logs FROM "${role}"`);
      if (failure === 'schema_drift')
        await database.admin.pool.query('ALTER TABLE projects ALTER COLUMN name DROP NOT NULL');
      const server = rawServer({ ...environment(tenants.a), DATABASE_URL: url.href });
      try {
        // Queue work before readiness; the SDK factory must not admit it.
        const response = server
          .request('tools/call', { name: 'get_profile', arguments: {} })
          .catch(() => undefined);
        expect(await server.waitForExit()).toBe(1);
        await response;
        const records = logs(server.stderr);
        expect(records.some((record) => record.event === 'mcp.ready')).toBe(false);
        expect(records.some((record) => record.event === 'mcp.invocation')).toBe(false);
        expect(records.some((record) => record.event === 'mcp.startup_failed')).toBe(true);
        if (failure === 'wrong_credentials' || failure === 'unavailable') {
          expect(records).toContainEqual(
            expect.objectContaining({ event: 'mcp.startup_failed', category: 'CONNECTION' }),
          );
        }
        expect(server.failures).toEqual([]);
        expect(server.stderr).not.toContain(url.password);
        expect(server.stderr).not.toContain(url.href);
        expect(server.stderr).not.toContain('stack');
      } finally {
        await server.close();
        if (failure === 'missing_grant')
          await database.admin.pool.query(`GRANT INSERT ON audit_logs TO "${role}"`);
        if (failure === 'schema_drift')
          await database.admin.pool.query('ALTER TABLE projects ALTER COLUMN name SET NOT NULL');
      }
    },
  );

  it('returns safe NOT_FOUND when the tenant developer profile is missing', async () => {
    const identity = tenants.a;
    const deleted = await database.admin.pool.query(
      'DELETE FROM developer_profiles WHERE tenant_id=$1 RETURNING id',
      [identity.tenantId],
    );
    expect(deleted.rowCount).toBe(1);
    // Tenant B retains its profile; evaluation must never fall back to it.
    const client = new Client({ name: 'evaluation-missing-profile', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: tmpdir(),
      env: environment(identity),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let requestId: string | undefined;
    try {
      await client.connect(transport);
      const error = safeError(
        await client.callTool({
          name: 'evaluate_opportunity',
          arguments: { opportunityId: opportunityIds.a.newer },
        }),
      );
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('The requested resource was not found.');
      requestId = error.requestId;
    } finally {
      await client.close();
    }
    const invocations = logs(stderr).filter((record) => record.event === 'mcp.invocation');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      requestId,
      toolName: 'evaluate_opportunity',
      actorUserId: identity.userId,
      tenantId: identity.tenantId,
      resultStatus: 'error',
      errorCategory: 'NOT_FOUND',
    });
    expect(stderr).not.toContain(secret);
    expect(stderr).not.toContain(database.runtimeUrl);
  });

  it.each(['repository-root', 'absolute-path'] as const)(
    'keeps the documented %s launcher protocol-only with explicit configuration',
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'beloveddev compiled launch '));
      const envPath = join(directory, '.env');
      const appsLink = join(directory, 'apps');
      let server: ReturnType<typeof rawServer> | undefined;
      await withTestResourceCleanup(async () => {
        writeFileSync(
          envPath,
          [
            'NODE_ENV=test',
            'LOG_LEVEL=info',
            `DATABASE_URL=${database.runtimeUrl}`,
            'MCP_AUTH_MODE=local',
            `MCP_CURSOR_SECRET=${secret}`,
            `MCP_LOCAL_TENANT_ID=${tenants.a.tenantId}`,
            `MCP_LOCAL_USER_ID=${tenants.a.userId}`,
          ].join('\n'),
          { mode: 0o600 },
        );
        // Exercise the literal root command without reading or changing the operator's .env.
        symlinkSync(join(workspace, 'apps'), appsLink, 'junction');
        if (mode === 'repository-root') {
          const readme = readFileSync(join(workspace, 'README.md'), 'utf8');
          const commandLine = /<!-- mcp-client-command -->\s*```sh\r?\n([^\r\n]+)\r?\n```/u.exec(
            readme,
          )?.[1];
          const [command, ...args] = (commandLine ?? '').split(' ');
          expect(command).toBe('node');
          expect(args).toEqual(['--env-file=.env', 'apps/mcp-server/dist/main.js']);
          if (command === undefined) throw new Error('Missing documented launcher');
          server = rawServer(getDefaultEnvironment(), { command, args, cwd: directory });
        } else {
          server = rawServer(getDefaultEnvironment(), {
            command: process.execPath,
            args: [`--env-file=${envPath}`, entrypoint],
            cwd: tmpdir(),
          });
        }
        const initialized = await server.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'documented-launcher', version: '1.0.0' },
        });
        expect(initialized.error).toBeUndefined();
        server.notify('notifications/initialized');
        const listed = await server.request('tools/list');
        expect(listed.error).toBeUndefined();
        const { tools } = z
          .object({ tools: z.array(z.object({ name: z.string() })) })
          .parse(listed.result);
        expect(tools.map((tool) => tool.name)).toEqual([
          'get_profile',
          'list_projects',
          'get_project',
          'search_project_evidence',
          'get_blockers',
          'list_opportunities',
          'evaluate_opportunity',
          'create_project_note',
        ]);
        const profile = await server.request('tools/call', { name: 'get_profile', arguments: {} });
        expect(profile.error).toBeUndefined();
        const result = z
          .object({
            content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
            structuredContent: toolSchemas.get_profile.output,
          })
          .parse(profile.result);
        expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
        const spoof = await server.request('tools/call', {
          name: 'get_profile',
          arguments: { tenantId: tenants.b.tenantId, userId: tenants.b.userId },
        });
        expect(spoof.error).toBeUndefined();
        expect(spoof.result).toMatchObject({ isError: true });
        expect(spoof.result).not.toHaveProperty('structuredContent');
      }, [
        {
          stage: 'launcher_process',
          run: async () => {
            if (server !== undefined) expect(await server.close()).toBe(0);
          },
        },
        // Unlink only the owned junction, never recurse into the real repository.
        {
          stage: 'launcher_junction',
          run: () => {
            if (existsSync(appsLink)) unlinkSync(appsLink);
          },
        },
        {
          stage: 'launcher_environment',
          run: () => {
            if (existsSync(envPath)) unlinkSync(envPath);
          },
        },
        {
          stage: 'launcher_directory',
          run: () => {
            rmdirSync(directory);
          },
        },
      ]);
      if (server === undefined) throw new Error('Launcher did not start');
      expect(server.failures).toEqual([]);
      expect(server.output).toHaveLength(4);
      const records = logs(server.stderr);
      expect(records.filter((record) => record.event === 'mcp.ready')).toHaveLength(1);
      expect(records.filter((record) => record.event === 'mcp.stopped')).toHaveLength(1);
      expect(records.filter((record) => record.event === 'mcp.invocation')).toEqual([
        expect.objectContaining({
          toolName: 'get_profile',
          actorUserId: tenants.a.userId,
          tenantId: tenants.a.tenantId,
          resultStatus: 'success',
        }),
      ]);
      expect(server.output.join('')).not.toContain(secret);
      expect(server.output.join('')).not.toContain(database.runtimeUrl);
      expect(server.stderr).not.toContain(secret);
      expect(server.stderr).not.toContain(database.runtimeUrl);
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
        'list_opportunities',
        'evaluate_opportunity',
      ] as const) {
        const response = await server.request('tools/call', {
          name,
          arguments:
            name === 'get_project'
              ? { projectId: tenants.a.projectId }
              : name === 'evaluate_opportunity'
                ? { opportunityId: opportunityIds.a.newer }
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
    expect(server.output).toHaveLength(12);
    const records = logs(server.stderr);
    expect(records.filter((record) => record.event === 'mcp.invocation')).toHaveLength(7);
    expect(records.filter((record) => record.event === 'mcp.stopped')).toHaveLength(1);
    expect(server.output.join('')).not.toContain(secret);
    expect(server.stderr).not.toContain(secret);
    expect(server.stderr).not.toContain(database.runtimeUrl);
  });

  it('starts without a local principal and returns a safe unauthenticated application error', async () => {
    const client = new Client({ name: 'unconfigured-principal', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: tmpdir(),
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
      expect(
        safeError(
          await client.callTool({
            name: 'evaluate_opportunity',
            arguments: { opportunityId: opportunityIds.a.newer },
          }),
        ).code,
      ).toBe('UNAUTHENTICATED');
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

  it('denies viewer evaluation and rechecks a promotion to member on the same stdio session', async () => {
    const identity = tenants.b;
    const client = new Client({ name: 'evaluation-role-check', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: tmpdir(),
      env: environment(identity),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const argumentsForEvaluation = { opportunityId: opportunityIds.b.newer };
      const denied = safeError(
        await client.callTool({ name: 'evaluate_opportunity', arguments: argumentsForEvaluation }),
      );
      expect(denied.code).toBe('FORBIDDEN');
      // Listing remains available to viewers.
      expect(
        (await client.callTool({ name: 'list_opportunities', arguments: {} })).isError,
      ).not.toBe(true);
      await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
        identity.membershipId,
      ]);
      const allowed = toolSchemas.evaluate_opportunity.output.parse(
        (await client.callTool({ name: 'evaluate_opportunity', arguments: argumentsForEvaluation }))
          .structuredContent,
      );
      expect(allowed.evaluationVersion).toBe('v1');
      expect(allowed.opportunity.id).toBe(opportunityIds.b.newer);
      await client.close();
      const invocations = logs(stderr).filter(
        (record) => record.toolName === 'evaluate_opportunity',
      );
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toMatchObject({
        requestId: denied.requestId,
        resultStatus: 'error',
        errorCategory: 'FORBIDDEN',
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
      });
      expect(invocations[1]).toMatchObject({
        requestId: allowed.meta.requestId,
        resultStatus: 'success',
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
      });
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain(database.runtimeUrl);
    } finally {
      await client.close();
    }
  });
});

describe('compiled project-note MCP mutation with PostgreSQL', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let role: string;
  type Session = { client: Client; readonly stderr: string; readonly errors: Error[] };
  let sessions: Session[];

  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    role = new URL(database.runtimeUrl).username;
    if (!/^beloveddev_test_[0-9a-f]{32}_runtime$/.test(role))
      throw new Error('Unexpected test role');
    await database.admin.pool.query(`REVOKE INSERT ON projects FROM "${role}"`);
    const privileges = await database.runtime.pool.query<{
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee=current_user AND table_schema='public' AND privilege_type<>'SELECT'
       ORDER BY table_name, privilege_type`,
    );
    expect(privileges.rows).toEqual([
      { table_name: 'audit_logs', privilege_type: 'INSERT' },
      { table_name: 'project_notes', privilege_type: 'INSERT' },
    ]);
    const roleSafety = await database.runtime.pool.query<{ restricted: boolean }>(
      `SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls
        OR has_schema_privilege(current_user, 'public', 'CREATE')) AS restricted
       FROM pg_roles WHERE rolname=current_user`,
    );
    expect(roleSafety.rows).toEqual([{ restricted: true }]);
  });
  beforeEach(async () => {
    sessions = [];
    tenants = await seedTwoTenants(database.admin.db);
  });
  afterEach(async () => {
    await withTestResourceCleanup(async () => {
      await cleanupTestResources(
        sessions.map(({ client }) => ({ stage: 'sdk_client', run: () => client.close() })),
      );
      for (const session of sessions) {
        expect(session.errors).toEqual([]);
        expect(session.stderr).not.toContain('MCP_STDIO_SENSITIVE');
        expect(session.stderr).not.toContain('stdio-note-key');
        expect(session.stderr).not.toContain(secret);
        expect(session.stderr).not.toContain(database.runtimeUrl);
      }
    }, [
      { stage: 'raw_stdio_processes', run: closeRawServers },
      {
        stage: 'tenant_rows',
        run: async () => {
          if (tenants) await removeTenantFixtures(database.admin.db, tenants);
        },
      },
    ]);
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
  async function connect(identity?: TenantFixtures['a']) {
    const client = new Client({ name: 'note-stdio-tests', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      cwd: tmpdir(),
      env: environment(identity),
      stderr: 'pipe',
    });
    let stderr = '';
    const errors: Error[] = [];
    client.onerror = (error) => {
      errors.push(error);
    };
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const session: Session = {
      client,
      errors,
      get stderr() {
        return stderr;
      },
    };
    sessions.push(session);
    await client.connect(transport);
    return session;
  }
  function command(projectId: string = tenants.a.projectId) {
    return {
      projectId,
      category: 'decision' as const,
      content: '  MCP_STDIO_SENSITIVE client note 🚀\n  code  ',
      idempotencyKey: 'stdio-note-key-001',
    };
  }
  function create(session: Session, args: Record<string, unknown> = command()) {
    return session.client.callTool(
      { name: 'create_project_note', arguments: args },
      { timeout: 12_000 },
    );
  }
  function success(result: CallToolResult) {
    expect(result.isError).not.toBe(true);
    const output = toolSchemas.create_project_note.output.parse(result.structuredContent);
    const content = result.content[0];
    if (content?.type !== 'text') throw new Error('Expected note JSON content');
    expect(JSON.parse(content.text)).toEqual(output);
    return output;
  }
  async function startRaw(applicationName: string) {
    const url = new URL(database.runtimeUrl);
    url.searchParams.set('application_name', applicationName);
    const server = rawServer({ ...environment(tenants.a), DATABASE_URL: url.href });
    try {
      expect(
        (
          await server.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'lifecycle-tests', version: '1.0.0' },
          })
        ).error,
      ).toBeUndefined();
      server.notify('notifications/initialized');
      return server;
    } catch (error: unknown) {
      return withTestResourceCleanup(() => {
        throw error;
      }, [
        {
          stage: 'raw_stdio_process',
          run: async () => {
            await server.close();
          },
        },
      ]);
    }
  }
  async function backend(applicationName: string, state: 'idle' | 'blocked') {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await database.admin.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
         AND application_name=$1 AND (($2='idle' AND state='idle')
           OR ($2='blocked' AND wait_event_type='Lock'))`,
        [applicationName, state],
      );
      const pid = result.rows[0]?.pid;
      if (pid !== undefined) return pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Expected isolated MCP database session state');
  }
  function expectSafeLifecycle(server: ReturnType<typeof rawServer>) {
    expect(server.failures).toEqual([]);
    for (const sensitive of [
      secret,
      database.runtimeUrl,
      'MCP_STDIO_SENSITIVE',
      'stdio-note-key',
    ]) {
      expect(server.stderr).not.toContain(sensitive);
    }
    expect(server.stderr).not.toContain('terminating connection');
    expect(logs(server.stderr).filter(({ event }) => event === 'mcp.stopping')).toHaveLength(1);
    expect(logs(server.stderr).filter(({ event }) => event === 'mcp.stopped')).toHaveLength(1);
  }
  async function records() {
    return {
      notes: await database.admin.db.select().from(projectNotes),
      audits: await database.admin.db.select().from(auditLogs),
    };
  }

  it('enforces the process capacity on the direct stdio launcher without queuing or duplicating writes', async () => {
    const applicationName = `m8e-capacity-${randomUUID()}`;
    const server = await startRaw(applicationName);
    const blocker = await database.admin.pool.connect();
    let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
    const outcomes: PromiseSettledResult<Response>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE audit_logs IN SHARE MODE');
      pending = Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          server.request('tools/call', {
            name: 'create_project_note',
            arguments: { ...command(), idempotencyKey: `stdio-note-key-capacity-${index}` },
          }),
        ),
      );
      await vi.waitFor(
        async () => {
          const waiting = await database.admin.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
            [applicationName],
          );
          expect(waiting.rows[0]?.count).toBe(8);
        },
        { timeout: 5000 },
      );
      const response = await server.request('tools/call', { name: 'get_profile', arguments: {} });
      const denied = z
        .object({
          isError: z.literal(true),
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
        })
        .parse(response.result);
      expect(response.result).not.toHaveProperty('structuredContent');
      expect(safeError(denied).code).toBe('RATE_LIMITED');
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release(true);
      }
      try {
        if (pending !== undefined) outcomes.push(...(await pending));
      } finally {
        await server.close();
      }
    }
    expect(outcomes).toHaveLength(8);
    for (const entry of outcomes) {
      if (entry.status !== 'fulfilled') throw entry.reason;
      expect(entry.value.error).toBeUndefined();
      const result = z
        .object({ structuredContent: toolSchemas.create_project_note.output })
        .parse(entry.value.result);
      expect(result.structuredContent.created).toBe(true);
    }
    const saved = await records();
    expect(saved.notes).toHaveLength(8);
    expect(saved.audits).toHaveLength(8);
    const invocations = logs(server.stderr).filter((record) => record.event === 'mcp.invocation');
    expect(invocations).toHaveLength(9);
    expect(invocations.filter((record) => record.errorCategory === 'RATE_LIMITED')).toHaveLength(1);
    expectSafeLifecycle(server);
  });

  it('keeps oversized-success rejection safe and protocol-only through the direct stdio launcher', async () => {
    await database.admin.pool.query('UPDATE developer_profiles SET summary=$1 WHERE tenant_id=$2', [
      '🚀'.repeat(150_000),
      tenants.a.tenantId,
    ]);
    const server = await startRaw(`m8e-size-${randomUUID()}`);
    try {
      const response = await server.request('tools/call', { name: 'get_profile', arguments: {} });
      const denied = z
        .object({
          isError: z.literal(true),
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
        })
        .parse(response.result);
      expect(response.result).not.toHaveProperty('structuredContent');
      expect(safeError(denied).code).toBe('INTERNAL_ERROR');
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1000);
      expect(server.stderr).not.toContain('🚀');
    } finally {
      expect(await server.close()).toBe(0);
    }
    expectSafeLifecycle(server);
  });

  it.each(['a', 'b'] as const)(
    'creates and retries as tenant %s with trusted identity and a single durable audit',
    async (tenant) => {
      const identity = tenants[tenant];
      if (tenant === 'b')
        await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
          identity.membershipId,
        ]);
      const session = await connect(identity);
      expect((await session.client.listTools()).tools).toHaveLength(8);
      const args = command(identity.projectId.toUpperCase());
      const first = success(await create(session, args));
      const retry = success(await create(session, args));
      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.note).toEqual(first.note);
      expect(first.note.content).toBe(args.content);
      expect(first.note.projectId).toBe(identity.projectId);
      expect(retry.meta.requestId).not.toBe(first.meta.requestId);
      const saved = await records();
      expect(saved.notes).toHaveLength(1);
      expect(saved.audits).toHaveLength(1);
      expect(saved.notes[0]).toMatchObject({
        id: first.note.id,
        tenantId: identity.tenantId,
        authorUserId: identity.userId,
        idempotencyKey: args.idempotencyKey,
      });
      expect(saved.audits[0]).toMatchObject({
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
        action: 'project_note.created',
        resourceType: 'project_note',
        resourceId: first.note.id,
        requestId: first.meta.requestId,
        metadata: { projectId: identity.projectId, category: args.category },
      });
      const project = toolSchemas.get_project.output.parse(
        (
          await session.client.callTool({
            name: 'get_project',
            arguments: { projectId: identity.projectId },
          })
        ).structuredContent,
      );
      expect(project.recentNotes).toEqual([
        {
          id: first.note.id,
          category: first.note.category,
          content: first.note.content,
          createdAt: first.note.createdAt,
        },
      ]);
      await session.client.close();
      const invocations = logs(session.stderr).filter(
        ({ toolName }) => toolName === 'create_project_note',
      );
      expect(invocations.map(({ requestId }) => requestId)).toEqual([
        first.meta.requestId,
        retry.meta.requestId,
      ]);
      expect(
        invocations.every(
          (record) =>
            record.actorUserId === identity.userId &&
            record.tenantId === identity.tenantId &&
            record.resultStatus === 'success' &&
            record.durationMs !== undefined &&
            record.durationMs >= 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(saved.audits)).not.toContain('MCP_STDIO_SENSITIVE');
      expect(JSON.stringify(saved.audits)).not.toContain(args.idempotencyKey);
    },
  );

  it('keeps tenant/key scopes isolated and maps missing projects and conflicting reuse safely', async () => {
    await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
      tenants.b.membershipId,
    ]);
    const owner = await connect(tenants.a);
    const member = await connect(tenants.b);
    const original = success(await create(owner));
    for (const projectId of [tenants.a.projectId, randomUUID()]) {
      const error = safeError(await create(member, command(projectId)));
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('The requested resource was not found.');
    }
    const other = success(await create(member, command(tenants.b.projectId)));
    expect(other.created).toBe(true);
    expect(other.note.id).not.toBe(original.note.id);
    const secondProjectId = randomUUID();
    await database.admin.db.insert(projects).values({
      ...projectInput(tenants.a.tenantId, tenants.a.clientId),
      id: secondProjectId,
      slug: 'second-owned-project',
    });
    for (const change of [
      { content: 'different content' },
      { category: 'technical' },
      { projectId: secondProjectId },
    ]) {
      expect(safeError(await create(owner, { ...command(), ...change })).code).toBe('CONFLICT');
    }
    const saved = await records();
    expect(saved.notes).toHaveLength(2);
    expect(saved.audits).toHaveLength(2);
    await Promise.all([owner.client.close(), member.client.close()]);
    const failures = [...logs(owner.stderr), ...logs(member.stderr)].filter(
      ({ resultStatus }) => resultStatus === 'error',
    );
    expect(failures.map(({ errorCategory }) => errorCategory).sort()).toEqual([
      'CONFLICT',
      'CONFLICT',
      'CONFLICT',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
  });

  it.each(['missing', 'viewer'] as const)(
    'denies %s context before protected repository work',
    async (kind) => {
      const session = await connect(kind === 'viewer' ? tenants.b : undefined);
      // Readiness requires the complete grants. Revoke after it succeeds to
      // prove authorization still short-circuits protected work at invocation.
      await database.admin.pool.query(`REVOKE SELECT ON projects, project_notes FROM "${role}"`);
      try {
        const payload = safeError(await create(session, command(tenants.b.projectId)));
        const code = kind === 'viewer' ? 'FORBIDDEN' : 'UNAUTHENTICATED';
        expect(payload.code).toBe(code);
        expect(await records()).toEqual({ notes: [], audits: [] });
        await session.client.close();
        expect(logs(session.stderr)).toContainEqual(
          expect.objectContaining({
            toolName: 'create_project_note',
            requestId: payload.requestId,
            resultStatus: 'error',
            errorCategory: code,
          }),
        );
      } finally {
        await database.admin.pool.query(`GRANT SELECT ON projects, project_notes TO "${role}"`);
      }
    },
  );

  it('rechecks role changes and revocation on retries instead of bypassing authorization', async () => {
    const session = await connect(tenants.b);
    const args = command(tenants.b.projectId);
    expect(safeError(await create(session, args)).code).toBe('FORBIDDEN');
    await database.admin.pool.query("UPDATE tenant_memberships SET role='member' WHERE id=$1", [
      tenants.b.membershipId,
    ]);
    const first = success(await create(session, args));
    await database.admin.pool.query("UPDATE tenant_memberships SET role='viewer' WHERE id=$1", [
      tenants.b.membershipId,
    ]);
    expect(safeError(await create(session, args)).code).toBe('FORBIDDEN');
    await database.admin.pool.query("UPDATE tenant_memberships SET status='inactive' WHERE id=$1", [
      tenants.b.membershipId,
    ]);
    expect(safeError(await create(session, args)).code).toBe('UNAUTHENTICATED');
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]?.requestId).toBe(first.meta.requestId);
  });

  it('rejects invalid SDK input without invocation logs or writes', async () => {
    const session = await connect(tenants.a);
    for (const args of [
      { ...command(), projectId: 'invalid' },
      { ...command(), tenantId: tenants.b.tenantId },
      { ...command(), authorUserId: tenants.b.userId },
      { ...command(), content: ' \t\n' },
      { ...command(), content: 'x'.repeat(10_001) },
    ]) {
      const result = await create(session, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
    expect(await records()).toEqual({ notes: [], audits: [] });
    await session.client.close();
    expect(logs(session.stderr).filter(({ event }) => event === 'mcp.invocation')).toEqual([]);
  });

  it('returns safe INTERNAL_ERROR and rolls back if durable audit insertion fails', async () => {
    const session = await connect(tenants.a);
    await database.admin.pool.query(`REVOKE INSERT ON audit_logs FROM "${role}"`);
    let requestId: string | undefined;
    try {
      const error = safeError(await create(session));
      expect(error.code).toBe('INTERNAL_ERROR');
      requestId = error.requestId;
      expect(await records()).toEqual({ notes: [], audits: [] });
    } finally {
      await database.admin.pool.query(`GRANT INSERT ON audit_logs TO "${role}"`);
    }
    const retried = success(await create(session));
    expect(retried.created).toBe(true);
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]?.requestId).toBe(retried.meta.requestId);
    await session.client.close();
    expect(logs(session.stderr)).toContainEqual(
      expect.objectContaining({
        requestId,
        toolName: 'create_project_note',
        errorCategory: 'INTERNAL_ERROR',
        resultStatus: 'error',
      }),
    );
    expect(session.stderr).not.toContain('permission denied');
  });

  it.each(['identical', 'conflicting'] as const)(
    'handles simultaneous %s requests through independent stdio sessions',
    async (kind) => {
      const first = await connect(tenants.a);
      const second = await connect(tenants.a);
      const blocker = await database.admin.pool.connect();
      let pending: Promise<PromiseSettledResult<CallToolResult>[]> | undefined;
      let waiters = 0;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE project_notes IN SHARE MODE');
        pending = Promise.allSettled([
          create(first),
          create(second, {
            ...command(),
            ...(kind === 'conflicting' ? { content: 'MCP_STDIO_SENSITIVE different content' } : {}),
          }),
        ]);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && waiters < 2) {
          const locks = await database.admin.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
            [role],
          );
          waiters = locks.rows[0]?.count ?? 0;
          if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        try {
          await blocker.query('ROLLBACK');
        } finally {
          blocker.release(true);
          await pending;
        }
      }
      expect(waiters).toBe(2);
      if (pending === undefined) throw new Error('Concurrent requests were not started');
      const settled = await pending;
      expect(settled.every(({ status }) => status === 'fulfilled')).toBe(true);
      const results = settled.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value] : [],
      );
      const successes = results.filter((result) => result.isError !== true).map(success);
      expect(successes.filter(({ created }) => created)).toHaveLength(1);
      if (kind === 'identical') {
        expect(successes).toHaveLength(2);
        expect(successes.filter(({ created }) => !created)).toHaveLength(1);
        expect(successes[0]?.note).toEqual(successes[1]?.note);
        expect(successes[0]?.meta.requestId).not.toBe(successes[1]?.meta.requestId);
      } else {
        expect(successes).toHaveLength(1);
        const failure = results.find(({ isError }) => isError === true);
        if (failure === undefined) throw new Error('Expected conflicting result');
        expect(safeError(failure).code).toBe('CONFLICT');
      }
      const saved = await records();
      expect(saved.notes).toHaveLength(1);
      expect(saved.audits).toHaveLength(1);
      expect(saved.audits[0]?.requestId).toBe(
        successes.find(({ created }) => created)?.meta.requestId,
      );
    },
  );

  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'cleans up the real stdio process and database session on repeated %s',
    async (signal) => {
      const applicationName = `lifecycle-${randomUUID()}`;
      const server = await startRaw(applicationName);
      try {
        await server.request('tools/call', { name: 'get_profile', arguments: {} });
        await backend(applicationName, 'idle');
        server.signal(signal);
        server.signal(signal);
        expect(await server.waitForExit()).toBe(0);
        await expect
          .poll(
            async () => {
              const connections = await database.admin.pool.query<{ count: number }>(
                'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
                [applicationName],
              );
              return connections.rows[0]?.count;
            },
            { timeout: 5_000 },
          )
          .toBe(0);
        expectSafeLifecycle(server);
        expect(logs(server.stderr)).toContainEqual(
          expect.objectContaining({
            event: 'mcp.stopping',
            reason: signal,
          }),
        );
      } finally {
        await server.close();
      }
    },
  );

  it('enforces one hard deadline across a stalled invocation and an unreleased PostgreSQL client', async () => {
    const applicationName = `lifecycle-${randomUUID()}`;
    const url = new URL(database.runtimeUrl);
    url.searchParams.set('application_name', applicationName);
    const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
    const source = `
      const { StdioLifecycle } = await import(${JSON.stringify(moduleUrl('../../../apps/mcp-server/dist/lifecycle.js'))});
      const { openDatabase } = await import(${JSON.stringify(moduleUrl('../../../packages/database/dist/client.js'))});
      const { createLogger } = await import(${JSON.stringify(moduleUrl('../../../packages/infrastructure/dist/logger.js'))});
      const { StdioServerTransport } = await import(${JSON.stringify(moduleUrl('../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))});
      const logger = createLogger('info');
      let lifecycle;
      const database = openDatabase(process.env.DATABASE_URL, {
        onIdleError: () => { void lifecycle?.stop('database_error'); },
        onClientError: () => { void lifecycle?.stop('database_error'); },
      });
      const transport = new StdioServerTransport();
      lifecycle = new StdioLifecycle({
        logger,
        pauseInput: () => { process.stdin.pause(); },
        closeTransport: async () => {
          await transport.close();
          logger.info({ event: 'test.transport_closed' }, 'Test wire cleanup attempted');
        },
        closeDatabase: async () => {
          logger.info({ event: 'test.database_cleanup_started' }, 'Test pool cleanup attempted');
          await database.close();
        },
        finishOutput: async () => {
          process.stdin.destroy();
          await new Promise((resolve) => process.stdout.end(resolve));
        },
        terminate: (code) => process.exit(code),
      });
      // Hold a real checked-out client: pool.end() must wait until process termination.
      await database.pool.connect();
      lifecycle.enter();
      transport.onclose = () => {
        void lifecycle.stop('transport_closed');
        setTimeout(() => { void lifecycle.stop('database_error'); }, 11_000);
      };
      await transport.start();
      // This handle ensures a pending shutdown cannot pass by merely exiting naturally.
      setInterval(() => {}, 1000);
    `;
    const server = rawServer(
      { ...environment(tenants.a), DATABASE_URL: url.href },
      {
        args: ['--input-type=module', '--eval', source],
      },
    );
    try {
      await backend(applicationName, 'idle');
      server.endInput();
      expect(await server.waitForExit()).toBe(1);
      expect(server.failures).toEqual([]);
      expect(server.output).toEqual([]);
      const events = logs(server.stderr);
      for (const event of [
        'mcp.stopping',
        'mcp.drain_timeout',
        'test.transport_closed',
        'test.database_cleanup_started',
        'mcp.shutdown_timeout',
      ]) {
        expect(events.filter((record) => record.event === event)).toHaveLength(1);
      }
      expect(events.some((record) => record.event === 'mcp.stopped')).toBe(false);
      expect(server.stderr).not.toContain(database.runtimeUrl);
      expect(server.stderr).not.toContain(secret);
      await expect
        .poll(
          async () => {
            const connections = await database.admin.pool.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
              [applicationName],
            );
            return connections.rows[0]?.count;
          },
          { timeout: 5_000 },
        )
        .toBe(0);
      expect(await records()).toEqual({ notes: [], audits: [] });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('shuts down with a safe nonzero exit when PostgreSQL kills an idle pool connection', async () => {
    const applicationName = `lifecycle-${randomUUID()}`;
    const server = await startRaw(applicationName);
    try {
      await server.request('tools/call', { name: 'get_profile', arguments: {} });
      const pid = await backend(applicationName, 'idle');
      await database.admin.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await server.waitForExit()).toBe(1);
      expectSafeLifecycle(server);
      const events = logs(server.stderr);
      expect(events.filter(({ event }) => event === 'database.idle_error')).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'mcp.stopping',
          reason: 'database_error',
        }),
      );
      expect(await records()).toEqual({ notes: [], audits: [] });
    } finally {
      await server.close();
    }
  });

  it('rolls back a disconnected active write and only retries on a new explicit tool call', async () => {
    const applicationName = `lifecycle-${randomUUID()}`;
    const server = await startRaw(applicationName);
    const blocker = await database.admin.pool.connect();
    try {
      let response: PromiseSettledResult<Response> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_logs IN SHARE MODE');
        const pending = server.request('tools/call', {
          name: 'create_project_note',
          arguments: command(),
        });
        // Attach rejection handling immediately, including failures while awaiting the lock state.
        const settled = Promise.allSettled([pending]);
        const pid = await backend(applicationName, 'blocked');
        await database.admin.pool.query('SELECT pg_terminate_backend($1)', [pid]);
        [response] = await settled;
      } finally {
        await blocker.query('ROLLBACK');
      }
      // Active-client socket loss is fatal. Shutdown can beat error-response
      // delivery; neither outcome permits an automatic mutation retry.
      expect(response).toBeDefined();
      if (response?.status === 'fulfilled') {
        expect(response.value.error).toBeUndefined();
        const failure = z
          .object({
            isError: z.literal(true),
            content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
          })
          .parse(response.value.result);
        expect(response.value.result).not.toHaveProperty('structuredContent');
        const error = safeErrorSchema.parse(JSON.parse(failure.content[0]?.text ?? '')).error;
        expect(error.code).toBe('INTERNAL_ERROR');
      }
      expect(await records()).toEqual({ notes: [], audits: [] });
      const exitCode = await server.close();
      const events = logs(server.stderr);
      expect(exitCode).toBe(1);
      expect(events.some(({ event }) => event === 'database.client_error')).toBe(true);
      expect(events.filter(({ event }) => event === 'mcp.invocation')).toEqual([
        expect.objectContaining({ resultStatus: 'error', errorCategory: 'INTERNAL_ERROR' }),
      ]);
      const retried = success(await create(await connect(tenants.a)));
      expect(retried.created).toBe(true);
      const saved = await records();
      expect(saved.notes).toHaveLength(1);
      expect(saved.audits).toHaveLength(1);
    } finally {
      blocker.release(true);
      await server.close();
    }
    expectSafeLifecycle(server);
  });

  it('drains an admitted write after EOF, preserves its unseen commit, and recovers by idempotent retry', async () => {
    const applicationName = `lifecycle-${randomUUID()}`;
    const server = await startRaw(applicationName);
    const blocker = await database.admin.pool.connect();
    let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
    try {
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_logs IN SHARE MODE');
        pending = Promise.allSettled([
          server.request('tools/call', {
            name: 'create_project_note',
            arguments: command(),
          }),
        ]);
        await backend(applicationName, 'blocked');
        server.endInput();
        await expect
          .poll(() => server.stderr, { timeout: 5_000 })
          .toContain('"event":"mcp.stopping"');
      } finally {
        await blocker.query('ROLLBACK');
      }
      expect(await server.waitForExit()).toBe(0);
      expect((await pending)?.[0]?.status).toBe('rejected');
      // Only initialize was answered: the commit happened after the SDK closed its wire.
      expect(server.output).toHaveLength(1);
      expectSafeLifecycle(server);
      const invocations = logs(server.stderr).filter(({ event }) => event === 'mcp.invocation');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.resultStatus).toBe('success');
      const beforeRetry = await records();
      expect(beforeRetry.notes).toHaveLength(1);
      expect(beforeRetry.audits).toHaveLength(1);
      expect(beforeRetry.audits[0]?.requestId).toBe(invocations[0]?.requestId);
      const retried = success(await create(await connect(tenants.a)));
      expect(retried.created).toBe(false);
      expect(retried.note.id).toBe(beforeRetry.notes[0]?.id);
      expect(retried.meta.requestId).not.toBe(beforeRetry.audits[0]?.requestId);
      expect(await records()).toEqual(beforeRetry);
    } finally {
      blocker.release(true);
      await server.close();
      await pending;
    }
  });

  it('keeps every stdout line protocol-only during note creation and retry', async () => {
    const server = rawServer(environment(tenants.a));
    try {
      expect(
        (
          await server.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw-note-stdio', version: '1.0.0' },
          })
        ).error,
      ).toBeUndefined();
      server.notify('notifications/initialized');
      const schema = z.object({
        content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
        structuredContent: toolSchemas.create_project_note.output,
      });
      const first = schema.parse(
        (await server.request('tools/call', { name: 'create_project_note', arguments: command() }))
          .result,
      );
      const retry = schema.parse(
        (await server.request('tools/call', { name: 'create_project_note', arguments: command() }))
          .result,
      );
      expect(first.structuredContent.created).toBe(true);
      expect(retry.structuredContent.created).toBe(false);
      expect(retry.structuredContent.note).toEqual(first.structuredContent.note);
      expect(JSON.parse(first.content[0]?.text ?? '')).toEqual(first.structuredContent);
      expect(JSON.parse(retry.content[0]?.text ?? '')).toEqual(retry.structuredContent);
      expect(
        z
          .object({ tools: z.array(z.unknown()).length(8) })
          .parse((await server.request('tools/list')).result).tools,
      ).toHaveLength(8);
    } finally {
      expect(await server.close()).toBe(0);
    }
    expect(server.failures).toEqual([]);
    expect(server.output).toHaveLength(4);
    expect(logs(server.stderr).filter(({ event }) => event === 'mcp.invocation')).toHaveLength(2);
    expect(server.stderr).not.toContain('MCP_STDIO_SENSITIVE');
    expect(server.stderr).not.toContain('stdio-note-key');
    expect(server.stderr).not.toContain(secret);
    expect(server.stderr).not.toContain(database.runtimeUrl);
    const saved = await records();
    expect(saved.notes).toHaveLength(1);
    expect(saved.audits).toHaveLength(1);
  });
});
