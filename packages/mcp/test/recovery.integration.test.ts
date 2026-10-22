import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, cp, link, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createBackup,
  validateBackup,
  withRestoredDatabase,
  parseRecoveryEnvironment,
  RECOVERY_TABLES,
  RecoveryError,
} from '@beloveddev/database/recovery';
import { assertRuntimeDatabaseReady } from '@beloveddev/database/readiness';
import { MIGRATION_LOCK } from '@beloveddev/database/migrate';
import {
  createTestDatabase,
  cleanupTestResources,
  type TestDatabase,
} from '@beloveddev/test-support/test-database';
import { seedTwoTenants, type TenantFixtures } from '@beloveddev/test-support/tenant-fixtures';
import { seedProjectKnowledge } from '@beloveddev/test-support/project-knowledge-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { toolSchemas } from '../src/schemas.js';
import { createTlsPostgres } from '@beloveddev/test-support/tls-database';

const entry = fileURLToPath(new URL('../../../apps/mcp-server/dist/main.js', import.meta.url));

async function recoveryCli(args: string[], environment: Record<string, string>) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DATABASE_')) delete env[key];
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../../scripts/recovery.ts', import.meta.url)), ...args],
    {
      env: { ...env, ...environment },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(stdout).toBe('');
    expect(stderr).not.toMatch(
      /postgres(?:ql)?:\/\/|private-wrong|Preserve tenant boundaries|PGPASSWORD/,
    );
    const logs = stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, logs };
  } finally {
    clearTimeout(watchdog);
  }
}

async function session<T>(
  url: string,
  tenant: TenantFixtures['a'],
  action: (client: Client) => Promise<T>,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    stderr: 'pipe',
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined && /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP)$/.test(name),
        ),
      ) as Record<string, string>),
      NODE_ENV: 'test',
      DATABASE_URL: url,
      MCP_AUTH_MODE: 'local',
      MCP_CURSOR_SECRET: 'recovery-drill-private-signing-key-with-32-bytes',
      MCP_LOCAL_TENANT_ID: tenant.tenantId,
      MCP_LOCAL_USER_ID: tenant.userId,
      LOG_LEVEL: 'silent',
    },
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'recovery-drill', version: '1' });
  try {
    await client.connect(transport);
    return await action(client);
  } finally {
    await client.close();
  }
}

