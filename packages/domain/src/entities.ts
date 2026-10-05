export const recordStatuses = ['active', 'inactive'] as const;
export const membershipRoles = ['owner', 'member', 'viewer'] as const;
export const clientStatuses = ['active', 'archived'] as const;
export const projectStatuses = ['planned', 'active', 'paused', 'completed', 'archived'] as const;

export type RecordStatus = (typeof recordStatuses)[number];
export type MembershipRole = (typeof membershipRoles)[number];
export type ClientStatus = (typeof clientStatuses)[number];
export type ProjectStatus = (typeof projectStatuses)[number];

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: RecordStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: RecordStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly status: RecordStatus;
  readonly createdAt: Date;
}

export interface DeveloperProfile {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly headline: string;
  readonly summary: string;
  readonly location: string;
  readonly yearsExperience: number;
  /** Exact decimal amount; null means no published rate. Currency is not yet modeled. */
  readonly hourlyRate: string | null;
  readonly availability: { readonly [key: string]: JsonValue };
  readonly skills: readonly string[];
  readonly serviceAreas: readonly string[];
  readonly preferredProjectTypes: readonly string[];
  readonly excludedProjectTypes: readonly string[];
  readonly portfolioUrl: string | null;
  readonly githubUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Client {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly notes: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Project {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly summary: string;
  readonly problemStatement: string;
  readonly outcome: string;
  readonly status: ProjectStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly stack: readonly string[];
  readonly repositoryUrl: string | null;
  readonly productionUrl: string | null;
  readonly portfolioUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
