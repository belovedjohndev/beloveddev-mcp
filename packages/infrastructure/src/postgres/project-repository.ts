import type {
  NewProject,
  ProjectListQuery,
  ProjectRepository,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projects } from '@beloveddev/database/schema';
import { and, asc, eq } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  getById({ tenantId, projectId }: Parameters<ProjectRepository['getById']>[0]) {
    return repositoryQuery(async () => {
      const [project] = await this.database
        .select()
        .from(projects)
        .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
        .limit(1);
      return project ?? null;
    });
  }

  async list({ tenantId, status, limit }: ProjectListQuery) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(() =>
      this.database
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.tenantId, tenantId),
            status === undefined ? undefined : eq(projects.status, status),
          ),
        )
        .orderBy(asc(projects.id))
        .limit(limit),
    );
  }

  create(input: NewProject) {
    return repositoryQuery(async () => {
      // One INSERT is atomic. The composite FK prevents same-tenant check/write races.
      const [project] = await this.database
        .insert(projects)
        .values({
          tenantId: input.tenantId,
          clientId: input.clientId,
          name: input.name,
          slug: input.slug,
          summary: input.summary,
          problemStatement: input.problemStatement,
          outcome: input.outcome,
          status: input.status,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          stack: input.stack,
          repositoryUrl: input.repositoryUrl,
          productionUrl: input.productionUrl,
          portfolioUrl: input.portfolioUrl,
        })
        .returning();
      if (!project) throw new RepositoryError('UNAVAILABLE');
      return project;
    });
  }
}