async function waitForUtility(database: TestDatabase) {
  const until = performance.now() + 8_000;
  while (performance.now() < until) {
    const rows = await database.admin.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND application_name='beloveddev-recovery-utility' AND wait_event_type='Lock'`,
    );
    if (rows.rows[0]) return rows.rows[0].pid;
    await pause(20);
  }
  throw new Error('Recovery utility lock barrier expired.');
}

describe('PostgreSQL 18 backup and verified isolated recovery', () => {
  let source: TestDatabase;
  let tenants: TenantFixtures;
  let directory: string;
  let artifact: string;
  let baseline: Record<string, unknown[]>;
  let originalNote: unknown;
  const payload = {
    projectId: '',
    category: 'decision',
    content: 'Preserve tenant boundaries, Unicode 🚀 and exact whitespace.\n',
    idempotencyKey: 'recovery-original-note-key-001',
  };
  const backupConfig = () =>
    parseRecoveryEnvironment(
      { ...process.env, DATABASE_BACKUP_URL: source.migrationUrl },
      'backup',
    );
  const restoreConfig = () =>
    parseRecoveryEnvironment(
      { ...process.env, DATABASE_RESTORE_ADMIN_URL: parseTestDatabaseUrl(process.env) },
      'restore',
    );
  const data = async (database: TestDatabase['admin']) => {
    const result: Record<string, unknown[]> = {};
    for (const table of RECOVERY_TABLES)
      result[table] = (
        await database.pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY id`)
      ).rows;
    return result;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beloveddev-recovery-drill-'));
    artifact = join(directory, 'verified.pgbackup');
    source = await createTestDatabase(parseTestDatabaseUrl(process.env), { mcpRuntime: true });
    tenants = await seedTwoTenants(source.admin.db);
    await seedProjectKnowledge(source.admin.db, tenants);
    await seedOpportunity(source.admin.db, tenants.a.tenantId);
    await seedOpportunity(source.admin.db, tenants.b.tenantId);
    payload.projectId = tenants.a.projectId;
    originalNote = await session(source.runtimeUrl, tenants.a, async (client) => {
      const result = await client.callTool({ name: 'create_project_note', arguments: payload });
      expect(result.isError).not.toBe(true);
      return result.structuredContent;
    });
    baseline = await data(source.admin);
    const manifest = await createBackup(backupConfig(), artifact).catch((error: unknown) => {
      throw new Error(
        `Recovery fixture backup failed: ${error instanceof RecoveryError ? error.category : 'INTERNAL'}`,
      );
    });
    process.stderr.write(
      JSON.stringify({
        event: 'recovery.drill.backup',
        durationMs: manifest.backupDurationMs,
        bytes: manifest.bytes,
      }) + '\n',
    );
  }, 60_000);

  afterAll(async () => {
    await cleanupTestResources([
      {
        stage: 'source_database',
        run: async () => {
          await source?.close();
        },
      },
      {
        stage: 'artifact_directory',
        run: async () => {
          if (!directory) return;
          // This exact mkdtemp path belongs to this suite, never a supplied directory.
          if (!directory.startsWith(join(tmpdir(), 'beloveddev-recovery-drill-')))
            throw new Error('Refusing unknown fixture cleanup.');
          await rm(directory, { recursive: true, force: true });
        },
      },
    ]);
  });

  it.each([1, 2])(
    'restores all rows, ledger, schema, MCP behavior, and original note retry into independent target %s',
    async () => {
      const drill = await withRestoredDatabase(restoreConfig(), artifact, async (target) => {
        expect(await data(target.admin)).toEqual(baseline);
        await assertRuntimeDatabaseReady(target.runtime.pool);
        const constraints = await target.admin.pool.query<{ invalid: number }>(
          'SELECT count(*)::int AS invalid FROM pg_constraint WHERE NOT convalidated',
        );
        expect(constraints.rows).toEqual([{ invalid: 0 }]);
        await expect(
          target.admin.pool.query('UPDATE projects SET client_id=$1 WHERE id=$2', [
            tenants.b.clientId,
            tenants.a.projectId,
          ]),
        ).rejects.toMatchObject({ code: '23503' });
        expect(
          (
            await target.admin.pool
              .query(`SELECT count(*)::int AS count FROM audit_logs a JOIN project_notes n
        ON a.tenant_id=n.tenant_id AND a.resource_id=n.id AND a.actor_user_id=n.author_user_id
        WHERE a.metadata->>'projectId'=n.project_id::text AND a.metadata->>'category'=n.category::text`)
          ).rows,
        ).toEqual([{ count: 1 }]);
        await expect(
          target.runtime.pool.query('CREATE TABLE recovery_forbidden(id int)'),
        ).rejects.toMatchObject({ code: '42501' });
        await session(target.runtimeUrl, tenants.a, async (client) => {
          for (const [name, args] of [
            ['get_profile', {}],
            ['list_projects', {}],
            ['get_project', { projectId: tenants.a.projectId }],
            ['get_blockers', {}],
            ['list_opportunities', {}],
            ['search_project_evidence', { query: 'PostgreSQL' }],
          ] as const)
            expect((await client.callTool({ name, arguments: args })).isError).not.toBe(true);
          const blocked = await client.callTool({
            name: 'get_project',
            arguments: { projectId: tenants.b.projectId },
          });
          expect(blocked.isError).toBe(true);
          const retry = await client.callTool({ name: 'create_project_note', arguments: payload });
          expect(retry.isError).not.toBe(true);
          // Request correlation and created=false may differ; preserved note data must not.
          const note = toolSchemas.create_project_note.output.parse(retry.structuredContent);
          expect(note.created).toBe(false);
          expect(note.note).toEqual(
            toolSchemas.create_project_note.output.parse(originalNote).note,
          );
        });
        expect(await data(target.admin)).toEqual(baseline);
        const matches = await target.admin.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM project_evidence WHERE search_vector @@ plainto_tsquery('english','PostgreSQL')",
        );
        expect(matches.rows).toEqual([{ count: 2 }]);
        const gin = await target.admin.pool.query(
          "SELECT indexname FROM pg_indexes WHERE indexname='project_evidence_search_vector_idx' AND indexdef LIKE '%USING gin%'",
        );
        expect(gin.rows).toHaveLength(1);
        return target.databaseName;
      });
      expect(drill.result).toMatch(/^beloveddev_restore_[a-f0-9]{32}$/);
      expect(
        (
          await source.admin.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [
            drill.result,
          ])
        ).rows,
      ).toEqual([]);
      process.stderr.write(
        JSON.stringify({ event: 'recovery.drill.restore', durationMs: drill.restoreDurationMs }) +
          '\n',
      );
      expect(await data(source.admin)).toEqual(baseline);
    },
    40_000,
  );

  it('validates archive magic, contents, complete payload, size, and digest', async () => {
    const manifest = await validateBackup(restoreConfig(), artifact);
    expect(manifest.status).toBe('validated');
    expect(manifest.bytes).toBe((await stat(join(artifact, 'archive.dump'))).size);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(manifest.data)).toHaveLength(12);
    expect(manifest.data['audit_logs']?.count).toBe(1);
    expect(manifest.data['project_notes']?.count).toBe(3);
  });

  it.each([
    { deadline: 'default', configured: undefined, idleTimeoutMs: 330_000 },
    { deadline: 'maximum', configured: '3600000', idleTimeoutMs: 3_630_000 },
  ])(
    'applies the $deadline idle timeout to the actual snapshot holder while retaining the migration lock',
    async ({ deadline, configured, idleTimeoutMs }) => {
      const holder = await source.admin.pool.connect();
      const abort = new AbortController();
      // Observe clients with a pass-through spy; all connections and SQL remain real.
      const connections = vi.spyOn(PgClient.prototype, 'connect');
      let running: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN; LOCK TABLE pg_catalog.pg_init_privs IN ACCESS EXCLUSIVE MODE');
        const config = parseRecoveryEnvironment(
          {
            ...process.env,
            DATABASE_BACKUP_URL: source.migrationUrl,
            DATABASE_RECOVERY_TIMEOUT_MS: configured,
          },
          'backup',
        );
        running = createBackup(
          config,
          join(directory, `idle-timeout-${deadline}.pgbackup`),
          abort.signal,
        ).catch((error: unknown) => error);
        await waitForUtility(source);
        const snapshotHolders = () =>
          source.admin.pool.query<{ pid: number; state: string; snapshot_active: boolean }>(
            `SELECT a.pid,a.state,a.backend_xmin IS NOT NULL AS snapshot_active
             FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
             WHERE a.datname=current_database() AND a.application_name='beloveddev-recovery'
               AND l.locktype='advisory' AND l.classid=$1::oid AND l.objid=$2::oid
               AND l.objsubid=2 AND l.mode='ShareLock' AND l.granted`,
            [...MIGRATION_LOCK],
          );
        const before = await snapshotHolders();
        expect(before.rows).toHaveLength(1);
        expect(before.rows[0]).toMatchObject({
          state: 'idle in transaction',
          snapshot_active: true,
        });
        expect(before.rows[0]?.pid).toBeGreaterThan(0);
        const settings: { pid: number; idle_timeout_ms: number }[] = [];
        for (const client of connections.mock.contexts) {
          if (client instanceof PgClient && client.database === config.database) {
            const actual = await client.query<{ pid: number; idle_timeout_ms: number }>(
              `SELECT pg_backend_pid() AS pid,setting::int AS idle_timeout_ms
               FROM pg_settings WHERE name='idle_in_transaction_session_timeout'`,
            );
            settings.push(...actual.rows);
          }
        }
        // Match the server-reported setting to the PID holding this backup's snapshot/lock.
        expect(settings.filter(({ pid }) => pid === before.rows[0]?.pid)).toEqual([
          { pid: before.rows[0]?.pid, idle_timeout_ms: idleTimeoutMs },
        ]);
        expect((await snapshotHolders()).rows).toEqual(before.rows);
        expect(
          (
            await holder.query<{ acquired: boolean }>(
              'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired',
              [...MIGRATION_LOCK],
            )
          ).rows,
        ).toEqual([{ acquired: false }]);
        await holder.query('ROLLBACK');
        expect(await running).toMatchObject({ status: 'validated' });
      } finally {
        abort.abort();
        await running;
        connections.mockRestore();
        try {
          await holder.query('ROLLBACK');
        } finally {
          holder.release(true);
        }
      }
    },
  );

  it('binds the dump and row digests to one snapshot despite a concurrent committed source write', async () => {
    const concurrent = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    const abort = new AbortController();
    let running: Promise<unknown> | undefined;
    const holder = await concurrent.admin.pool.connect();
    try {
      const fixture = await seedTwoTenants(concurrent.admin.db);
      const expected = await data(concurrent.admin);
      await holder.query('BEGIN; LOCK TABLE pg_catalog.pg_init_privs IN ACCESS EXCLUSIVE MODE');
      const path = join(directory, 'concurrent.pgbackup');
      running = createBackup(
        parseRecoveryEnvironment(
          { ...process.env, DATABASE_BACKUP_URL: concurrent.migrationUrl },
          'backup',
        ),
        path,
        abort.signal,
      );
      const settled = running.catch((error: unknown) => error);
      await waitForUtility(concurrent);
      await concurrent.admin.pool.query(
        "UPDATE projects SET summary='Committed after snapshot export' WHERE id=$1",
        [fixture.a.projectId],
      );
      await holder.query('ROLLBACK');
      expect(await settled).toMatchObject({ status: 'validated' });
      await withRestoredDatabase(restoreConfig(), path, async (target) => {
        expect(await data(target.admin)).toEqual(expected);
      });
      expect(await data(concurrent.admin)).not.toEqual(expected);
    } finally {
      abort.abort();
      await running?.catch(() => {});
      await cleanupTestResources([
        {
          stage: 'catalog_transaction',
          run: async () => {
            await holder.query('ROLLBACK');
          },
        },
        {
          stage: 'catalog_connection',
          run: () => {
            holder.release(true);
            return Promise.resolve();
          },
        },
        { stage: 'concurrent_database', run: () => concurrent.close() },
      ]);
    }
  }, 40_000);

  it('refuses to overwrite an existing artifact', async () => {
    const before = await readFile(join(artifact, 'manifest.json'));
    await expect(createBackup(backupConfig(), artifact)).rejects.toMatchObject({
      category: 'EXISTS',
    });
    expect(await readFile(join(artifact, 'manifest.json'))).toEqual(before);
  });

  it.each(['missing-parent/backup.pgbackup', 'verified.pgbackup/archive.dump/child'])(
    'rejects invalid backup path: %s',
    async (name) => {
      await expect(createBackup(backupConfig(), join(directory, name))).rejects.toMatchObject({
        category: 'ARTIFACT',
      });
    },
  );

  it.each(['truncated', 'corrupted'] as const)(
    'rejects %s archives even when a replaced manifest claims matching size and digest',
    async (mode) => {
      const copy = join(directory, `${mode}.pgbackup`);
      await cp(artifact, copy, { recursive: true });
      const path = join(copy, 'archive.dump');
      let bytes = await readFile(path);
      if (mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 100);
      else bytes.fill(0, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 100);
      await writeFile(path, bytes);
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8')) as {
        bytes: number;
        sha256: string;
      };
      manifest.bytes = bytes.length;
      manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      await expect(validateBackup(restoreConfig(), copy)).rejects.toBeInstanceOf(RecoveryError);
    },
  );

  it('rejects incorrect credentials without exposing them', async () => {
    const url = new URL(source.migrationUrl);
    url.password = 'private-wrong-recovery-password';
    await expect(
      createBackup(
        parseRecoveryEnvironment({ ...process.env, DATABASE_BACKUP_URL: url.href }, 'backup'),
        join(directory, 'wrong.pgbackup'),
      ),
    ).rejects.toMatchObject({
      category: 'CONNECTION',
      message: 'Database recovery operation was not verified.',
    });
  });

  it('rejects unsupported client versions before touching source data', async () => {
    const tools = join(directory, 'unsupported-tools');
    await mkdir(tools);
    await link(
      process.execPath,
      join(tools, 'pg_dump' + (process.platform === 'win32' ? '.exe' : '')),
    );
    await expect(
      createBackup(
        parseRecoveryEnvironment(
          {
            ...process.env,
            DATABASE_BACKUP_URL: source.migrationUrl,
            DATABASE_RECOVERY_PG_BIN: tools,
          },
          'backup',
        ),
        join(directory, 'old.pgbackup'),
      ),
    ).rejects.toMatchObject({ category: 'CLIENT_VERSION' });
  });

  it('detects absent migration records before backing up and preserves the source after rollback', async () => {
    const broken = await createTestDatabase(parseTestDatabaseUrl(process.env), {
      mcpRuntime: true,
    });
    try {
      await broken.admin.pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=1');
      await expect(
        createBackup(
          parseRecoveryEnvironment(
            { ...process.env, DATABASE_BACKUP_URL: broken.migrationUrl },
            'backup',
          ),
          join(directory, 'missing-ledger.pgbackup'),
        ),
      ).rejects.toMatchObject({ category: 'LEDGER' });
    } finally {
      await broken.close();
    }
    expect(await data(source.admin)).toEqual(baseline);
  });

  it.each(['INTERRUPTED', 'TIMEOUT', 'PROCESS'] as const)(
    'cleans partial backup after state-coordinated %s',
    async (category) => {
      const holder = await source.admin.pool.connect();
      const abort = new AbortController();
      const output = join(directory, `${category}.pgbackup`);
      let running: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN; LOCK TABLE pg_catalog.pg_init_privs IN ACCESS EXCLUSIVE MODE');
        const config = backupConfig();
        running = createBackup(config, output, abort.signal).catch((error: unknown) => error);
        const pid = await waitForUtility(source);
        if (category === 'INTERRUPTED') abort.abort();
        // Inject expiration only after the native utility is actually blocked.
        // Startup/provisioning speed must not determine whether this state is reached.
        if (category === 'TIMEOUT')
          abort.abort(new DOMException('Test deadline expired', 'TimeoutError'));
        if (category === 'PROCESS')
          await source.admin.pool.query('SELECT pg_terminate_backend($1)', [pid]);
        expect(await running).toMatchObject({ category });
      } finally {
        abort.abort();
        await running;
        try {
          await holder.query('ROLLBACK');
        } finally {
          holder.release(true);
        }
      }
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await data(source.admin)).toEqual(baseline);
    },
  );

  it('rejects changed data expectations after restore and retires the unverified target', async () => {
    const copy = join(directory, 'wrong-data.pgbackup');
    await cp(artifact, copy, { recursive: true });
    const path = join(copy, 'manifest.json');
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      data: Record<string, { count: number }>;
    };
    if (value.data['project_notes']) value.data['project_notes'].count++;
    await writeFile(path, JSON.stringify(value));
    await expect(
      withRestoredDatabase(restoreConfig(), copy, () => Promise.resolve()),
    ).rejects.toMatchObject({ category: 'DATA' });
  });

  it('rejects excessive target runtime grants through unchanged M8-D readiness', async () => {
    await expect(
      withRestoredDatabase(restoreConfig(), artifact, async (target) => {
        const role = new URL(target.runtimeUrl).username;
        if (!/^beloveddev_restore_[a-f0-9]{32}_rt$/.test(role))
          throw new Error('Unexpected generated runtime role.');
        await target.admin.pool.query(`GRANT DELETE ON projects TO "${role}"`);
        await expect(assertRuntimeDatabaseReady(target.runtime.pool)).rejects.toMatchObject({
          category: 'UNSAFE_PRIVILEGES',
        });
      }),
    ).rejects.toMatchObject({ category: 'READINESS' });
  }, 30_000);

  it('detects missing target runtime privileges and retires the target', async () => {
    await expect(
      withRestoredDatabase(restoreConfig(), artifact, async (target) => {
        const role = new URL(target.runtimeUrl).username;
        if (!/^beloveddev_restore_[a-f0-9]{32}_rt$/.test(role))
          throw new Error('Unexpected generated runtime role.');
        await target.admin.pool.query(`REVOKE INSERT ON audit_logs FROM "${role}"`);
      }),
    ).rejects.toMatchObject({ category: 'READINESS' });
  }, 30_000);

  it('cleans an interrupted restore operation after target verification', async () => {
    const abort = new AbortController();
    let name = '';
    await expect(
      withRestoredDatabase(
        restoreConfig(),
        artifact,
        (target) => {
          name = target.databaseName;
          abort.abort();
          return Promise.resolve();
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ category: 'INTERRUPTED' });
    expect(
      (await source.admin.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows,
    ).toEqual([]);
  });

  it('bounds a callback on an expired deadline signal and retires its target', async () => {
    let name = '';
    const abort = new AbortController();
    await expect(
      withRestoredDatabase(
        restoreConfig(),
        artifact,
        (target) => {
          name = target.databaseName;
          abort.abort(new DOMException('Test deadline expired', 'TimeoutError'));
          return new Promise<void>(() => {});
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ category: 'TIMEOUT' });
    expect(name).toMatch(/^beloveddev_restore_/);
    expect(
      (await source.admin.pool.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows,
    ).toEqual([]);
  });

  it('enforces the configured overall deadline even before backup startup completes', async () => {
    const output = join(directory, 'startup-deadline.pgbackup');
    await expect(createBackup({ ...backupConfig(), timeoutMs: 1 }, output)).rejects.toMatchObject({
      category: 'TIMEOUT',
    });
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes backup, validation, and verified retirement through the real CLI with safe diagnostics', async () => {
    const env = {
      DATABASE_BACKUP_URL: source.migrationUrl,
      DATABASE_RESTORE_ADMIN_URL: parseTestDatabaseUrl(process.env),
      ...(process.env['DATABASE_RECOVERY_PG_BIN']
        ? { DATABASE_RECOVERY_PG_BIN: process.env['DATABASE_RECOVERY_PG_BIN'] }
        : {}),
    };
    const path = join(directory, 'cli.pgbackup');
    for (const command of ['backup', 'validate', 'drill']) {
      const result = await recoveryCli([command, path], env);
      expect(result.code).toBe(0);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]?.['event']).toBe(
        command === 'drill' ? 'database.restore_verified' : 'database.backup_validated',
      );
    }
    const missing = await recoveryCli(['backup', join(directory, 'no-config.pgbackup')], {
      DATABASE_URL: source.migrationUrl,
    });
    expect(missing.code).toBe(1);
    expect(missing.logs[0]).toMatchObject({ category: 'CONFIGURATION', outcome: 'unconfirmed' });
  }, 40_000);

  it('leaves the original multi-tenant source unchanged and ready', async () => {
    expect(await data(source.admin)).toEqual(baseline);
    await assertRuntimeDatabaseReady(source.runtime.pool);
  });
});

