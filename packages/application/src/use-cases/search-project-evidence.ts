import { createHash } from 'node:crypto';
import type { EvidenceRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import type { CursorCodec, EvidenceSearchPosition } from '../pagination.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { parseReadInput, searchProjectEvidenceInput } from '../read-inputs.js';

const uniqueSorted = <T extends string>(
  values: readonly T[] | undefined,
): readonly T[] | undefined => (values === undefined ? undefined : [...new Set(values)].sort());

export class SearchProjectEvidence {
  constructor(
    private readonly evidence: Pick<EvidenceRepository, 'search'>,
    private readonly authorization: AuthorizationPolicy,
    private readonly cursors: CursorCodec,
  ) {}

  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'projects:read');
    const values = parseReadInput(searchProjectEvidenceInput, input);
    const projectIds = uniqueSorted(values.projectIds);
    const evidenceTypes = uniqueSorted(values.evidenceTypes);
    const skills = uniqueSorted(values.skills?.map((skill) => skill.toLowerCase()));
    const queryFingerprint = createHash('sha256')
      .update(JSON.stringify({ query: values.query, projectIds, evidenceTypes, skills }))
      .digest('hex');

    return applicationOperation(async () => {
      let after: EvidenceSearchPosition | undefined;
      if (values.cursor !== undefined) {
        const cursor = this.cursors.decode(values.cursor);
        if (
          cursor.kind !== 'evidence_search' ||
          cursor.tenantId !== scope.tenantId ||
          cursor.queryFingerprint !== queryFingerprint
        )
          throw new ApplicationError('VALIDATION_ERROR');
        after = cursor.position;
      }

      const page = await this.evidence.search({
        tenantId: scope.tenantId,
        query: values.query,
        limit: values.limit,
        ...(projectIds === undefined ? {} : { projectIds }),
        ...(evidenceTypes === undefined ? {} : { evidenceTypes }),
        ...(skills === undefined ? {} : { skills }),
        ...(after === undefined ? {} : { after }),
      });
      return {
        results: page.items,
        ...(page.nextPosition === null
          ? {}
          : {
              nextCursor: this.cursors.encode({
                version: 1,
                kind: 'evidence_search',
                tenantId: scope.tenantId,
                queryFingerprint,
                position: page.nextPosition,
              }),
            }),
      };
    });
  }
}
