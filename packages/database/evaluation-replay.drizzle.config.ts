import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/database/src/evaluation-replay-schema.ts',
  out: './packages/database/evaluation-replay-migrations',
  strict: true,
  verbose: true,
});
