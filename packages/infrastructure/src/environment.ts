import { z } from 'zod';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.string().refine((value) => {
    if (value !== value.trim() || !URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash.length === 0
    );
  }),
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
    // Discard Zod's errors so no raw configuration or credentials escape.
    throw new EnvironmentValidationError([...new Set(fields)].sort());
  }
  return Object.freeze(result.data);
}
