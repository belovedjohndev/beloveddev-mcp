import type {
  Client,
  DeveloperProfile,
  Project,
  ProjectBlocker,
  ProjectEvidence,
  ProjectNote,
} from '@beloveddev/domain/entities';
import type { RequestContext } from '@beloveddev/application/request-context';
import type {
  BlockerPageQuery,
  EvidenceSearchQuery,
  OpenBlockersQuery,
  ProjectPageQuery,
  ProjectKnowledgeQuery,
} from '@beloveddev/application/repositories';

export const fixtureId = (value: number) =>
  '00000000-0000-4000-8000-' + value.toString(16).padStart(12, '0');

export function createReadFixture() {
  const time = new Date('2026-02-01T09:00:00Z');
  const context: RequestContext = {
    requestId: fixtureId(1),
    tenantId: fixtureId(2),
    userId: fixtureId(3),
    membershipId: fixtureId(4),
    role: 'viewer',
    permissions: ['profile:read', 'projects:read'],
  };
  const otherContext: RequestContext = {
    ...context,
    tenantId: fixtureId(5),
    userId: fixtureId(6),
    membershipId: fixtureId(7),
  };
  const client: Client = {
    id: fixtureId(8),
    tenantId: context.tenantId,
    name: 'Client A',
    notes: '',
    status: 'active',
    createdAt: time,
    updatedAt: time,
  };
  const project: Project = {
    id: fixtureId(9),
    tenantId: context.tenantId,
    clientId: client.id,
    name: 'Portfolio',
    slug: 'portfolio',
    summary: 'Scoped project records',
    problemStatement: 'Scattered context',
    outcome: 'Reliable context',
    status: 'active',
    startedAt: time,
    completedAt: null,
    stack: ['TypeScript'],
    repositoryUrl: null,
    productionUrl: null,
    portfolioUrl: null,
    createdAt: time,
    updatedAt: time,
  };
  const otherProject: Project = {
    ...project,
    id: fixtureId(10),
    tenantId: otherContext.tenantId,
    clientId: null,
  };
  const profile: DeveloperProfile = {
    id: fixtureId(11),
    tenantId: context.tenantId,
    displayName: 'Developer A',
    headline: 'Engineer',
    summary: 'Builds reliable software',
    location: 'Bangkok',
    yearsExperience: 5,
    hourlyRate: '125.50',
    availability: { hoursPerWeek: 20 },
    skills: ['TypeScript'],
    serviceAreas: ['Web'],
    preferredProjectTypes: ['SaaS'],
    excludedProjectTypes: [],
    portfolioUrl: null,
    githubUrl: null,
    createdAt: time,
    updatedAt: time,
  };
  const evidence: ProjectEvidence = {
    id: fixtureId(12),
    tenantId: context.tenantId,
    projectId: project.id,
    type: 'architecture',
    title: 'Ownership',
    summary: 'Composite references',
    details: 'Detailed proof',
    skills: [],
    capabilities: [],
    businessOutcomes: [],
    createdAt: time,
    updatedAt: time,
  };
  const blocker: ProjectBlocker = {
    id: fixtureId(13),
    tenantId: context.tenantId,
    projectId: project.id,
    title: 'Approval',
    description: 'Waiting for approval',
    severity: 'high',
    status: 'open',
    blockedSince: time,
    resolvedAt: null,
    createdAt: time,
    updatedAt: time,
  };
  const note: ProjectNote = {
    id: fixtureId(14),
    tenantId: context.tenantId,
    projectId: project.id,
    authorUserId: context.userId,
    category: 'decision',
    content: 'Use PostgreSQL',
    idempotencyKey: 'private-key',
    createdAt: time,
  };
  const data = {
    projects: [project, otherProject],
    profiles: [profile, { ...profile, id: fixtureId(15), tenantId: otherContext.tenantId }],
    evidence: [evidence],
    blockers: [blocker],
    notes: [note],
  };
  const calls: { method: string; input: unknown }[] = [];
  const childMatches = (
    row: { tenantId: string; projectId: string },
    input: ProjectKnowledgeQuery,
  ) => row.tenantId === input.tenantId && row.projectId === input.projectId;
  const repositories = {
    profiles: {
      getByTenant: (input: { tenantId: string }) => {
        calls.push({ method: 'profile', input });
        return Promise.resolve(
          data.profiles.find((row) => row.tenantId === input.tenantId) ?? null,
        );
      },
    },
    projects: {
      getById: (input: { tenantId: string; projectId: string }) => {
        calls.push({ method: 'project', input });
        return Promise.resolve(
          data.projects.find(
            (row) => row.tenantId === input.tenantId && row.id === input.projectId,
          ) ?? null,
        );
      },
      listPage: (input: ProjectPageQuery) => {
        calls.push({ method: 'projects', input });
        const rows = data.projects
          .filter(
            (row) =>
              row.tenantId === input.tenantId &&
              (input.status === undefined || row.status === input.status) &&
              (input.clientId === undefined || row.clientId === input.clientId) &&
              (input.query === undefined ||
                (row.name + ' ' + row.summary).toLowerCase().includes(input.query.toLowerCase())) &&
              (input.after === undefined || row.id > input.after.id),
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        const items = rows.slice(0, input.limit).map((row) => ({
          project: row,
          client: row.clientId === client.id ? { id: client.id, name: client.name } : null,
        }));
        const last = items.at(-1);
        return Promise.resolve({
          items,
          nextPosition: rows.length > input.limit && last ? { id: last.project.id } : null,
        });
      },
    },
    clients: {
      getById: (input: { tenantId: string; clientId: string }) => {
        calls.push({ method: 'client', input });
        return Promise.resolve(
          input.tenantId === client.tenantId && input.clientId === client.id ? client : null,
        );
      },
    },
    evidence: {
      listByProject: (input: ProjectKnowledgeQuery) => {
        calls.push({ method: 'evidence', input });
        return Promise.resolve(
          data.evidence.filter((row) => childMatches(row, input)).slice(0, input.limit),
        );
      },
      search: (input: EvidenceSearchQuery) => {
        calls.push({ method: 'evidenceSearch', input });
        const rows = data.evidence
          .filter((row) => {
            const project = data.projects.find(
              (candidate) =>
                candidate.tenantId === input.tenantId && candidate.id === row.projectId,
            );
            const text = [
              row.title,
              row.summary,
              row.details,
              ...row.skills,
              ...row.capabilities,
              ...row.businessOutcomes,
            ]
              .join(' ')
              .toLowerCase();
            return (
              row.tenantId === input.tenantId &&
              project !== undefined &&
              text.includes(input.query.toLowerCase()) &&
              (input.projectIds === undefined || input.projectIds.includes(row.projectId)) &&
              (input.evidenceTypes === undefined || input.evidenceTypes.includes(row.type)) &&
              (input.skills === undefined ||
                row.skills.some((skill) => input.skills?.includes(skill.toLowerCase()))) &&
              (input.after === undefined ||
                Number(input.after.relevanceScore) > 1 ||
                (Number(input.after.relevanceScore) === 1 && row.id > input.after.id))
            );
          })
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        const selected = rows.slice(0, input.limit);
        const items = selected.map((row) => ({
          evidenceId: row.id,
          projectId: row.projectId,
          projectName: data.projects.find((project) => project.id === row.projectId)?.name ?? '',
          type: row.type,
          title: row.title,
          summary: row.summary,
          skills: row.skills,
          capabilities: row.capabilities,
          businessOutcomes: row.businessOutcomes,
          relevanceScore: 1,
        }));
        const last = items.at(-1);
        return Promise.resolve({
          items,
          nextPosition:
            rows.length > input.limit && last ? { id: last.evidenceId, relevanceScore: '1' } : null,
        });
      },
    },
    blockers: {
      listOpen: (input: OpenBlockersQuery) => {
        calls.push({ method: 'blockers', input });
        return Promise.resolve(
          data.blockers
            .filter(
              (row) =>
                row.tenantId === input.tenantId &&
                (input.projectId === undefined || row.projectId === input.projectId) &&
                row.status === 'open',
            )
            .slice(0, input.limit),
        );
      },
      listOpenPage: (input: BlockerPageQuery) => {
        calls.push({ method: 'blockerPage', input });
        const rows = data.blockers
          .filter(
            (row) =>
              row.tenantId === input.tenantId &&
              row.status === 'open' &&
              (input.projectId === undefined || row.projectId === input.projectId) &&
              (input.severity === undefined || row.severity === input.severity) &&
              (input.after === undefined ||
                row.blockedSince.getTime() > Date.parse(input.after.blockedSince) ||
                (row.blockedSince.getTime() === Date.parse(input.after.blockedSince) &&
                  row.id > input.after.id)),
          )
          .sort(
            (a, b) => a.blockedSince.getTime() - b.blockedSince.getTime() || (a.id < b.id ? -1 : 1),
          );
        const items = rows.slice(0, input.limit).map((row) => ({
          blocker: row,
          projectName: data.projects.find((p) => p.id === row.projectId)?.name ?? '',
        }));
        const last = items.at(-1);
        return Promise.resolve({
          items,
          nextPosition:
            rows.length > input.limit && last
              ? {
                  id: last.blocker.id,
                  blockedSince: last.blocker.blockedSince.toISOString().replace('Z', '000Z'),
                }
              : null,
        });
      },
    },
    notes: {
      listRecentByProject: (input: ProjectKnowledgeQuery) => {
        calls.push({ method: 'notes', input });
        return Promise.resolve(
          data.notes.filter((row) => childMatches(row, input)).slice(0, input.limit),
        );
      },
    },
  };
  return {
    context,
    otherContext,
    profile,
    project,
    otherProject,
    client,
    evidence,
    blocker,
    note,
    data,
    calls,
    repositories,
  };
}
