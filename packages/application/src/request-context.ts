import type { MembershipRole } from '@beloveddev/domain/entities';
import { ApplicationError } from './application-error.js';

export type Permission = 'profile:read' | 'projects:read';

export interface RequestContext {
  readonly requestId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly role: MembershipRole;
  readonly permissions: readonly Permission[];
}

/** Implementations resolve trusted server identity; tool arguments never enter this port. */
export interface RequestContextProvider {
  resolve(requestId: string): Promise<RequestContext | null>;
}

const readPermissions: readonly Permission[] = Object.freeze(['profile:read', 'projects:read']);
const rolePermissions: Record<MembershipRole, readonly Permission[]> = {
  owner: readPermissions,
  member: readPermissions,
  viewer: readPermissions,
};

export function permissionsForRole(role: MembershipRole): readonly Permission[] {
  return rolePermissions[role];
}

export interface AuthorizationPolicy {
  require(context: RequestContext | null, permission: Permission): RequestContext;
}

export class PermissionAuthorization implements AuthorizationPolicy {
  require(context: RequestContext | null, permission: Permission): RequestContext {
    if (context === null) throw new ApplicationError('UNAUTHENTICATED');
    if (!context.permissions.includes(permission)) throw new ApplicationError('FORBIDDEN');
    return context;
  }
}
