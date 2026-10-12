import { z } from 'zod';
import { applicationErrorCodes } from '@beloveddev/application/application-error';
import {
  getProfileInput,
  listProjectsInput,
  getProjectInput,
  getBlockersInput,
  listOpportunitiesInput,
  searchProjectEvidenceInput,
  evaluateOpportunityInput,
} from '@beloveddev/application/read-inputs';
import {
  blockerSeverities,
  evidenceTypes,
  noteCategories,
  opportunityBudgetTypes,
  opportunityStatuses,
  projectStatuses,
} from '@beloveddev/domain/entities';
import {
  evaluationEvidenceLimit,
  evaluationVersion,
  type EvaluationConcernCode,
  type EvaluationRiskCode,
  type EvaluationStrengthCode,
  type OpportunityRecommendation,
} from '@beloveddev/domain/evaluation-policy-v1';

const id = z.uuid();
const date = z.iso.datetime();
const strings = z.array(z.string());
const decimalAmount = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/)
  .nullable();
const meta = z.strictObject({ requestId: id });
const client = z.strictObject({ id, name: z.string() }).nullable();
const projectSummary = z.strictObject({
  id,
  name: z.string(),
  slug: z.string(),
  summary: z.string(),
  status: z.enum(projectStatuses),
  stack: strings,
  startedAt: date.nullable(),
  completedAt: date.nullable(),
});
const blockerSummary = z.strictObject({
  id,
  title: z.string(),
  description: z.string(),
  severity: z.enum(blockerSeverities),
  blockedSince: date,
});
const fitScore = z.number().int().min(0).max(100);

export const safeErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(applicationErrorCodes),
    message: z.string(),
    requestId: id,
  }),
});

