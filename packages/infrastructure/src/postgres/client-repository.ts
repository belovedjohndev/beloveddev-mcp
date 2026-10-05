import type { ClientRepository } from '@beloveddev/application/repositories';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { clients } from '@beloveddev/database/schema';
import { and, eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresClientRepository implements ClientRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  getById({ tenantId, clientId }: Parameters<ClientRepository['getById']>[0]) {
    return repositoryQuery(async () => {
      const [client] = await this.database
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
        .limit(1);
      return client ?? null;
    });
  }
}
