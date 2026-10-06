import type {
  EvidenceSearchQuery,
  EvidenceRepository,
  ProjectKnowledgeQuery,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { evidenceTypes } from '@beloveddev/domain/entities';
import { projectEvidence, projects } from '@beloveddev/database/schema';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { repositoryQuery } from './repository-query.js';

const searchQuerySchema = z.strictObject({
  tenantId: z.uuid(),
  query: z.string().trim().min(1).max(1000),
  projectIds: z.array(z.uuid()).min(1).max(100).optional(),
  evidenceTypes: z.array(z.enum(evidenceTypes)).min(1).max(evidenceTypes.length).optional(),
  skills: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
  limit: z.number().int().min(1).max(100),
  after: z
    .strictObject({
      id: z.uuid(),
      relevanceScore: z
        .string()
        .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/)
        .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0),
    })
    .optional(),
});

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listByProject(input: ProjectKnowledgeQuery) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RepositoryError('INVALID_INPUT');
    }
    return repositoryQuery(() =>
      this.database
        .select()
        .from(projectEvidence)
        .where(
          and(
            eq(projectEvidence.tenantId, input.tenantId),
            eq(projectEvidence.projectId, input.projectId),
          ),
        )
        .orderBy(
          sql`${projectEvidence.createdAt} DESC NULLS LAST`,
          sql`${projectEvidence.id} DESC NULLS LAST`,
        )
        .limit(input.limit),
    );
  }

  async search(input: EvidenceSearchQuery) {
    const parsed = searchQuerySchema.safeParse(input);
    if (!parsed.success) throw new RepositoryError('INVALID_INPUT');
    const values = parsed.data;
    const normalizedSkills = values.skills?.map((skill) => skill.toLowerCase());
    const textQuery = sql`websearch_to_tsquery('english'::regconfig, ${values.query})`;
    const rank = sql<number>`ts_rank_cd(${projectEvidence.searchVector}, ${textQuery})`;
    const rankText = sql<string>`${rank}::text`;
    const predicates = [
      eq(projectEvidence.tenantId, values.tenantId),
      sql`${projectEvidence.searchVector} @@ ${textQuery}`,
      values.projectIds === undefined
        ? undefined
        : inArray(projectEvidence.projectId, values.projectIds),
      values.evidenceTypes === undefined
        ? undefined
        : inArray(projectEvidence.type, values.evidenceTypes),
      normalizedSkills === undefined
        ? undefined
        : sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${projectEvidence.skills}) AS skill(value)
            WHERE ${inArray(sql`lower(btrim(skill.value))`, normalizedSkills)}
          )`,
      values.after === undefined
        ? undefined
        : or(
            sql`${rank} < ${values.after.relevanceScore}::real`,
            and(
              sql`${rank} = ${values.after.relevanceScore}::real`,
              sql`${projectEvidence.id} > ${values.after.id}::uuid`,
            ),
          ),
    ];

    return repositoryQuery(async () => {
      const rows = await this.database
        .select({
          evidenceId: projectEvidence.id,
          projectId: projectEvidence.projectId,
          projectName: projects.name,
          type: projectEvidence.type,
          title: projectEvidence.title,
          summary: projectEvidence.summary,
          skills: projectEvidence.skills,
          capabilities: projectEvidence.capabilities,
          businessOutcomes: projectEvidence.businessOutcomes,
          relevanceScoreText: rankText,
        })
        .from(projectEvidence)
        .innerJoin(
          projects,
          and(
            eq(projects.tenantId, projectEvidence.tenantId),
            eq(projects.id, projectEvidence.projectId),
          ),
        )
        .where(and(...predicates))
        .orderBy(desc(rank), asc(projectEvidence.id))
        .limit(values.limit + 1);
      const hasMore = rows.length > values.limit;
      const pageRows = rows.slice(0, values.limit);
      const items = pageRows.map(({ relevanceScoreText, ...row }) => ({
        ...row,
        relevanceScore: Number(relevanceScoreText),
      }));
      const last = pageRows.at(-1);
      return {
        items,
        nextPosition:
          hasMore && last ? { id: last.evidenceId, relevanceScore: last.relevanceScoreText } : null,
      };
    });
  }
}
