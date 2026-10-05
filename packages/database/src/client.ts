import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type RepositoryDatabase = Pick<Database, 'select' | 'insert'>;

export function openDatabase(
  connectionString: string,
  options: { onIdleError: () => void; maxConnections?: number },
) {
  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  // pg emits idle-client failures outside query promises. The caller owns diagnostics.
  pool.on('error', options.onIdleError);
  return {
    db: drizzle({ client: pool, schema }),
    pool,
    close: () => pool.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
