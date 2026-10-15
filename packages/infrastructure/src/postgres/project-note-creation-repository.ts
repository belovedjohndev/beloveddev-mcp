import type {
  ProjectNoteCreationInput,
  ProjectNoteCreationRepository,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { Database } from '@beloveddev/database/client';
import { auditLogs, projectNotes, projects } from '@beloveddev/database/schema';
import { matchesProjectNotePayload } from '@beloveddev/domain/project-note';
import { and, eq } from 'drizzle-orm';

export class PostgresProjectNoteCreationRepository implements ProjectNoteCreationRepository {
  constructor(private readonly database: Pick<Database, 'transaction'>) {}

  async create(input: ProjectNoteCreationInput) {
    try {
      return await this.database.transaction(
        async (transaction) => {
          const [project] = await transaction
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.tenantId, input.tenantId), eq(projects.id, input.projectId)))
            .limit(1);
          if (project === undefined) return null;

          const [inserted] = await transaction
            .insert(projectNotes)
            .values({
              tenantId: input.tenantId,
              projectId: project.id,
              authorUserId: input.authorUserId,
              category: input.category,
              content: input.content,
              idempotencyKey: input.idempotencyKey,
            })
            .onConflictDoNothing({
              target: [
                projectNotes.tenantId,
                projectNotes.authorUserId,
                projectNotes.idempotencyKey,
              ],
            })
            .returning();

          if (inserted === undefined) {
            // The unique index waits for the winner to commit/roll back. A separate
            // READ COMMITTED statement observes that committed note, even when
            // the INSERT snapshot predated the winner. No update privileges needed.
            const [existing] = await transaction
              .select()
              .from(projectNotes)
              .where(
                and(
                  eq(projectNotes.tenantId, input.tenantId),
                  eq(projectNotes.authorUserId, input.authorUserId),
                  eq(projectNotes.idempotencyKey, input.idempotencyKey),
                ),
              )
              .limit(1);
            if (existing === undefined) throw new RepositoryError('UNAVAILABLE');
            // UUID input may use uppercase; compare the verified PostgreSQL identity.
            if (!matchesProjectNotePayload(existing, { ...input, projectId: project.id }))
              throw new RepositoryError('CONFLICT');
            return { note: existing, created: false };
          }

          await transaction.insert(auditLogs).values({
            tenantId: input.tenantId,
            actorUserId: input.authorUserId,
            action: 'project_note.created',
            resourceType: 'project_note',
            resourceId: inserted.id,
            requestId: input.requestId,
            metadata: { projectId: project.id, category: input.category },
          });
          return { note: inserted, created: true };
        },
        { isolationLevel: 'read committed', accessMode: 'read write' },
      );
    } catch (error: unknown) {
      if (error instanceof RepositoryError) throw error;
      // Input has already passed application validation. Storage/audit failures
      // are internal failures, not user validation errors or key conflicts.
      throw new RepositoryError('UNAVAILABLE');
    }
  }
}
