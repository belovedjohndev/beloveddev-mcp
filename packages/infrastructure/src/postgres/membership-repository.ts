import type { MembershipRepository } from '@beloveddev/application/repositories';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { tenantMemberships } from '@beloveddev/database/schema';
import { and, eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly database: RepositoryDatabase) {}

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
