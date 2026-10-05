import type { NoteRepository, ProjectKnowledgeQuery } from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { projectNotes } from '@beloveddev/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { repositoryQuery } from './repository-query.js';

export class PostgresNoteRepository implements NoteRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listRecentByProject(input: ProjectKnowledgeQuery) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(() =>
      this.database
        .select()
        .from(projectNotes)
        .where(
          and(
            eq(projectNotes.tenantId, input.tenantId),
            eq(projectNotes.projectId, input.projectId),
          ),
        )
        .orderBy(
          sql`${projectNotes.createdAt} DESC NULLS LAST`,
          sql`${projectNotes.id} DESC NULLS LAST`,
        )
        .limit(input.limit),
    );
  }
}