export const toolSchemas = {
  evaluate_opportunity: {
    description:
      'Evaluate one stored opportunity by UUID against the current tenant profile and up to 10 retrieved project evidence results using deterministic v1 rules. Returns strengths, skill gaps, risks, and a recommendation. Read-only; requires opportunities:evaluate (owner/member). Budget is not comparable and remains null; evidence_retrieval_incomplete flags partial retrieval. Makes no changes and calls no LLM.',
    input: evaluateOpportunityInput,
    output: z.strictObject({
      opportunity: z.strictObject({
        id,
        title: z.string(),
        source: z
          .string()
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      }),
      fit: z.strictObject({
        overallScore: fitScore,
        recommendation: z.enum({
          strong_match: 'strong_match',
          good_match: 'good_match',
          review: 'review',
          weak_match: 'weak_match',
          skip: 'skip',
        } satisfies { [Code in OpportunityRecommendation]: Code }),
      }),
      scores: z.strictObject({
        skills: fitScore.nullable(),
        projectType: fitScore.nullable(),
        budget: z.null(),
        experienceEvidence: fitScore.nullable(),
      }),
      matchedSkills: strings,
      missingSkills: strings,
      strengths: z.array(
        z.strictObject({
          code: z.enum({
            all_required_skills_matched: 'all_required_skills_matched',
            preferred_project_type: 'preferred_project_type',
            strong_portfolio_evidence: 'strong_portfolio_evidence',
          } satisfies { [Code in EvaluationStrengthCode]: Code }),
          message: z.string(),
        }),
      ),
      concerns: z.array(
        z.strictObject({
          code: z.enum({
            missing_required_skills: 'missing_required_skills',
            project_type_not_preferred: 'project_type_not_preferred',
            limited_portfolio_evidence: 'limited_portfolio_evidence',
            budget_not_comparable: 'budget_not_comparable',
          } satisfies { [Code in EvaluationConcernCode]: Code }),
          message: z.string(),
        }),
      ),
      riskFlags: z.array(
        z.strictObject({
          code: z.enum({
            excluded_project_type: 'excluded_project_type',
            no_required_skills_matched: 'no_required_skills_matched',
            no_portfolio_evidence: 'no_portfolio_evidence',
            evidence_retrieval_incomplete: 'evidence_retrieval_incomplete',
            insufficient_evaluation_signals: 'insufficient_evaluation_signals',
          } satisfies { [Code in EvaluationRiskCode]: Code }),
          message: z.string(),
        }),
      ),
      relevantEvidence: z
        .array(
          z.strictObject({
            projectId: id,
            projectName: z.string(),
            evidenceId: id,
            title: z.string(),
            summary: z.string(),
            relevanceScore: z.number().finite().nonnegative(),
          }),
        )
        .max(evaluationEvidenceLimit),
      evaluationVersion: z.literal(evaluationVersion),
      meta,
    }),
  },
  get_profile: {
    description:
      'Read the current tenant developer profile. Takes no arguments and makes no changes. Requires profile:read.',
    input: getProfileInput,
    output: z.strictObject({
      profile: z.strictObject({
        id,
        displayName: z.string(),
        headline: z.string(),
        summary: z.string(),
        location: z.string(),
        yearsExperience: z.number().int().nonnegative(),
        hourlyRate: z.string().nullable(),
        availability: z.record(z.string(), z.json()),
        skills: strings,
        serviceAreas: strings,
        preferredProjectTypes: strings,
        excludedProjectTypes: strings,
        portfolioUrl: z.string().nullable(),
        githubUrl: z.string().nullable(),
      }),
      meta,
    }),
  },
  list_projects: {
    description:
      'Read a page of current tenant projects. Optional status/clientId filters and literal case-insensitive name/summary query; limit defaults to 20 (max 100). Reuse nextCursor with the same filters. Makes no changes; requires projects:read.',
    input: listProjectsInput,
    output: z.strictObject({
      projects: z.array(projectSummary.extend({ client })),
      nextCursor: z.string().optional(),
      meta,
    }),
  },
  get_project: {
    description:
      'Read one project by UUID with its client, up to 20 evidence summaries, 20 open blockers, and 10 recent notes. Makes no changes; requires projects:read.',
    input: getProjectInput,
    output: z.strictObject({
      project: projectSummary.extend({
        problemStatement: z.string(),
        outcome: z.string(),
        repositoryUrl: z.string().nullable(),
        productionUrl: z.string().nullable(),
        portfolioUrl: z.string().nullable(),
      }),
      client,
      evidenceSummary: z
        .array(
          z.strictObject({
            id,
            type: z.enum(evidenceTypes),
            title: z.string(),
            summary: z.string(),
          }),
        )
        .max(20),
      openBlockers: z.array(blockerSummary).max(20),
      recentNotes: z
        .array(
          z.strictObject({
            id,
            category: z.enum(noteCategories),
            content: z.string(),
            createdAt: date,
          }),
        )
        .max(10),
      meta,
    }),
  },
  get_blockers: {
    description:
      'Read a page of open blockers, oldest blocked first. Optional project UUID/severity filters; limit defaults to 20 (max 100). Reuse nextCursor with the same filters. Makes no changes; requires projects:read.',
    input: getBlockersInput,
    output: z.strictObject({
      blockers: z.array(blockerSummary.extend({ projectId: id, projectName: z.string() })),
      nextCursor: z.string().optional(),
      meta,
    }),
  },
  search_project_evidence: {
    description:
      'Search prior project evidence using PostgreSQL full-text relevance within the current tenant, with optional project, evidence-type, and exact skill filters. Read-only; requires projects:read.',
    input: searchProjectEvidenceInput,
    output: z.strictObject({
      results: z
        .array(
          z.strictObject({
            evidenceId: id,
            projectId: id,
            projectName: z.string(),
            type: z.enum(evidenceTypes),
            title: z.string(),
            summary: z.string(),
            skills: strings,
            capabilities: strings,
            businessOutcomes: strings,
            relevanceScore: z.number().finite().nonnegative(),
          }),
        )
        .max(100),
      nextCursor: z.string().max(4096).optional(),
      meta,
    }),
  },
  list_opportunities: {
    description:
      'Read a page of current tenant opportunities. Optional exact status/source filters and a literal case-insensitive title/client/description/project-type query; limit defaults to 20 (max 100). Reuse nextCursor with the same filters. Makes no changes; requires opportunities:read.',
    input: listOpportunitiesInput,
    output: z.strictObject({
      opportunities: z
        .array(
          z.strictObject({
            id,
            source: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            title: z.string(),
            clientName: z.string().nullable(),
            projectType: z.string().nullable(),
            budgetType: z.enum(opportunityBudgetTypes).nullable(),
            amountMin: decimalAmount,
            amountMax: decimalAmount,
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .nullable(),
            requiredSkills: strings,
            preferredSkills: strings,
            status: z.enum(opportunityStatuses),
            sourceUrl: z.string().nullable(),
            publishedAt: date.nullable(),
          }),
        )
        .max(100),
      nextCursor: z.string().max(4096).optional(),
      meta,
    }),
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
