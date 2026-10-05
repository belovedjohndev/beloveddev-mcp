import type { DeveloperProfileRepository } from '@beloveddev/application/repositories';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { developerProfiles } from '@beloveddev/database/schema';
import { eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresDeveloperProfileRepository implements DeveloperProfileRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  getByTenant({ tenantId }: Parameters<DeveloperProfileRepository['getByTenant']>[0]) {
    return repositoryQuery(async () => {
      const [profile] = await this.database
        .select()
        .from(developerProfiles)
        .where(eq(developerProfiles.tenantId, tenantId))
        .limit(1);
      return profile ?? null;
    });
  }
}
