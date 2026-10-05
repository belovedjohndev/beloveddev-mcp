import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './environment.js';

const sensitiveKeys = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'DATABASE_URL',
  'databaseUrl',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'beloveddev-mcp' },
      redact: {
        paths: [
          ...sensitiveKeys.flatMap((key) => [key, `*.${key}`]),
          'req.headers.authorization',
          'req.headers.cookie',
          'config',
          'env',
        ],
        censor: '[REDACTED]',
      },
    },
    // Synchronous stderr keeps stdout available for MCP and flushes on bootstrap exit.
    destination ?? pino.destination({ dest: 2, sync: true }),
  );
}
