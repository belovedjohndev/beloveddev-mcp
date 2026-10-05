import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('structured logging', () => {
  it('writes structured records and respects the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger('info', {
      write: (line) => {
        lines.push(line);
      },
    });
    logger.debug({ event: 'hidden' }, 'Filtered message');
    logger.info({ event: 'foundation.ready' }, 'Ready');

    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? '');
    expect(record).toMatchObject({
      level: 30,
      service: 'beloveddev-mcp',
      event: 'foundation.ready',
      msg: 'Ready',
    });
    expect(record).toHaveProperty('time', expect.any(Number));
  });

  it('redacts known secret fields and configuration objects', () => {
    const lines: string[] = [];
    const logger = createLogger('info', {
      write: (line) => {
        lines.push(line);
      },
    });
    logger.info(
      {
        password: 'private-password',
        DATABASE_URL: 'postgresql://private-credentials@localhost/db',
        credentials: { token: 'private-token' },
        req: { headers: { authorization: 'Bearer private-auth', cookie: 'private-cookie' } },
        config: { nested: { secret: 'private-config' } },
        env: { ANOTHER_SECRET: 'private-env' },
      },
      'Safe static message',
    );

    const output = lines.join('');
    expect(output).not.toContain('private-');
    const record: unknown = JSON.parse(output);
    expect(record).toMatchObject({
      password: '[REDACTED]',
      DATABASE_URL: '[REDACTED]',
      credentials: { token: '[REDACTED]' },
      req: { headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' } },
      config: '[REDACTED]',
      env: '[REDACTED]',
    });
  });

  it('supports disabling logs explicitly', () => {
    const lines: string[] = [];
    const logger = createLogger('silent', {
      write: (line) => {
        lines.push(line);
      },
    });
    logger.fatal('Filtered message');
    expect(lines).toEqual([]);
  });
});
