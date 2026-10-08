import type {
  BlockerSeverity,
  ProjectEvidence,
  ProjectBlocker,
  ProjectNote,
  Client,
  DeveloperProfile,
  Membership,
  Opportunity,
  OpportunityStatus,
  Project,
  ProjectStatus,
  EvidenceType,
} from '@beloveddev/domain/entities';
import type {
  BlockerPosition,
  EvidenceSearchPosition,
  OpportunityPosition,
  ProjectPosition,
} from './pagination.js';

export interface MembershipRepository {
  getByUser(input: { tenantId: string; userId: string }): Promise<Membership | null>;
  /** Requires an active membership, user, and tenant. */
  getActiveByUser(input: { tenantId: string; userId: string }): Promise<Membership | null>;
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
  listPage(input: ProjectPageQuery): Promise<ProjectPage>;
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
  search(input: EvidenceSearchQuery): Promise<EvidenceSearchPage>;
}

export interface EvidenceSearchQuery {
  readonly tenantId: string;
  readonly query: string;
  readonly projectIds?: readonly string[];
  readonly evidenceTypes?: readonly EvidenceType[];
  /** Case-folded exact memberships; any requested skill may match. */
  readonly skills?: readonly string[];
  readonly limit: number;
  readonly after?: EvidenceSearchPosition;
}
export interface EvidenceSearchResult {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly type: EvidenceType;
  readonly title: string;
  readonly summary: string;
  readonly skills: readonly string[];
  readonly capabilities: readonly string[];
  readonly businessOutcomes: readonly string[];
  /** PostgreSQL ts_rank_cd value represented as a JavaScript number. */
  readonly relevanceScore: number;
}
export interface EvidenceSearchPage {
  readonly items: readonly EvidenceSearchResult[];
  readonly nextPosition: EvidenceSearchPosition | null;
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
  listOpenPage(input: BlockerPageQuery): Promise<BlockerPage>;
}

export interface NoteRepository {
  /** Newest createdAt first, then descending ID. */
  listRecentByProject(input: ProjectKnowledgeQuery): Promise<readonly ProjectNote[]>;
}

export interface ProjectPageQuery extends ProjectListQuery {
  readonly clientId?: string;
  readonly query?: string;
  readonly after?: ProjectPosition;
}
export interface ProjectPage {
  readonly items: readonly {
    readonly project: Project;
    readonly client: Pick<Client, 'id' | 'name'> | null;
  }[];
  readonly nextPosition: ProjectPosition | null;
}
export interface BlockerPageQuery extends OpenBlockersQuery {
  readonly after?: BlockerPosition;
}
export interface BlockerPage {
  readonly items: readonly { readonly blocker: ProjectBlocker; readonly projectName: string }[];
  readonly nextPosition: BlockerPosition | null;
}

export interface OpportunityListQuery {
  readonly tenantId: string;
  readonly status?: OpportunityStatus;
  /** Exact match against the canonical lowercase source slug. */
  readonly source?: string;
  /** Literal case-insensitive substring across documented text fields. */
  readonly query?: string;
  readonly limit: number;
  readonly after?: OpportunityPosition;
}
export interface OpportunityPage {
  readonly items: readonly Opportunity[];
  readonly nextPosition: OpportunityPosition | null;
}
export interface OpportunityRepository {
  listPage(input: OpportunityListQuery): Promise<OpportunityPage>;
}
