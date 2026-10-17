import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { databaseConnectionConfig } from './connection-policy.js';
export { DatabasePolicyError } from './connection-policy.js';

export type Database = NodePgDatabase<typeof schema>;
export type RepositoryDatabase = Pick<Database, 'select' | 'insert'>;

export function openDatabase(
  connectionString: string,
  options: {
    onIdleError: () => void;
    onClientError?: () => void;
    maxConnections?: number;
    tlsCa?: string;
  },
) {
  const pool = new Pool({
    ...databaseConnectionConfig(connectionString, options.tlsCa),
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  // pg emits idle-client failures outside query promises. The caller owns diagnostics.
  pool.on('error', options.onIdleError);
  // pg removes its idle error listener while a client is checked out. Drizzle
  // transactions hold such clients: socket failures still emit 'error' in
  // addition to rejecting queries. Always consume that event to avoid raw Node
  // crash diagnostics; the process owner can treat active-client loss as fatal.
  const acquired = new WeakSet<PoolClient>();
  pool.on('acquire', (client) => {
    acquired.add(client);
  });
  pool.on('release', (_error, client) => {
    acquired.delete(client);
  });
  pool.on('connect', (client) => {
    let reported = false;
    client.on('error', () => {
      if (!acquired.has(client) || reported) return;
      reported = true;
      options.onClientError?.();
    });
  });
  return {
    db: drizzle({ client: pool, schema }),
    pool,
    close: () => pool.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
