import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createTlsPostgres } from '@beloveddev/test-support/tls-database';
import { createTestDatabase } from '@beloveddev/test-support/test-database';
import { seedTwoTenants } from '@beloveddev/test-support/tenant-fixtures';
import { seedOpportunity } from '@beloveddev/test-support/opportunity-fixtures';
import { safeErrorSchema, toolSchemas } from '@beloveddev/mcp/schemas';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const image = 'beloveddev-mcp:container-smoke';
const expectedTools = Object.keys(toolSchemas).sort();
let phase = 'build';

async function docker(args: string[], timeout = 30_000) {
  const operation = exec('docker', args, {
    cwd: workspace,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  try {
    const { stdout } = await within(operation, timeout);
    return stdout.trim();
  } catch {
    // On Windows, killing docker.exe alone leaves its Buildx plugin holding
    // the pipes open. Terminate this command's tree before releasing its pipes.
    const child = operation.child;
    if (child.pid !== undefined && child.exitCode === null) {
      if (process.platform === 'win32') {
        await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          timeout: 5000,
          windowsHide: true,
        }).catch(() => child.kill('SIGKILL'));
      } else child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    // Docker errors can contain command arguments. Never print runtime credentials.
    process.stderr.write(
      JSON.stringify({
        event: 'container_smoke.docker_failed',
        operation: args.slice(0, 2),
        phase,
      }) + '\n',
    );
    throw new Error(`Docker operation failed during ${phase}.`);
  }
}

const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Response = z.infer<typeof responseSchema>;
const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  structuredContent: z.unknown().optional(),
});

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Container smoke deadline exceeded.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(network: string, environment: Record<string, string>, hideMigrations = false) {
  const name = `beloveddev_mcp_smoke_${randomUUID().replaceAll('-', '')}`;
  const child = spawn(
    'docker',
    [
      'run',
      '--interactive',
      '--name',
      name,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--memory=256m',
      '--cpus=1',
      ...(hideMigrations
        ? ['--tmpfs', '/app/packages/database/migrations:ro,noexec,nosuid,size=1m,mode=0755']
        : []),
      '--network',
      `container:${network}`,
      ...Object.keys(environment).flatMap((key) => ['--env', key]),
      image,
    ],
    { cwd: workspace, env: { ...process.env, ...environment }, stdio: 'pipe', windowsHide: true },
  );
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  let nextId = 0;
  let malformed = false;
  let wireIssue: 'invalid_message' | 'unexpected_response' | undefined;
  let stdoutLines = 0;
  let stderr = '';
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    stdoutLines += 1;
    const parsed = responseSchema.safeParse(
      (() => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success || !pending.has(parsed.data.id)) {
      malformed = true;
      wireIssue = parsed.success ? 'unexpected_response' : 'invalid_message';
    } else pending.get(parsed.data.id)?.resolve(parsed.data);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 1024 * 1024) {
      malformed = true;
      stderr = stderr.slice(0, 1024 * 1024);
    }
  });
  child.stdin.on('error', () => {
    for (const request of pending.values()) request.reject(new Error('Container input closed.'));
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  void exited.then(
    () => {
      for (const request of pending.values()) request.reject(new Error('Container closed.'));
    },
    () => {
      for (const request of pending.values()) request.reject(new Error('Container failed.'));
    },
  );
  return {
    async assertNoListeners() {
      // PostgreSQL shares this network namespace. Attribute sockets to Node PID 1,
      // rather than mistaking the test database's listener for an application port.
      await docker([
        'exec',
        name,
        'node',
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import { readdir, readFile, readlink } from 'node:fs/promises';
          const sockets = new Set();
          for (const fd of await readdir('/proc/1/fd')) {
            try {
              const target = await readlink('/proc/1/fd/' + fd);
              const match = /^socket:\\[(\\d+)\\]$/.exec(target);
              if (match) sockets.add(match[1]);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
            const rows = (await readFile('/proc/net/' + table, 'utf8')).trim().split('\\n').slice(1);
            for (const row of rows) {
              const fields = row.trim().split(/\\s+/);
              if (!sockets.has(fields[9])) continue;
              assert(!(table.startsWith('tcp') && fields[3] === '0A'), 'Node must not listen on TCP');
              assert(!table.startsWith('udp'), 'Node must not bind UDP');
            }
          }
        `,
      ]);
    },
    async request(method: string, params: Record<string, unknown> = {}) {
      const id = ++nextId;
      try {
        const response = await within(
          new Promise<Response>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          }),
          20_000,
        );
        assert.equal(response.error, undefined);
        return response.result;
      } finally {
        pending.delete(id);
      }
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    async stop(signal?: 'SIGINT' | 'SIGTERM') {
      if (signal) await docker(['kill', '--signal', signal, name]);
      else child.stdin.end();
      const code = await within(exited, 18_000).catch(() => null);
      if (code !== 0)
        process.stderr.write(
          JSON.stringify({
            event: 'container_smoke.stop_failed',
            exitCode: code,
            signal: signal ?? 'EOF',
          }) + '\n',
        );
      assert.equal(code, 0);
    },
    async expectStartupFailure(event: string, category?: string) {
      const code = await within(exited, 18_000);
      const records = this.records();
      const expected = records.some(
        (record) =>
          record['event'] === event && (category === undefined || record['category'] === category),
      );
      if (code !== 1 || stdoutLines !== 0 || !expected) {
        const safeCategory = z.enum([
          'TIMEOUT',
          'CONNECTION',
          'IDENTITY',
          'SCHEMA',
          'READ_ONLY',
          'UNSAFE_PRIVILEGES',
          'MISSING_PRIVILEGES',
          'TRANSPORT_POLICY',
        ]);
        process.stderr.write(
          JSON.stringify({
            event: 'container_smoke.startup_mismatch',
            exitCode: code,
            stdoutLines,
            categories: records
              .map((record) => safeCategory.safeParse(record['category']))
              .filter((result) => result.success)
              .map((result) => result.data)
              .slice(0, 8),
          }) + '\n',
        );
      }
      assert.equal(code, 1);
      assert.equal(stdoutLines, 0);
      assert(expected);
      assert(!records.some((record) => record['event'] === 'mcp.ready'));
    },
    records() {
      if (malformed)
        process.stderr.write(
          JSON.stringify({
            event: 'container_smoke.protocol_failed',
            wireIssue,
          }) + '\n',
        );
      assert.equal(malformed, false, 'stdout must contain only expected JSON-RPC responses');
      for (const key of ['DATABASE_URL', 'MCP_CURSOR_SECRET']) {
        const secret = environment[key];
        if (secret) assert(!stderr.includes(secret), 'runtime secrets must not appear in stderr');
      }
      return stderr
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    },
    async close() {
      try {
        await docker(['rm', '--force', name]);
      } finally {
        child.stdin.destroy();
        await within(
          exited.catch(() => null),
          5000,
        );
        lines.close();
      }
    },
  };
}

async function initialize(session: ReturnType<typeof launch>) {
  z.object({ protocolVersion: z.literal('2025-06-18') }).parse(
    await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'linux-container-smoke', version: '1' },
    }),
  );
  session.notify('notifications/initialized');
  const listing = z
    .object({
      tools: z.array(
        z.object({
          name: z.string(),
          inputSchema: z.object({ additionalProperties: z.literal(false) }),
          outputSchema: z.object({ type: z.literal('object') }),
          annotations: z.object({ readOnlyHint: z.boolean(), idempotentHint: z.literal(true) }),
        }),
      ),
    })
    .parse(await session.request('tools/list'));
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), expectedTools);
  assert.equal(listing.tools.length, 8);
  for (const tool of listing.tools)
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'create_project_note');
}

async function sourceSnapshot() {
  // A clean source-only checkout equivalent, including the current reviewed patch.
  // Never copy ignored dependencies, dist, credentials, or untracked private files.
  const { stdout } = await exec(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const directory = await mkdtemp(join(tmpdir(), 'beloveddev-release-'));
  const close = async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith('beloveddev-release-'));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const runtimePath =
      /^(apps\/mcp-server|packages\/(domain|application|database|infrastructure|mcp))\/(tsconfig\.json|src\/.+\.ts)$/;
    const files = stdout
      .split('\0')
      .filter(
        (file) =>
          [
            'Dockerfile',
            '.dockerignore',
            'package.json',
            'package-lock.json',
            'tsconfig.base.json',
          ].includes(file) ||
          /^(apps\/mcp-server|packages\/[^/]+)\/package\.json$/.test(file) ||
          (runtimePath.test(file) && !file.endsWith('.test.ts')) ||
          /^packages\/database\/migrations\/([^/]+\.sql|meta\/[^/]+\.json)$/.test(file),
      );
    assert(files.includes('Dockerfile') && files.includes('package-lock.json'));
    for (const file of files) {
      assert(
        !file
          .split('/')
          .some(
            (segment) =>
              segment.startsWith('.') || segment === 'node_modules' || segment === 'dist',
          ) || file === '.dockerignore',
      );
      const target = join(directory, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(workspace, file), target);
    }
    return { directory, close };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

async function run() {
  assert.equal(await docker(['version', '--format', '{{.Server.Os}}']), 'linux');
  const builder = `beloveddev-release-${randomUUID()}`;
  const source = await sourceSnapshot();
  let imageId: string;
  try {
    await docker([
      'buildx',
      'create',
      '--name',
      builder,
      '--driver',
      'docker-container',
      '--driver-opt',
      'image=moby/buildkit:v0.26.1@sha256:8290a3b1183f45fb0c7ccd2faa7aa88eeb9af0ea85ff54458cbd8cbdb576e721',
      '--driver-opt',
      'memory=2g',
      '--driver-opt',
      'memory-swap=2g',
      '--driver-opt',
      'cpu-period=100000',
      '--driver-opt',
      'cpu-quota=200000',
    ]);
    const buildArgs = [
      'buildx',
      'build',
      '--builder',
      builder,
      '--build-arg',
      'SOURCE_DATE_EPOCH=0',
      '--provenance=false',
      '--output',
      'type=docker,rewrite-timestamp=true',
      '--tag',
      image,
      source.directory,
    ];
    try {
      process.stderr.write('Building the source-only release image.\n');
      await docker(buildArgs, 600_000);
      imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
      phase = 'cold repeat build';
      process.stderr.write('Comparing a cold rebuild of the release image.\n');
      await docker([...buildArgs, '--no-cache'], 600_000);
      assert.equal(await docker(['image', 'inspect', image, '--format', '{{.Id}}']), imageId);
    } finally {
      await docker(['buildx', 'rm', '--force', builder]);
    }
  } finally {
    await source.close();
  }
  phase = 'artifact inspection';
  const configuration = z
    .object({
      Config: z.object({
        User: z.literal('1000:1000'),
        Entrypoint: z.array(z.string()),
        Cmd: z.array(z.string()),
        Env: z.array(z.string()),
        ExposedPorts: z.unknown().optional(),
      }),
    })
    .parse((JSON.parse(await docker(['image', 'inspect', image])) as unknown[])[0]);
  assert.deepEqual(configuration.Config.Entrypoint, ['node']);
  assert.deepEqual(configuration.Config.Cmd, ['/app/apps/mcp-server/dist/main.js']);
  assert.equal(configuration.Config.ExposedPorts, undefined);
  assert(!configuration.Config.Env.some((value) => /^(DATABASE_|MCP_|NODE_ENV=)/.test(value)));
  const migrationRoot = new URL('../packages/database/migrations/', import.meta.url);
  const migrations: Record<string, string> = {};
  for (const path of await readdir(migrationRoot, { recursive: true })) {
    if (!/\.(sql|json)$/.test(path)) continue;
    migrations[path.replaceAll('\\', '/')] = createHash('sha256')
      .update(await readFile(new URL(path.replaceAll('\\', '/'), migrationRoot)))
      .digest('hex');
  }
  const probe = await docker([
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    image,
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      import {readFileSync, existsSync, accessSync, constants, readdirSync} from 'node:fs';
      import {createHash} from 'node:crypto';
      import {MAX_ACTIVE_INVOCATIONS, APPLICATION_RESPONSE_DEADLINE_MS, MAX_SUCCESS_RESPONSE_BYTES} from '@beloveddev/mcp/invocation-policy';
      assert.equal(process.getuid(), 1000);
      assert.equal(process.platform, 'linux');
      assert.match(process.versions.node, /^24\\./);
      assert.throws(() => accessSync('/app', constants.W_OK));
      assert.deepEqual([MAX_ACTIVE_INVOCATIONS, APPLICATION_RESPONSE_DEADLINE_MS, MAX_SUCCESS_RESPONSE_BYTES], [8, 30000, 1048576]);
      for (const path of ['.env', '.git', 'scripts', 'docs', 'apps/mcp-server/src', 'packages/test-support', 'node_modules/typescript', 'node_modules/vitest', 'node_modules/eslint', 'node_modules/@modelcontextprotocol/client', '/usr/local/bin/npm']) assert(!existsSync(path));
      for (const workspace of readdirSync('node_modules/@beloveddev')) assert(existsSync('node_modules/@beloveddev/' + workspace + '/package.json'));
      const migrations = ${JSON.stringify(migrations)};
      for (const [path, hash] of Object.entries(migrations)) assert.equal(createHash('sha256').update(readFileSync('packages/database/migrations/' + path)).digest('hex'), hash);
      process.stdout.write(JSON.stringify({node: process.versions.node, migrations: Object.keys(migrations).length}));
    `,
  ]);
  const artifact = z.object({ node: z.string(), migrations: z.number() }).parse(JSON.parse(probe));
  phase = 'PostgreSQL provisioning';
  const postgres = await createTlsPostgres();
  try {
    const database = await createTestDatabase(postgres.url, {
      mcpRuntime: true,
      tlsCa: postgres.ca,
    });
    try {
      const tenants = await seedTwoTenants(database.admin.db);
      const opportunity = await seedOpportunity(database.admin.db, tenants.a.tenantId);
      const url = new URL(database.runtimeUrl);
      // Share only this disposable database's loopback namespace; keep verify-full TLS.
      url.port = '5432';
      const environment = {
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        MCP_AUTH_MODE: 'local',
        DATABASE_URL: url.href,
        DATABASE_TLS_CA: postgres.ca,
        MCP_LOCAL_TENANT_ID: tenants.a.tenantId,
        MCP_LOCAL_USER_ID: tenants.a.userId,
        MCP_CURSOR_SECRET: randomUUID() + randomUUID(),
      };
      for (const signal of [undefined, 'SIGINT', 'SIGTERM'] as const) {
        phase = signal === undefined ? 'MCP tools and EOF' : `Linux ${signal}`;
        const session = launch(postgres.containerName, environment);
        try {
          await initialize(session);
          await session.assertNoListeners();
          if (signal === undefined) {
            const commands = [
              ['get_profile', {}],
              ['list_projects', {}],
              ['get_project', { projectId: tenants.a.projectId }],
              ['get_blockers', {}],
              ['search_project_evidence', { query: 'TypeScript' }],
              ['list_opportunities', {}],
              ['evaluate_opportunity', { opportunityId: opportunity.id }],
            ] as const;
            for (const [name, args] of commands) {
              const result = resultSchema.parse(
                await session.request('tools/call', { name, arguments: args }),
              );
              assert.notEqual(result.isError, true);
              toolSchemas[name].output.parse(result.structuredContent);
              assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), result.structuredContent);
            }
            const command = {
              projectId: tenants.a.projectId,
              category: 'decision',
              content: 'container-private-note',
              idempotencyKey: randomUUID(),
            };
            for (const created of [true, false]) {
              const result = resultSchema.parse(
                await session.request('tools/call', {
                  name: 'create_project_note',
                  arguments: command,
                }),
              );
              assert.notEqual(result.isError, true);
              assert.equal(
                toolSchemas.create_project_note.output.parse(result.structuredContent).created,
                created,
              );
            }
            const rows = await database.admin.pool.query<{ notes: number; audits: number }>(
              'SELECT count(*)::int AS notes, (SELECT count(*)::int FROM audit_logs WHERE resource_id IN (SELECT id FROM project_notes WHERE idempotency_key=$1)) AS audits FROM project_notes WHERE idempotency_key=$1',
              [command.idempotencyKey],
            );
            assert.deepEqual(rows.rows, [{ notes: 1, audits: 1 }]);
            const denied = resultSchema.parse(
              await session.request('tools/call', {
                name: 'get_project',
                arguments: { projectId: tenants.b.projectId },
              }),
            );
            assert.equal(denied.isError, true);
            assert.equal(denied.structuredContent, undefined);
            assert.equal(
              safeErrorSchema.parse(JSON.parse(denied.content[0]?.text ?? '')).error.code,
              'NOT_FOUND',
            );
            const spoofed = resultSchema.parse(
              await session.request('tools/call', {
                name: 'get_profile',
                arguments: { tenantId: tenants.b.tenantId },
              }),
            );
            assert.equal(spoofed.isError, true);
          }
          await session.stop(signal);
          const records = session.records();
          assert(records.some((record) => record['event'] === 'mcp.ready'));
          assert(
            records.some((record) => record['event'] === 'mcp.stopped' && record['exitCode'] === 0),
          );
          assert(
            records.some(
              (record) =>
                record['event'] === 'mcp.stopping' &&
                record['reason'] === (signal ?? 'transport_closed'),
            ),
          );
          assert(!JSON.stringify(records).includes('container-private-note'));
        } finally {
          await session.close();
        }
      }
      const adminUrl = new URL(postgres.url);
      adminUrl.pathname = url.pathname;
      adminUrl.port = '5432';
      const failures = [
        [{ MCP_CURSOR_SECRET: '' }, 'configuration.invalid', undefined],
        [{ NODE_ENV: 'production' }, 'configuration.invalid', undefined],
        [{ MCP_AUTH_MODE: 'remote' }, 'configuration.invalid', undefined],
        [{ DATABASE_URL: adminUrl.href }, 'mcp.startup_failed', 'UNSAFE_PRIVILEGES'],
        [
          {
            DATABASE_URL: url.href
              .replace('localhost', 'db.invalid')
              .replace('verify-full', 'disable'),
          },
          'mcp.startup_failed',
          'TRANSPORT_POLICY',
        ],
      ] as const;
      for (const [override, event, category] of failures) {
        phase = `safe rejection: ${category ?? Object.keys(override)[0]}`;
        const session = launch(postgres.containerName, { ...environment, ...override });
        try {
          await session.expectStartupFailure(event, category);
        } finally {
          await session.close();
        }
      }
      phase = 'missing migration assets';
      const missingMigrations = launch(postgres.containerName, environment, true);
      try {
        await missingMigrations.expectStartupFailure('mcp.startup_failed', 'CONNECTION');
      } finally {
        await missingMigrations.close();
      }
    } finally {
      await database.close();
    }
  } finally {
    await postgres.close();
  }
  process.stderr.write(
    `Container smoke passed: ${imageId}; Node ${artifact.node}; ${artifact.migrations} migration files; eight tools; EOF/SIGINT/SIGTERM; six safe startup rejections; no application listeners.\n`,
  );
}

try {
  await run();
} catch {
  process.stderr.write(
    `Container smoke failed during ${phase}. Runtime secrets and raw errors are omitted.\n`,
  );
  process.exitCode = 1;
}
