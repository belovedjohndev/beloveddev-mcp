import { createHash } from 'node:crypto';
import type { CursorCodec, OpportunityPosition } from '../pagination.js';
import type { OpportunityRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { listOpportunitiesInput, parseReadInput } from '../read-inputs.js';

export class ListOpportunities {
  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly authorization: AuthorizationPolicy,
    private readonly cursors: CursorCodec,
  ) {}

  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'opportunities:read');
    const values = parseReadInput(listOpportunitiesInput, input);
    const filterFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          tenantId: scope.tenantId,
          status: values.status ?? null,
          source: values.source ?? null,
          query: values.query ?? null,
        }),
      )
      .digest('hex');

    return applicationOperation(async () => {
      let after: OpportunityPosition | undefined;
      if (values.cursor !== undefined) {
        const cursor = this.cursors.decode(values.cursor);
        if (
          cursor.kind !== 'opportunities' ||
          cursor.tenantId !== scope.tenantId ||
          cursor.filterFingerprint !== filterFingerprint
        ) {
          throw new ApplicationError('VALIDATION_ERROR');
        }
        after = cursor.position;
      }

      const page = await this.opportunities.listPage({
        tenantId: scope.tenantId,
        limit: values.limit,
        ...(values.status === undefined ? {} : { status: values.status }),
        ...(values.source === undefined ? {} : { source: values.source }),
        ...(values.query === undefined ? {} : { query: values.query }),
        ...(after === undefined ? {} : { after }),
      });
      return {
        opportunities: page.items.map((opportunity) => ({
          id: opportunity.id,
          source: opportunity.source,
          title: opportunity.title,
          clientName: opportunity.clientName,
          projectType: opportunity.projectType,
          budgetType: opportunity.budgetType,
          amountMin: opportunity.amountMin,
          amountMax: opportunity.amountMax,
          currency: opportunity.currency,
          requiredSkills: opportunity.requiredSkills,
          preferredSkills: opportunity.preferredSkills,
          status: opportunity.status,
          sourceUrl: opportunity.sourceUrl,
          publishedAt: opportunity.publishedAt?.toISOString() ?? null,
        })),
        ...(page.nextPosition === null
          ? {}
          : {
              nextCursor: this.cursors.encode({
                version: 1,
                kind: 'opportunities',
                tenantId: scope.tenantId,
                filterFingerprint,
                position: page.nextPosition,
              }),
            }),
      };
    });
  }
}
