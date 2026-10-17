import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTlsPostgres } from '@beloveddev/test-support/tls-database';
import { createTestDatabase } from '@beloveddev/test-support/test-database';
import { openDatabase } from '../src/client.js';
import { assertRuntimeDatabaseReady } from '../src/readiness.js';

describe('PostgreSQL TLS transport', () => {
  let tls: Awaited<ReturnType<typeof createTlsPostgres>>;
  beforeAll(async () => {
    tls = await createTlsPostgres();
  }, 90_000);
  afterAll(async () => {
    if (tls !== undefined) await tls.close();
  });

  it('verifies a trusted server certificate and completes runtime readiness over TLS', async () => {
    const database = await createTestDatabase(tls.url, { mcpRuntime: true, tlsCa: tls.ca });
    try {
      await assertRuntimeDatabaseReady(database.runtime.pool);
      const result = await database.runtime.pool.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
      );
      expect(result.rows).toEqual([{ ssl: true }]);
    } finally {
      await database.close();
    }
  });

  it('rejects an untrusted server certificate rather than downgrading', async () => {
    const connection = openDatabase(tls.url, { onIdleError: () => {} });
    try {
      await expect(connection.pool.query('SELECT 1')).rejects.toThrow();
    } finally {
      await connection.close();
    }
  });

  it('rejects a valid certificate for the wrong host', async () => {
    const url = new URL(tls.url);
    url.hostname = '127.0.0.1'; // Certificate deliberately covers DNS:localhost only.
    const connection = openDatabase(url.href, { tlsCa: tls.ca, onIdleError: () => {} });
    try {
      await expect(connection.pool.query('SELECT 1')).rejects.toMatchObject({
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
    } finally {
      await connection.close();
    }
  });
});
