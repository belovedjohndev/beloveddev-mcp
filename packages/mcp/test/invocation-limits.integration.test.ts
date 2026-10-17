import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionAuthorization } from '@beloveddev/application/request-context';
import { CreateProjectNote } from '@beloveddev/application/use-cases/create-project-note';
import { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { LocalRequestContextProvider } from '@beloveddev/infrastructure/local-request-context';
import { PostgresMembershipRepository } from '@beloveddev/infrastructure/postgres/membership-repository';
import { PostgresDeveloperProfileRepository } from '@beloveddev/infrastructure/postgres/developer-profile-repository';
import { PostgresProjectNoteCreationRepository } from '@beloveddev/infrastructure/postgres/project-note-creation-repository';
import { assertRuntimeDatabaseReady } from '@beloveddev/database/readiness';
import { createTestDatabase, type TestDatabase } from '@beloveddev/test-support/test-database';
import {
  removeTenantFixtures,
  seedTwoTenants,
  type TenantFixtures,
} from '@beloveddev/test-support/tenant-fixtures';
import { StdioLifecycle } from '../../../apps/mcp-server/src/lifecycle.js';
import { APPLICATION_RESPONSE_DEADLINE_MS, InvocationAdmission } from '../src/invocation-policy.js';
import { createMcpServer, type InvocationLog, type McpUseCases } from '../src/server.js';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function error(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected safe error text');
  return safeErrorSchema.parse(JSON.parse(first.text)).error;
}

describe('invocation limits with real PostgreSQL transactions', () => {
  let database: TestDatabase;
  let tenants: TenantFixtures;
  let logs: InvocationLog[];
  let useCases: McpUseCases;
  let context: LocalRequestContextProvider;
  let sessions: { client: Client; server: ReturnType<typeof createMcpServer> }[];
  beforeAll(async () => {
    database = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
    await assertRuntimeDatabaseReady(database.runtime.pool);
  });
  beforeEach(async () => {
    tenants = await seedTwoTenants(database.admin.db);
    logs = [];
    sessions = [];
    const authorization = new PermissionAuthorization();
    context = new LocalRequestContextProvider(
      { tenantId: tenants.a.tenantId, userId: tenants.a.userId },
      new PostgresMembershipRepository(database.runtime.db),
    );
    // Only the two exercised tools need adapters here. All eight registrations
    // and their full composition are separately covered by the stdio suite.
    const unused = () => Promise.reject(new Error('Unexpected test operation'));
    useCases = {
      getProfile: new GetProfile(
        new PostgresDeveloperProfileRepository(database.runtime.db),
        authorization,
      ),
      createProjectNote: new CreateProjectNote(
        new PostgresProjectNoteCreationRepository(database.runtime.db),
        authorization,
      ),
      getProject: { execute: unused },
      listProjects: { execute: unused },
      getBlockers: { execute: unused },
      searchProjectEvidence: { execute: unused },
      listOpportunities: { execute: unused },
      evaluateOpportunity: { execute: unused },
    };
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const session of sessions) {
      await session.client.close();
      await session.server.close();
    }
    await removeTenantFixtures(database.admin.db, tenants);
  });
  afterAll(async () => {
    await database.close();
  });

  async function connect(admission?: InvocationAdmission) {
    const server = createMcpServer({
      useCases,
      context,
      logger: { info: (record) => logs.push(record) },
      ...(admission === undefined ? {} : { admission }),
    });
    const client = new Client({ name: 'database-invocation-limits', version: '1' });
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    sessions.push({ client, server });
    await server.connect(serverWire);
    await client.connect(clientWire);
    return { client, server };
  }

  it('keeps eight expired writes admitted through shutdown, allows their commits, and recovers an original note without duplicate audit', async () => {
    const closeDatabase = vi.fn(async () => {});
    const closeTransport = vi.fn(async () => {
      await session.server.close();
    });
    const terminate = vi.fn();
    const lifecycleRecords: Record<string, unknown>[] = [];
    const lifecycle = new StdioLifecycle({
      pauseInput: () => {},
      closeDatabase,
      closeTransport,
      finishOutput: async () => {},
      terminate,
      logger: {
        info: (record) => lifecycleRecords.push(record),
        error: (record) => lifecycleRecords.push(record),
      },
    });
    const session = await connect(new InvocationAdmission(lifecycle));
    const resolve = vi.spyOn(context, 'resolve');
    const execute = vi.spyOn(useCases.createProjectNote, 'execute');
    const commands = Array.from({ length: 8 }, (_, index) => ({
      projectId: tenants.a.projectId,
      category: 'decision',
      content: 'private-M8E-note-content',
      idempotencyKey: `m8e-note-key-${index}`,
    }));
    const blocker = await database.admin.pool.connect();
    let running: Promise<PromiseSettledResult<CallToolResult>[]> | undefined;
    let stopped: Promise<void> | undefined;
    const timeoutIds: string[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE audit_logs IN SHARE MODE');
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
        shouldClearNativeTimers: true,
      });
      running = Promise.allSettled(
        commands.map((command) =>
          session.client.callTool({ name: 'create_project_note', arguments: command }),
        ),
      );
      await vi.waitFor(
        async () => {
          const waiters = await database.admin.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'",
            [new URL(database.runtimeUrl).username],
          );
          expect(waiters.rows[0]?.count).toBe(8);
        },
        { timeout: 5000 },
      );
      expect(
        error(await session.client.callTool({ name: 'get_profile', arguments: {} })).code,
      ).toBe('RATE_LIMITED');
      expect(resolve).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_DEADLINE_MS);
      timeoutIds.push(
        ...(await running).map((entry) => {
          if (entry.status !== 'fulfilled') throw entry.reason;
          const failure = error(entry.value);
          expect(failure.code).toBe('INTERNAL_ERROR');
          return failure.requestId;
        }),
      );
      expect(
        error(await session.client.callTool({ name: 'get_profile', arguments: {} })).code,
      ).toBe('RATE_LIMITED');
      expect(resolve).toHaveBeenCalledTimes(8);
      expect(execute).toHaveBeenCalledTimes(8);
      const beforeCommit = await database.admin.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM project_notes',
      );
      expect(beforeCommit.rows[0]?.count).toBe(0);
      vi.useRealTimers();
      stopped = lifecycle.stop('SIGTERM');
      await flush();
      expect(lifecycleRecords).toContainEqual({
        event: 'mcp.stopping',
        reason: 'SIGTERM',
        activeInvocations: 8,
      });
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(closeTransport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release(true);
      }
      await running;
      // Waiting for the real repository promises also proves late rejections are observed.
      await Promise.allSettled(
        execute.mock.results.map((result) =>
          result.type === 'return' ? result.value : Promise.resolve(),
        ),
      );
      await flush();
      if (stopped !== undefined) await stopped;
      else await lifecycle.stop('transport_closed');
    }
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(0);
    const audits = await database.admin.pool.query<{ request_id: string }>(
      'SELECT request_id FROM audit_logs',
    );
    expect(audits.rows).toHaveLength(8);
    expect(new Set(audits.rows.map((row) => row.request_id))).toEqual(new Set(timeoutIds));
    expect(logs).toHaveLength(10); // Eight deadline errors and two immediate capacity errors.
    expect(JSON.stringify(logs)).not.toContain('private-M8E');
    expect(JSON.stringify(logs)).not.toContain('m8e-note-key');
    const recovery = await connect();
    const retried = toolSchemas.create_project_note.output.parse(
      (await recovery.client.callTool({ name: 'create_project_note', arguments: commands[0] }))
        .structuredContent,
    );
    expect(retried.created).toBe(false);
    expect(retried.meta.requestId).not.toBe(timeoutIds[0]);
    const saved = await database.admin.pool.query<{ resource_id: string; request_id: string }>(
      'SELECT resource_id, request_id FROM audit_logs WHERE resource_id=$1',
      [retried.note.id],
    );
    expect(saved.rows).toEqual([{ resource_id: retried.note.id, request_id: timeoutIds[0] }]);
    expect((await database.admin.pool.query('SELECT id FROM audit_logs')).rowCount).toBe(8);
  });

  it('rejects an oversized real profile with a safe envelope and immediately reuses its slot', async () => {
    await database.admin.pool.query('UPDATE developer_profiles SET summary=$1 WHERE tenant_id=$2', [
      '🚀'.repeat(150_000),
      tenants.a.tenantId,
    ]);
    const session = await connect();
    const result = await session.client.callTool({ name: 'get_profile', arguments: {} });
    expect(error(result).code).toBe('INTERNAL_ERROR');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1000);
    expect(JSON.stringify(logs)).not.toContain('🚀');
    await database.admin.pool.query(
      "UPDATE developer_profiles SET summary='Within bounds' WHERE tenant_id=$1",
      [tenants.a.tenantId],
    );
    expect(
      (await session.client.callTool({ name: 'get_profile', arguments: {} })).isError,
    ).not.toBe(true);
  });
});
