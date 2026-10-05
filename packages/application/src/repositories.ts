import type {
  BlockerSeverity,
  ProjectEvidence,
  ProjectBlocker,
  ProjectNote,
  Client,
  DeveloperProfile,
  Membership,
  Project,
  ProjectStatus,
} from '@beloveddev/domain/entities';

export interface MembershipRepository {
  getByUser(input: { tenantId: string; userId: string }): Promise<Membership | null>;
}

export interface DeveloperProfileRepository {
  getByTenant(input: { tenantId: string }): Promise<DeveloperProfile | null>;
}

export interface ClientRepository {
  getById(input: { tenantId: string; clientId: string }): Promise<Client | null>;
}

export type NewProject = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

export interface ProjectListQuery {
  readonly tenantId: string;
  readonly status?: ProjectStatus;
  /** Required bounded result size, from 1 through 100. */
  readonly limit: number;
}

export interface ProjectRepository {
  getById(input: { tenantId: string; projectId: string }): Promise<Project | null>;
  list(input: ProjectListQuery): Promise<readonly Project[]>;
  /** Persistence primitive; callers must establish authorization before invoking it. */
  create(input: NewProject): Promise<Project>;
}

export interface ProjectKnowledgeQuery {
  readonly tenantId: string;
  readonly projectId: string;
  /** Required bounded result size, from 1 through 100. */
  readonly limit: number;
}

export interface EvidenceRepository {
  /** Newest createdAt first, then descending ID; includes summary and details. */
  listByProject(input: ProjectKnowledgeQuery): Promise<readonly ProjectEvidence[]>;
}

export interface OpenBlockersQuery {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly severity?: BlockerSeverity;
  /** Required bounded result size, from 1 through 100. */
  readonly limit: number;
}

export interface BlockerRepository {
  /** Open only; oldest blockedSince first, then ascending ID. */
  listOpen(input: OpenBlockersQuery): Promise<readonly ProjectBlocker[]>;
}

export interface NoteRepository {
  /** Newest createdAt first, then descending ID. */
  listRecentByProject(input: ProjectKnowledgeQuery): Promise<readonly ProjectNote[]>;
}
