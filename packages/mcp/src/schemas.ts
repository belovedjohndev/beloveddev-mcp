import { z } from 'zod';
import { applicationErrorCodes } from '@beloveddev/application/application-error';
import {
  getProfileInput,
  listProjectsInput,
  getProjectInput,
  getBlockersInput,
  searchProjectEvidenceInput,
} from '@beloveddev/application/read-inputs';
import {
  blockerSeverities,
  evidenceTypes,
  noteCategories,
  projectStatuses,
} from '@beloveddev/domain/entities';

const id = z.uuid();
const date = z.iso.datetime();
const strings = z.array(z.string());
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

export const safeErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(applicationErrorCodes),
    message: z.string(),
    requestId: id,
  }),
});

export const toolSchemas = {
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
} as const;

export type ToolName = keyof typeof toolSchemas;
