import {
  blockerSeverities,
  evidenceTypes,
  opportunityStatuses,
  projectStatuses,
} from '@beloveddev/domain/entities';
import { z } from 'zod';
import { ApplicationError } from './application-error.js';

const limit = z.number().int().min(1).max(100).default(20);
const cursor = z.string().min(1).max(4096).optional();
export const getProfileInput = z.strictObject({});
export const listProjectsInput = z.strictObject({
  status: z.enum(projectStatuses).optional(),
  clientId: z.uuid().optional(),
  query: z.string().trim().min(1).max(200).optional(),
  limit,
  cursor,
});
export const getProjectInput = z.strictObject({ projectId: z.uuid() });
export const getBlockersInput = z.strictObject({
  projectId: z.uuid().optional(),
  severity: z.enum(blockerSeverities).optional(),
  limit,
  cursor,
});
export const searchProjectEvidenceInput = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  projectIds: z.array(z.uuid()).min(1).max(100).optional(),
  evidenceTypes: z.array(z.enum(evidenceTypes)).min(1).max(evidenceTypes.length).optional(),
  skills: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
  limit,
  cursor,
});
export const listOpportunitiesInput = z.strictObject({
  status: z.enum(opportunityStatuses).optional(),
  source: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  query: z.string().trim().toLowerCase().min(1).max(200).optional(),
  limit,
  cursor,
});

export function parseReadInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApplicationError('VALIDATION_ERROR');
  return result.data;
}
