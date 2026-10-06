import { describe, expect, it, vi } from 'vitest';
import type { Membership } from '@beloveddev/domain/entities';
import { RepositoryError } from '@beloveddev/application/repository-error';
import { fixtureId } from '@beloveddev/test-support/read-fixtures';
import { LocalRequestContextProvider } from '../src/local-request-context.js';
const principal = { tenantId: fixtureId(1), userId: fixtureId(2) };
const membership: Membership = {
  ...principal,
  id: fixtureId(3),
  role: 'viewer',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
describe('operator-configured local request context', () => {
  it('does not look up memberships without a configured principal', async () => {
    const getActiveByUser = vi.fn(() => Promise.resolve(membership));
    expect(
      await new LocalRequestContextProvider(null, { getActiveByUser }).resolve(fixtureId(4)),
    ).toBeNull();
    expect(getActiveByUser).not.toHaveBeenCalled();
  });
  it.each(['owner', 'member', 'viewer'] as const)(
    'resolves %s from active membership, with read permissions',
    async (role) => {
      const getActiveByUser = vi.fn(() => Promise.resolve({ ...membership, role }));
      const result = await new LocalRequestContextProvider(principal, { getActiveByUser }).resolve(
        fixtureId(4),
      );
      expect(getActiveByUser).toHaveBeenCalledWith(principal);
      expect(result).toEqual({
        ...principal,
        requestId: fixtureId(4),
        membershipId: membership.id,
        role,
        permissions: ['profile:read', 'projects:read'],
      });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );
  it.each([
    null,
    { ...membership, status: 'inactive' as const },
    { ...membership, tenantId: fixtureId(9) },
    { ...membership, userId: fixtureId(9) },
  ])('rejects missing, inactive, or mismatched memberships', async (value) => {
    expect(
      await new LocalRequestContextProvider(principal, {
        getActiveByUser: () => Promise.resolve(value),
      }).resolve(fixtureId(4)),
    ).toBeNull();
  });
  it('rechecks membership and role on every invocation', async () => {
    const getActiveByUser = vi
      .fn<() => Promise<Membership | null>>()
      .mockResolvedValueOnce(membership)
      .mockResolvedValueOnce(null);
    const provider = new LocalRequestContextProvider(principal, { getActiveByUser });
    expect(await provider.resolve(fixtureId(4))).not.toBeNull();
    expect(await provider.resolve(fixtureId(5))).toBeNull();
    expect(getActiveByUser).toHaveBeenCalledTimes(2);
  });
  it('maps membership infrastructure failures safely', async () => {
    const provider = new LocalRequestContextProvider(principal, {
      getActiveByUser: () => Promise.reject(new RepositoryError('UNAVAILABLE')),
    });
    await expect(provider.resolve(fixtureId(4))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
