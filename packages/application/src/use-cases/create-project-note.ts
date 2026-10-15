import type { ProjectNote } from '@beloveddev/domain/entities';
import { ApplicationError, applicationOperation } from '../application-error.js';
import type { ProjectNoteCreationRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import { createProjectNoteInput } from '../write-inputs.js';

export interface CreateProjectNoteResult {
  readonly note: Pick<ProjectNote, 'id' | 'projectId' | 'category' | 'content'> & {
    readonly createdAt: string;
  };
  readonly created: boolean;
}

export class CreateProjectNote {
  constructor(
    private readonly repository: ProjectNoteCreationRepository,
    private readonly authorization: AuthorizationPolicy,
  ) {}

  async execute(context: RequestContext | null, input: unknown): Promise<CreateProjectNoteResult> {
    const scope = this.authorization.require(context, 'project_notes:create');
    const parsed = createProjectNoteInput.safeParse(input);
    if (!parsed.success) throw new ApplicationError('VALIDATION_ERROR');

    return applicationOperation(async () => {
      const result = await this.repository.create({
        ...parsed.data,
        tenantId: scope.tenantId,
        authorUserId: scope.userId,
        requestId: scope.requestId,
      });
      if (result === null) throw new ApplicationError('NOT_FOUND');
      const { id, projectId, category, content, createdAt } = result.note;
      return {
        note: { id, projectId, category, content, createdAt: createdAt.toISOString() },
        created: result.created,
      };
    });
  }
}
