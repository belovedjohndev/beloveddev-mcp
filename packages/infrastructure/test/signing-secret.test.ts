import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseMcpEnvironment } from '../src/environment.js';
import { SignedCursorCodec } from '../src/signed-cursor.js';
import { isValidCursorSecret } from '../src/signing-secret.js';

const key = createHash('sha256')
  .update('deterministic test fixture, not an operator key')
  .digest('hex');

describe('cursor signing-secret policy', () => {
  it('accepts a printable CSPRNG-style encoding at both boundaries', () => {
    expect(isValidCursorSecret(key.slice(0, 32))).toBe(true);
    expect(isValidCursorSecret(key)).toBe(true);
  });

  it.each([
    '',
    key.slice(0, 31),
    'x'.repeat(32),
    'a'.repeat(1024),
    'abcdefgh'.repeat(8),
    '0123456789abcdef'.repeat(4),
    'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS',
    'change-me-before-use-with-at-least-32-characters',
    'your-secret-signing-key-with-at-least-32-characters',
    ` ${key}`,
    `${key}\n`,
    `${key}\0`,
    `${key}\u200b`,
    'é'.repeat(600),
    key + 'a'.repeat(1024),
  ])('rejects weak or malformed input without returning its contents (%#)', (secret) => {
    expect(isValidCursorSecret(secret)).toBe(false);
    expect(() => new SignedCursorCodec(secret)).toThrow('Cursor signing key is invalid.');
    expect(() =>
      parseMcpEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost/database',
        MCP_AUTH_MODE: 'local',
        MCP_CURSOR_SECRET: secret,
      }),
    ).toThrow('Invalid environment variables: MCP_CURSOR_SECRET');
  });
});
