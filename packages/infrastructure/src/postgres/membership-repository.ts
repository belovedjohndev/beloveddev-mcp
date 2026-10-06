import type { MembershipRepository } from '@beloveddev/application/repositories';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { tenantMemberships, tenants, users } from '@beloveddev/database/schema';
import { and, eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  getActiveByUser({ tenantId, userId }: Parameters<MembershipRepository['getActiveByUser']>[0]) {
    return repositoryQuery(async () => {
      const [result] = await this.database
        .select({ membership: tenantMemberships })
        .from(tenantMemberships)
        .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .where(
          and(
            eq(tenantMemberships.tenantId, tenantId),
            eq(tenantMemberships.userId, userId),
            eq(tenantMemberships.status, 'active'),
            eq(tenants.status, 'active'),
            eq(users.status, 'active'),
          ),
        )
        .limit(1);
      return result?.membership ?? null;
    });
  }

  getByUser({ tenantId, userId }: Parameters<MembershipRepository['getByUser']>[0]) {
    return repositoryQuery(async () => {
      const [membership] = await this.database
        .select()
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
        .limit(1);
      return membership ?? null;
    });
  }
}
