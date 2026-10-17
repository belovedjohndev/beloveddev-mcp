import type { ConnectionOptions } from 'node:tls';
import type { PoolConfig } from 'pg';

export class DatabasePolicyError extends Error {
  constructor() {
    super('The database connection policy is invalid.');
    this.name = 'DatabasePolicyError';
  }
}

/** Explicit connection fields prevent URL and PG* environment overrides of security settings. */
export function databaseConnectionConfig(connectionString: string, tlsCa?: string): PoolConfig {
  try {
    if (connectionString !== connectionString.trim()) throw new DatabasePolicyError();
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash !== '')
      throw new DatabasePolicyError();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port === '' ? 5432 : Number(url.port);
    if (
      !host ||
      !user ||
      !password ||
      !database ||
      database.includes('/') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new DatabasePolicyError();
    if ([host, user, password, database].some((value) => value.includes('\0')))
      throw new DatabasePolicyError();
    const seen = new Set<string>();
    for (const [key] of url.searchParams) {
      if (!['sslmode', 'application_name'].includes(key) || seen.has(key))
        throw new DatabasePolicyError();
      seen.add(key);
    }
    const local = ['localhost', '127.0.0.1', '::1'].includes(host);
    const mode = url.searchParams.get('sslmode');
    if (mode !== null && mode !== 'disable' && mode !== 'verify-full')
      throw new DatabasePolicyError();
    if ((!local || tlsCa !== undefined) && mode !== 'verify-full') throw new DatabasePolicyError();
    const applicationName = url.searchParams.get('application_name') ?? 'beloveddev';
    if (
      !applicationName ||
      applicationName.length > 63 ||
      [...applicationName].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new DatabasePolicyError();
    const ssl: ConnectionOptions | false =
      mode === 'verify-full'
        ? {
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            ...(tlsCa === undefined ? {} : { ca: tlsCa }),
          }
        : false;
    return {
      // Plaintext localhost never depends on DNS/hosts-file resolution to stay local.
      host: host === 'localhost' && ssl === false ? '127.0.0.1' : host,
      port,
      user,
      password,
      database,
      ssl,
      application_name: applicationName,
      // pg_catalog is searched implicitly before public. Making it explicit as
      // the first entry would incorrectly target unqualified migration CREATEs.
      options: '-c search_path=public',
    };
  } catch {
    throw new DatabasePolicyError();
  }
}
