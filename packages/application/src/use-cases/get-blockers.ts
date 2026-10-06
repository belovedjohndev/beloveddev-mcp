import type { BlockerRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import type { BlockerPosition, CursorCodec } from '../pagination.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { getBlockersInput, parseReadInput } from '../read-inputs.js';

export class GetBlockers {
  constructor(
    private readonly blockers: Pick<BlockerRepository, 'listOpenPage'>,
    private readonly authorization: AuthorizationPolicy,
    private readonly cursors: CursorCodec,
  ) {}
  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'projects:read');
    const values = parseReadInput(getBlockersInput, input);
    return applicationOperation(async () => {
      let after: BlockerPosition | undefined;
      if (values.cursor !== undefined) {
        const cursor = this.cursors.decode(values.cursor);
        if (
          cursor.kind !== 'blockers' ||
          cursor.tenantId !== scope.tenantId ||
          cursor.projectId !== (values.projectId ?? null) ||
          cursor.severity !== (values.severity ?? null)
        ) {
          throw new ApplicationError('VALIDATION_ERROR');
        }
        after = cursor.position;
      }
      const page = await this.blockers.listOpenPage({
        tenantId: scope.tenantId,
        limit: values.limit,
        ...(values.projectId === undefined ? {} : { projectId: values.projectId }),
        ...(values.severity === undefined ? {} : { severity: values.severity }),
        ...(after === undefined ? {} : { after }),
      });
      return {
        blockers: page.items.map(({ blocker, projectName }) => ({
          id: blocker.id,
          projectId: blocker.projectId,
          projectName,
          title: blocker.title,
          description: blocker.description,
          severity: blocker.severity,
          blockedSince: blocker.blockedSince.toISOString(),
        })),
        ...(page.nextPosition === null
          ? {}
          : {
              nextCursor: this.cursors.encode({
                version: 1,
                kind: 'blockers',
                tenantId: scope.tenantId,
                projectId: values.projectId ?? null,
                severity: values.severity ?? null,
                position: page.nextPosition,
              }),
            }),
      };
    });
  }
}
