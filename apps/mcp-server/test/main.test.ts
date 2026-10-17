import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cursorSecret = 'private-cursor-secret-for-tests-only-123456789';

function runServer(
  overrides: Record<string, string | undefined> = {},
  launch: {
    args?: string[];
    cwd?: string;
    readiness?: 'ready' | 'pending' | 'failed';
    signalWhileProbing?: 'SIGINT' | 'SIGTERM';
  } = {},
) {
  // Bootstrap unit tests isolate the read-only readiness probe. Real PostgreSQL
  // and exact unmodified launchers are covered by the stdio integration suite.
  const replacement = `data:text/javascript,${encodeURIComponent(`
    export { DatabaseReadinessError } from ${JSON.stringify(new URL('../../../packages/database/dist/readiness.js', import.meta.url).href)};
    export function assertRuntimeDatabaseReady() {
      ${launch.signalWhileProbing === undefined ? '' : `queueMicrotask(() => process.emit('${launch.signalWhileProbing}'));`}
      ${launch.readiness === 'pending' ? 'return new Promise(() => {});' : launch.readiness === 'failed' ? "return Promise.reject(new Error('private-database-failure'));" : 'return Promise.resolve();'}
    }
  `)}`;
  const preload = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      return specifier === '@beloveddev/database/readiness'
        ? { url: ${JSON.stringify(replacement)}, shortCircuit: true }
        : nextResolve(specifier, context);
    } });
  `)}`;
  return spawnSync(process.execPath, [`--import=${preload}`, ...(launch.args ?? [entrypoint])], {
    cwd: launch.cwd ?? root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://user:private-password@127.0.0.1/beloveddev',
      MCP_AUTH_MODE: 'local',
      MCP_CURSOR_SECRET: cursorSecret,
      MCP_LOCAL_TENANT_ID: undefined,
      MCP_LOCAL_USER_ID: undefined,
      ...overrides,
    },
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
}

