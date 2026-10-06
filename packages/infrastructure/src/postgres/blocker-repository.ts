import type {
  BlockerPageQuery,
  BlockerRepository,
  OpenBlockersQuery,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projectBlockers, projects } from '@beloveddev/database/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresBlockerRepository implements BlockerRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listOpenPage(input: BlockerPageQuery) {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.after !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input.after.blockedSince) ||
          !Number.isFinite(Date.parse(input.after.blockedSince))))
    ) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(async () => {
      const rows = await this.database
        .select({
          blocker: projectBlockers,
          projectName: projects.name,
          positionTime: sql<string>`to_char(${projectBlockers.blockedSince} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(projectBlockers)
        .innerJoin(
          projects,
          and(
            eq(projects.id, projectBlockers.projectId),
            eq(projects.tenantId, projectBlockers.tenantId),
          ),
        )
        .where(
          and(
            eq(projectBlockers.tenantId, input.tenantId),
            eq(projectBlockers.status, 'open'),
            input.projectId === undefined
              ? undefined
              : eq(projectBlockers.projectId, input.projectId),
            input.severity === undefined ? undefined : eq(projectBlockers.severity, input.severity),
            input.after === undefined
              ? undefined
              : sql`(${projectBlockers.blockedSince}, ${projectBlockers.id}) > (${input.after.blockedSince}::timestamptz, ${input.after.id}::uuid)`,
          ),
        )
        .orderBy(asc(projectBlockers.blockedSince), asc(projectBlockers.id))
        .limit(input.limit + 1);
      const selected = rows.slice(0, input.limit);
      const last = selected.at(-1);
      return {
        items: selected.map(({ blocker, projectName }) => ({ blocker, projectName })),
        nextPosition:
          rows.length > input.limit && last
            ? { id: last.blocker.id, blockedSince: last.positionTime }
            : null,
      };
    });
  }

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
