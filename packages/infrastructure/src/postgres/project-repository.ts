import type {
  NewProject,
  ProjectListQuery,
  ProjectPageQuery,
  ProjectRepository,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projects, clients } from '@beloveddev/database/schema';
import { and, asc, eq, gt, ilike, or } from 'drizzle-orm';
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

  async listPage(input: ProjectPageQuery) {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.query !== undefined && (input.query.trim().length === 0 || input.query.length > 200))
    ) {
      throw new RepositoryError('INVALID_INPUT');
    }
    // Escape LIKE metacharacters: this is a literal substring filter, not a search language.
    const pattern =
      input.query === undefined ? undefined : '%' + input.query.replace(/[\\%_]/g, '\\$&') + '%';
    return repositoryQuery(async () => {
      const rows = await this.database
        .select({
          project: projects,
          client: { id: clients.id, name: clients.name },
        })
        .from(projects)
        .leftJoin(
          clients,
          and(eq(clients.id, projects.clientId), eq(clients.tenantId, projects.tenantId)),
        )
        .where(
          and(
            eq(projects.tenantId, input.tenantId),
            input.status === undefined ? undefined : eq(projects.status, input.status),
            input.clientId === undefined ? undefined : eq(projects.clientId, input.clientId),
            pattern === undefined
              ? undefined
              : or(ilike(projects.name, pattern), ilike(projects.summary, pattern)),
            input.after === undefined ? undefined : gt(projects.id, input.after.id),
          ),
        )
        .orderBy(asc(projects.id))
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit);
      const last = items.at(-1);
      return {
        items,
        nextPosition: rows.length > input.limit && last ? { id: last.project.id } : null,
      };
    });
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
