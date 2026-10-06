import type {
  BlockerRepository,
  ClientRepository,
  EvidenceRepository,
  NoteRepository,
  ProjectRepository,
} from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { getProjectInput, parseReadInput } from '../read-inputs.js';

export const projectContextLimits = Object.freeze({ evidence: 20, blockers: 20, notes: 10 });

export class GetProject {
  constructor(
    private readonly repositories: {
      projects: Pick<ProjectRepository, 'getById'>;
      clients: ClientRepository;
      evidence: EvidenceRepository;
      blockers: Pick<BlockerRepository, 'listOpen'>;
      notes: NoteRepository;
    },
    private readonly authorization: AuthorizationPolicy,
  ) {}
  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'projects:read');
    const { projectId } = parseReadInput(getProjectInput, input);
    return applicationOperation(async () => {
      const tenantId = scope.tenantId;
      const project = await this.repositories.projects.getById({ tenantId, projectId });
      if (!project) throw new ApplicationError('NOT_FOUND');
      const [client, evidence, blockers, notes] = await Promise.all([
        project.clientId === null
          ? null
          : this.repositories.clients.getById({ tenantId, clientId: project.clientId }),
        this.repositories.evidence.listByProject({
          tenantId,
          projectId,
          limit: projectContextLimits.evidence,
        }),
        this.repositories.blockers.listOpen({
          tenantId,
          projectId,
          limit: projectContextLimits.blockers,
        }),
        this.repositories.notes.listRecentByProject({
          tenantId,
          projectId,
          limit: projectContextLimits.notes,
        }),
      ]);
      return {
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          summary: project.summary,
          problemStatement: project.problemStatement,
          outcome: project.outcome,
          status: project.status,
          stack: project.stack,
          repositoryUrl: project.repositoryUrl,
          productionUrl: project.productionUrl,
          portfolioUrl: project.portfolioUrl,
          startedAt: project.startedAt?.toISOString() ?? null,
          completedAt: project.completedAt?.toISOString() ?? null,
        },
        client: client === null ? null : { id: client.id, name: client.name },
        evidenceSummary: evidence.map(({ id, type, title, summary }) => ({
          id,
          type,
          title,
          summary,
        })),
        openBlockers: blockers.map(({ id, title, description, severity, blockedSince }) => ({
          id,
          title,
          description,
          severity,
          blockedSince: blockedSince.toISOString(),
        })),
        recentNotes: notes.map(({ id, category, content, createdAt }) => ({
          id,
          category,
          content,
          createdAt: createdAt.toISOString(),
        })),
      };
    });
  }
}
