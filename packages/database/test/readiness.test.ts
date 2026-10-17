import { Pool, type PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRuntimeDatabaseReady, DATABASE_READINESS_TIMEOUT_MS } from '../src/readiness.js';

afterEach(() => vi.useRealTimers());

describe('bounded database readiness', () => {
  it('bounds connection acquisition and destroys a connection arriving after the deadline', async () => {
    vi.useFakeTimers();
    const pool = new Pool();
    const acquisition: { connect: () => Promise<PoolClient> } = pool;
    let connected: ((client: PoolClient) => void) | undefined;
    vi.spyOn(acquisition, 'connect').mockImplementation(
      () =>
        new Promise<PoolClient>((resolve) => {
          connected = resolve;
        }),
    );
    const release = vi.fn();
    // Only lifecycle coordination is mocked; PostgreSQL security checks use real databases.
    const query = vi.fn();
    const client = { release, query } as unknown as PoolClient;
    const result = expect(assertRuntimeDatabaseReady(pool)).rejects.toMatchObject({
      category: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(DATABASE_READINESS_TIMEOUT_MS);
    await result;
    connected?.(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('destroys a checked-out client when a query stalls, and does not release it twice', async () => {
    vi.useFakeTimers();
    const pool = new Pool();
    const acquisition: { connect: () => Promise<PoolClient> } = pool;
    let rejectQuery: ((error: Error) => void) | undefined;
    const release = vi.fn();
    const query = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectQuery = reject;
        }),
    );
    const client = { release, query } as unknown as PoolClient;
    vi.spyOn(acquisition, 'connect').mockImplementation(() => Promise.resolve(client));
    const result = expect(assertRuntimeDatabaseReady(pool)).rejects.toMatchObject({
      category: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(DATABASE_READINESS_TIMEOUT_MS);
    await result;
    rejectQuery?.(new Error('private-driver-failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('replaces connection errors with a static safe diagnostic', async () => {
    const pool = new Pool();
    vi.spyOn(pool, 'connect').mockRejectedValue(new Error('private-password internal-host'));
    await expect(assertRuntimeDatabaseReady(pool)).rejects.toMatchObject({
      category: 'CONNECTION',
      message: 'Database operational readiness failed.',
    });
  });
});
