import type { ProjectRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import type { CursorCodec, ProjectPosition } from '../pagination.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { listProjectsInput, parseReadInput } from '../read-inputs.js';

export class ListProjects {
  constructor(
    private readonly projects: Pick<ProjectRepository, 'listPage'>,
    private readonly authorization: AuthorizationPolicy,
    private readonly cursors: CursorCodec,
  ) {}
  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'projects:read');
    const values = parseReadInput(listProjectsInput, input);
    return applicationOperation(async () => {
      let after: ProjectPosition | undefined;
      if (values.cursor !== undefined) {
        const cursor = this.cursors.decode(values.cursor);
        if (
          cursor.kind !== 'projects' ||
          cursor.tenantId !== scope.tenantId ||
          cursor.status !== (values.status ?? null) ||
          cursor.clientId !== (values.clientId ?? null) ||
          cursor.query !== (values.query ?? null)
        )
          throw new ApplicationError('VALIDATION_ERROR');
        after = cursor.position;
      }
      const page = await this.projects.listPage({
        tenantId: scope.tenantId,
        limit: values.limit,
        ...(values.status === undefined ? {} : { status: values.status }),
        ...(values.clientId === undefined ? {} : { clientId: values.clientId }),
        ...(values.query === undefined ? {} : { query: values.query }),
        ...(after === undefined ? {} : { after }),
      });
      return {
        projects: page.items.map(({ project, client }) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          summary: project.summary,
          status: project.status,
          client,
          stack: project.stack,
          startedAt: project.startedAt?.toISOString() ?? null,
          completedAt: project.completedAt?.toISOString() ?? null,
        })),
        ...(page.nextPosition === null
          ? {}
          : {
              nextCursor: this.cursors.encode({
                version: 1,
                kind: 'projects',
                tenantId: scope.tenantId,
                status: values.status ?? null,
                clientId: values.clientId ?? null,
                query: values.query ?? null,
                position: page.nextPosition,
              }),
            }),
      };
    });
  }
}
