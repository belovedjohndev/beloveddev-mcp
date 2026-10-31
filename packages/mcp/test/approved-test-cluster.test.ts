import { afterEach, expect, it, vi } from 'vitest';
import * as database from '@beloveddev/database/client';
import { approveTestCluster, approvedClusterUrl } from './approved-test-cluster.js';

const identity = {
  administratorUrl: 'postgresql://test:private-password@127.0.0.1:15432/postgres',
  systemIdentifier: '1234567890',
  marker: '11111111-1111-4111-8111-111111111111',
};
afterEach(() => vi.restoreAllMocks());
it.each([
  { administratorUrl: 'postgresql://test:secret@production.example:5432/postgres' },
  { administratorUrl: 'postgresql://test:secret@localhost:5432/postgres' },
  { administratorUrl: 'postgresql://test:secret@127.0.0.1/postgres' },
  { administratorUrl: identity.administratorUrl + '?host=production.example' },
  { administratorUrl: 'postgresql://test:secret@127.0.0.1:5432/production' },
  { systemIdentifier: undefined },
  { marker: undefined },
  { syntheticDataOnly: true },
])(
  'rejects unsafe or incomplete operator configuration without connecting: %j',
  async (changed) => {
    const open = vi.spyOn(database, 'openDatabase');
    await expect(approveTestCluster({ ...identity, ...changed })).rejects.toThrow('setup_failed');
    expect(open).not.toHaveBeenCalled();
  },
);
it('rejects unknown capabilities before connecting', async () => {
  const open = vi.spyOn(database, 'openDatabase');
  await expect(approvedClusterUrl({} as Parameters<typeof approvedClusterUrl>[0])).rejects.toThrow(
    'setup_failed',
  );
  expect(open).not.toHaveBeenCalled();
});
