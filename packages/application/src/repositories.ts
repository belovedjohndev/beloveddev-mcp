import type {
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