describe('native PostgreSQL recovery TLS', () => {
  let tls: Awaited<ReturnType<typeof createTlsPostgres>>;
  let source: TestDatabase;
  let directory: string;
  beforeAll(async () => {
    tls = await createTlsPostgres();
    source = await createTestDatabase(tls.url, { mcpRuntime: true, tlsCa: tls.ca });
    directory = await mkdtemp(join(tmpdir(), 'beloveddev-recovery-tls-'));
  }, 90_000);
  afterAll(async () => {
    await cleanupTestResources([
      {
        stage: 'tls_database',
        run: async () => {
          await source?.close();
        },
      },
      {
        stage: 'tls_container',
        run: async () => {
          if (tls) await tls.close();
        },
      },
      {
        stage: 'tls_directory',
        run: async () => {
          if (directory) {
            if (!directory.startsWith(join(tmpdir(), 'beloveddev-recovery-tls-')))
              throw new Error('Unexpected TLS fixture path.');
            await rm(directory, { recursive: true, force: true });
          }
        },
      },
    ]);
  });
  it('dumps and restores with verified private-CA TLS without weakening M8-D readiness', async () => {
    const artifact = join(directory, 'tls.pgbackup');
    const backup = parseRecoveryEnvironment(
      { ...process.env, DATABASE_BACKUP_URL: source.migrationUrl, DATABASE_BACKUP_TLS_CA: tls.ca },
      'backup',
    );
    await createBackup(backup, artifact);
    const restore = parseRecoveryEnvironment(
      { ...process.env, DATABASE_RESTORE_ADMIN_URL: tls.url, DATABASE_RESTORE_TLS_CA: tls.ca },
      'restore',
    );
    await withRestoredDatabase(restore, artifact, async (target) => {
      await assertRuntimeDatabaseReady(target.runtime.pool);
      expect(
        (await target.runtime.pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'))
          .rows,
      ).toEqual([{ ssl: true }]);
    });
  }, 40_000);
  it('rejects missing trust roots and a wrong certificate hostname', async () => {
    await expect(
      createBackup(
        parseRecoveryEnvironment(
          { ...process.env, DATABASE_BACKUP_URL: source.migrationUrl },
          'backup',
        ),
        join(directory, 'untrusted.pgbackup'),
      ),
    ).rejects.toMatchObject({ category: 'CONNECTION' });
    const url = new URL(source.migrationUrl);
    url.hostname = '127.0.0.1';
    await expect(
      createBackup(
        parseRecoveryEnvironment(
          { ...process.env, DATABASE_BACKUP_URL: url.href, DATABASE_BACKUP_TLS_CA: tls.ca },
          'backup',
        ),
        join(directory, 'wrong-host.pgbackup'),
      ),
    ).rejects.toMatchObject({ category: 'CONNECTION' });
  });
});
