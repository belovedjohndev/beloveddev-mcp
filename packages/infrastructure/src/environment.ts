import { z } from 'zod';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const databaseUrlSchema = z.string().refine((value) => {
  if (value !== value.trim() || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.hostname.length > 0 &&
    url.pathname.length > 1 &&
    url.hash.length === 0
  );
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: databaseUrlSchema,
});

export type Environment = Readonly<z.infer<typeof environmentSchema>>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export class EnvironmentValidationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Invalid environment variables: ${fields.join(', ')}`);
    this.name = 'EnvironmentValidationError';
    this.fields = Object.freeze([...fields]);
  }
}

export function parseEnvironment(input: Readonly<Record<string, string | undefined>>): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path[0])
      .filter((field): field is string => typeof field === 'string');
    throw new EnvironmentValidationError([...new Set(fields)].sort());
  }
  return Object.freeze(result.data);
}

export function parseTestDatabaseUrl(input: Readonly<Record<string, string | undefined>>): string {
  // Never fall back to the application's DATABASE_URL for administrative test operations.
  const result = databaseUrlSchema.safeParse(input['TEST_DATABASE_URL']);
  if (!result.success) throw new EnvironmentValidationError(['TEST_DATABASE_URL']);
  return result.data;
}

const mcpEnvironmentSchema = environmentSchema
  .extend({
    MCP_AUTH_MODE: z.literal('local'),
    MCP_LOCAL_TENANT_ID: z.uuid().optional(),
    MCP_LOCAL_USER_ID: z.uuid().optional(),
    MCP_CURSOR_SECRET: z.string().min(32).max(1024),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        path: ['MCP_AUTH_MODE'],
        message: 'Local identity is unavailable in production.',
      });
    }
    if ((value.MCP_LOCAL_TENANT_ID === undefined) !== (value.MCP_LOCAL_USER_ID === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['MCP_LOCAL_TENANT_ID'],
        message: 'Configure both identity fields or neither.',
      });
      context.addIssue({
        code: 'custom',
        path: ['MCP_LOCAL_USER_ID'],
        message: 'Configure both identity fields or neither.',
      });
    }
  });

export function parseMcpEnvironment(input: Readonly<Record<string, string | undefined>>) {
  const result = mcpEnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new EnvironmentValidationError(
      [
        ...new Set(
          result.error.issues
            .map((issue) => issue.path[0])
            .filter((field): field is string => typeof field === 'string'),
        ),
      ].sort(),
    );
  }
  return Object.freeze(result.data);
}
