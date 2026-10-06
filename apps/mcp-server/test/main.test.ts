import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const cursorSecret = 'private-cursor-secret-for-tests-only-123456789';

function runServer(overrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [entrypoint], {
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
  });
}

describe('stdio composition root', () => {
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
