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

export const evidenceTypes = [
  'feature',
  'architecture',
  'integration',
  'business_outcome',
  'performance',
  'security',
  'reliability',
  'automation',
  'client_result',
] as const;
export const blockerSeverities = ['low', 'medium', 'high', 'critical'] as const;
export const blockerStatuses = ['open', 'resolved'] as const;
export const noteCategories = [
  'general',
  'decision',
  'requirement',
  'client_feedback',
  'technical',
  'follow_up',
  'research',
] as const;

export type EvidenceType = (typeof evidenceTypes)[number];
export type BlockerSeverity = (typeof blockerSeverities)[number];
export type BlockerStatus = (typeof blockerStatuses)[number];
export type NoteCategory = (typeof noteCategories)[number];

export interface ProjectEvidence {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly type: EvidenceType;
  readonly title: string;
  readonly summary: string;
  readonly details: string;
  readonly skills: readonly string[];
  readonly capabilities: readonly string[];
  readonly businessOutcomes: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectBlocker {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly severity: BlockerSeverity;
  readonly status: BlockerStatus;
  readonly blockedSince: Date;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectNote {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly authorUserId: string;
  readonly category: NoteCategory;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}
