import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));

function runBootstrap(overrides: Record<string, string | undefined> = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://user:private-password@127.0.0.1/beloveddev',
    ...overrides,
  };
  return spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8', timeout: 15_000 });
}

describe('composition root', () => {
  it('validates configuration, writes JSON to stderr, leaves stdout empty, and exits', () => {
    const result = runBootstrap();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const record: unknown = JSON.parse(result.stderr);
    expect(record).toMatchObject({ event: 'foundation.ready', environment: 'test' });
    expect(result.stderr).not.toContain('private-password');
  });

  it.each([
    { DATABASE_URL: undefined },
    { DATABASE_URL: 'invalid-private-url' },
    { LOG_LEVEL: 'invalid-private-level' },
    { NODE_ENV: 'invalid-private-environment' },
    { DATABASE_URL: undefined, LOG_LEVEL: 'silent' },
  ])('fails safely for invalid configuration: %j', (overrides) => {
    const result = runBootstrap(overrides);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const record: unknown = JSON.parse(result.stderr);
    expect(record).toMatchObject({
      event: 'configuration.invalid',
    });
    expect(record).toHaveProperty('invalidVariables', expect.arrayContaining([expect.any(String)]));
    expect(result.stderr).not.toContain('private-');
    expect(result.stderr).not.toContain('stack');
    expect(result.stderr).not.toContain(entrypoint);
  });
});