describe('stdio composition root', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('handles %s while readiness is pending', (signal) => {
    const result = runServer({}, { readiness: 'pending', signalWhileProbing: signal });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`"reason":"${signal}"`);
    expect(result.stderr).not.toContain('mcp.ready');
    expect(result.stderr).not.toContain('mcp.startup_failed');
  });
  it('does not declare readiness and exits safely when the startup probe fails', () => {
    const result = runServer({}, { readiness: 'failed' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('mcp.startup_failed');
    expect(result.stderr).not.toContain('mcp.ready');
    expect(result.stderr).not.toContain('private-');
  });

  it('handles stdin EOF while readiness is pending without claiming readiness', () => {
    const result = runServer({}, { readiness: 'pending' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('transport_closed');
    expect(result.stderr).not.toContain('mcp.ready');
    expect(result.stderr).not.toContain('mcp.startup_failed');
  });
  it('closes a partially started wire and database when serveStdio fails before returning a handle', () => {
    const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
    const dataModule = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
    // Node 24 hooks inject only this subprocess's failure, without production test flags.
    const sdk = dataModule(`
      import { StdioServerTransport as Original } from ${JSON.stringify(moduleUrl('../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))};
      export class StdioServerTransport extends Original {
        async close() {
          await super.close();
          process.stderr.write(JSON.stringify({ event: 'test.transport_closed' }) + '\\n');
        }
      }
      export function serveStdio(_factory, { transport }) {
        transport.start().catch(() => {});
        throw new Error('private-startup-failure-with-internal-path');
      }
    `);
    const database = dataModule(`
      export * from ${JSON.stringify(moduleUrl('../../../packages/database/dist/client.js'))};
      import { openDatabase as original } from ${JSON.stringify(moduleUrl('../../../packages/database/dist/client.js'))};
      export function openDatabase(...args) {
        const database = original(...args);
        return { ...database, close: async () => {
          await database.close();
          process.stderr.write(JSON.stringify({ event: 'test.database_closed' }) + '\\n');
        } };
      }
    `);
    const preload = dataModule(`
      import { registerHooks } from 'node:module';
      const replacements = new Map(${JSON.stringify([
        ['@modelcontextprotocol/server/stdio', sdk],
        ['@beloveddev/database/client', database],
      ])});
      registerHooks({ resolve(specifier, context, nextResolve) {
        const url = replacements.get(specifier);
        return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
      } });
    `);
    const result = runServer({}, { args: [`--import=${preload}`, entrypoint] });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const records: { event: string; reason?: string; exitCode?: number }[] = result.stderr
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event: string });
    for (const event of [
      'mcp.startup_failed',
      'mcp.stopping',
      'test.transport_closed',
      'test.database_closed',
      'mcp.stopped',
    ]) {
      expect(records.filter((record) => record.event === event)).toHaveLength(1);
    }
    expect(records).toContainEqual(
      expect.objectContaining({ event: 'mcp.stopping', reason: 'startup_error' }),
    );
    expect(records).toContainEqual(expect.objectContaining({ event: 'mcp.stopped', exitCode: 1 }));
    expect(records.some((record) => record.event === 'mcp.ready')).toBe(false);
    expect(result.stderr).not.toContain('private-');
    expect(result.stderr).not.toContain('stack');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'routes repeated %s process events through one graceful shutdown',
    (signal) => {
      // Windows cannot deliver catchable POSIX signals with child.kill(). Emit the
      // real process event after importing the compiled entry point instead.
      const moduleUrl = new URL('../dist/main.js', import.meta.url).href;
      const source = `await import(${JSON.stringify(moduleUrl)}); process.emit('${signal}'); process.emit('${signal}');`;
      const result = runServer({}, { args: ['--input-type=module', '--eval', source] });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const records: unknown[] = result.stderr
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as unknown);
      expect(records).toEqual([
        expect.objectContaining({ event: 'mcp.ready' }),
        expect.objectContaining({ event: 'mcp.stopping', reason: signal }),
        expect.objectContaining({ event: 'mcp.stopped', exitCode: 0 }),
      ]);
      expect(result.stderr).not.toContain('private-');
    },
  );

  it('starts with valid configuration and closes on stdin EOF without writing non-protocol stdout', () => {
    const result = runServer();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const records: unknown[] = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([
      expect.objectContaining({
        event: 'mcp.ready',
        environment: 'test',
        transport: 'stdio',
        authMode: 'local',
      }),
      expect.objectContaining({ event: 'mcp.stopping', reason: 'transport_closed' }),
      expect.objectContaining({ event: 'mcp.stopped' }),
    ]);
    expect(result.stderr).not.toContain('private-');
  });

  it('honors the existing silent log setting without using stdout', () => {
    const result = runServer({ LOG_LEVEL: 'silent' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['DATABASE_URL', undefined],
    ['DATABASE_URL', 'invalid-private-url'],
    ['LOG_LEVEL', 'invalid-private-level'],
    ['NODE_ENV', 'invalid-private-environment'],
    ['MCP_AUTH_MODE', undefined],
    ['MCP_AUTH_MODE', 'invalid-private-mode'],
    ['MCP_CURSOR_SECRET', undefined],
    ['MCP_CURSOR_SECRET', 'private-too-short'],
    ['MCP_CURSOR_SECRET', 'private-'.repeat(147)],
  ])('fails safely for invalid %s configuration', (key, value) => {
    const result = runServer({ [key ?? '']: value });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const record: unknown = JSON.parse(result.stderr);
    expect(record).toMatchObject({ event: 'configuration.invalid' });
    expect(record).toHaveProperty('invalidVariables', expect.arrayContaining([key]));
    expect(result.stderr).not.toContain('private-');
    expect(result.stderr).not.toContain('stack');
    expect(result.stderr).not.toContain(entrypoint);
  });

  it('still reports configuration failures safely when ordinary logs are disabled', () => {
    const result = runServer({ MCP_CURSOR_SECRET: undefined, LOG_LEVEL: 'silent' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr) as unknown).toMatchObject({ event: 'configuration.invalid' });
  });
});

describe('documented direct Node launcher', () => {
  function expectReady(result: ReturnType<typeof runServer>) {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const records: unknown[] = result.stderr
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([
      expect.objectContaining({ event: 'mcp.ready', authMode: 'local' }),
      expect.objectContaining({ event: 'mcp.stopping', reason: 'transport_closed' }),
      expect.objectContaining({ event: 'mcp.stopped' }),
    ]);
    expect(result.stderr).not.toContain('private-');
  }

  function withEnvironmentFile(
    contents: string,
    operation: (directory: string, path: string) => void,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'beloveddev launcher '));
    const path = join(directory, '.env');
    try {
      writeFileSync(path, contents);
      operation(directory, path);
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  }

  it('resolves the absolute compiled entry point independently of the working directory', () => {
    expectReady(runServer({}, { args: [entrypoint], cwd: tmpdir() }));
  });

  it('does not load an ambient working-directory .env as trusted identity', () => {
    withEnvironmentFile(
      'MCP_LOCAL_TENANT_ID=private-invalid-tenant\nMCP_LOCAL_USER_ID=private-invalid-user\n',
      (directory) => expectReady(runServer({}, { args: [entrypoint], cwd: directory })),
    );
  });

  it('loads an explicitly selected absolute env file from another working directory', () => {
    withEnvironmentFile(
      [
        'DATABASE_URL=postgresql://user:private-file-password@127.0.0.1/beloveddev',
        'MCP_AUTH_MODE=local',
        `MCP_CURSOR_SECRET=${cursorSecret}`,
      ].join('\n'),
      (_directory, path) =>
        expectReady(
          runServer(
            { DATABASE_URL: undefined, MCP_AUTH_MODE: undefined, MCP_CURSOR_SECRET: undefined },
            { args: [`--env-file=${path}`, entrypoint], cwd: tmpdir() },
          ),
        ),
    );
  });

  it('preserves trusted process environment precedence over an explicit env file', () => {
    withEnvironmentFile(
      'NODE_ENV=production\nMCP_AUTH_MODE=private-unsupported-mode\nMCP_CURSOR_SECRET=private-short\n',
      (_directory, path) =>
        expectReady(runServer({}, { args: [`--env-file=${path}`, entrypoint], cwd: tmpdir() })),
    );
  });

  it('fails before bootstrap if an explicitly required env file is missing', () => {
    withEnvironmentFile('', (directory) => {
      const path = join(directory, 'missing-required.env');
      const result = runServer({}, { args: [`--env-file=${path}`, entrypoint], cwd: tmpdir() });
      expect(result.error).toBeUndefined();
      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('mcp.ready');
      expect(result.stderr).not.toContain('private-');
    });
  });

  it.each(['DATABASE_URL', 'MCP_AUTH_MODE', 'MCP_CURSOR_SECRET'])(
    'rejects a required env file missing %s without exposing values',
    (field) => {
      const contents = Object.entries({
        DATABASE_URL: 'postgresql://user:private-file-password@127.0.0.1/beloveddev',
        MCP_AUTH_MODE: 'local',
        MCP_CURSOR_SECRET: cursorSecret,
      })
        .filter(([key]) => key !== field)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      withEnvironmentFile(contents, (_directory, path) => {
        const result = runServer(
          { DATABASE_URL: undefined, MCP_AUTH_MODE: undefined, MCP_CURSOR_SECRET: undefined },
          { args: [`--env-file=${path}`, entrypoint], cwd: tmpdir() },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr) as unknown).toMatchObject({
          event: 'configuration.invalid',
          invalidVariables: [field],
        });
        expect(result.stderr).not.toContain('private-');
      });
    },
  );

  it.each([{ NODE_ENV: 'production' }, { MCP_AUTH_MODE: 'remote' }])(
    'keeps unsupported authentication fail-closed through the launcher: %j',
    (overrides) => {
      const result = runServer(overrides, { args: [entrypoint], cwd: tmpdir() });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr) as unknown).toMatchObject({
        event: 'configuration.invalid',
        invalidVariables: ['MCP_AUTH_MODE'],
      });
      expect(result.stderr).not.toContain('private-');
      expect(result.stderr).not.toContain(entrypoint);
    },
  );
});
