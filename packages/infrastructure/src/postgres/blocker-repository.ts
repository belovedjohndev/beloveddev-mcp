import type { BlockerRepository, OpenBlockersQuery } from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projectBlockers } from '@beloveddev/database/schema';
import { and, asc, eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresBlockerRepository implements BlockerRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listOpen(input: OpenBlockersQuery) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(() =>
      this.database
        .select()
        .from(projectBlockers)
        .where(
          and(
            eq(projectBlockers.tenantId, input.tenantId),
            eq(projectBlockers.status, 'open'),
            input.projectId === undefined
              ? undefined
              : eq(projectBlockers.projectId, input.projectId),
            input.severity === undefined ? undefined : eq(projectBlockers.severity, input.severity),
          ),
        )
        .orderBy(asc(projectBlockers.blockedSince), asc(projectBlockers.id))
        .limit(input.limit),
    );
  }
}
