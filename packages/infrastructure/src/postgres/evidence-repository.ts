import type {
  EvidenceRepository,
  ProjectKnowledgeQuery,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projectEvidence } from '@beloveddev/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listByProject(input: ProjectKnowledgeQuery) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(() =>
      this.database
        .select()
        .from(projectEvidence)
        .where(
          and(
            eq(projectEvidence.tenantId, input.tenantId),
            eq(projectEvidence.projectId, input.projectId),
          ),
        )
        .orderBy(
          sql`${projectEvidence.createdAt} DESC NULLS LAST`,
          sql`${projectEvidence.id} DESC NULLS LAST`,
        )
        .limit(input.limit),
    );
  }
}
