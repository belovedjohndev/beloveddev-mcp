import type { MembershipRepository } from '@beloveddev/application/repositories';
import type {
  RequestContext,
  RequestContextProvider,
} from '@beloveddev/application/request-context';
import { permissionsForRole } from '@beloveddev/application/request-context';
import { applicationOperation } from '@beloveddev/application/application-error';

export interface LocalPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

/** Only the operator-controlled stdio process may configure this principal. */
export class LocalRequestContextProvider implements RequestContextProvider {
  private readonly principal: LocalPrincipal | null;
  constructor(
    principal: LocalPrincipal | null,
    private readonly memberships: Pick<MembershipRepository, 'getActiveByUser'>,
  ) {
    this.principal = principal === null ? null : Object.freeze({ ...principal });
  }
  async resolve(requestId: string): Promise<RequestContext | null> {
    if (this.principal === null) return null;
    const principal = this.principal;
    return applicationOperation(async () => {
      const membership = await this.memberships.getActiveByUser(principal);
      if (
        membership === null ||
        membership.status !== 'active' ||
        membership.userId !== principal.userId ||
        membership.tenantId !== principal.tenantId
      )
        return null;
      return Object.freeze({
        requestId,
        tenantId: membership.tenantId,
        userId: membership.userId,
        membershipId: membership.id,
        role: membership.role,
        permissions: permissionsForRole(membership.role),
      });
    });
  }
}
