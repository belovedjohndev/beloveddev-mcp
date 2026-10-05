import { randomUUID } from 'node:crypto';
import type { Database } from '@beloveddev/database/client';
import { projectEvidence, projectBlockers, projectNotes } from '@beloveddev/database/schema';
import type { TenantFixtures } from './tenant-fixtures.js';

export function evidenceInput(tenant: TenantFixtures['a']) {
  return {
    tenantId: tenant.tenantId,
    projectId: tenant.projectId,
    type: 'architecture' as const,
    title: 'Tenant-scoped persistence',
    summary: 'Composite references prevent cross-tenant relationships',
    details: 'Verified against PostgreSQL with two tenant fixtures.',
    skills: ['TypeScript', 'PostgreSQL'],
    capabilities: ['Data integrity'],
    businessOutcomes: ['Isolated client records'],
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
  };
}

export function blockerInput(tenant: TenantFixtures['a']) {
  return {
    tenantId: tenant.tenantId,
    projectId: tenant.projectId,
    title: 'Awaiting requirements',
    description: 'Client must confirm the acceptance criteria.',
    severity: 'high' as const,
    status: 'open' as const,
    blockedSince: new Date('2026-02-01T09:00:00Z'),
    resolvedAt: null,
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
  };
}

export function noteInput(tenant: TenantFixtures['a']) {
  return {
    tenantId: tenant.tenantId,
    projectId: tenant.projectId,
    authorUserId: tenant.userId,
    category: 'decision' as const,
    content: 'Use PostgreSQL constraints for stable invariants.',
    idempotencyKey: 'initial-decision',
    createdAt: new Date('2026-02-01T09:00:00Z'),
  };
}

export async function seedProjectKnowledge(database: Database, tenants: TenantFixtures) {
  const makeIds = () => ({
    evidenceId: randomUUID(),
    blockerId: randomUUID(),
    noteId: randomUUID(),
  });
  const fixture = { a: makeIds(), b: makeIds() };
  await database.transaction(async (transaction) => {
    for (const key of ['a', 'b'] as const) {
      await transaction
        .insert(projectEvidence)
        .values({ ...evidenceInput(tenants[key]), id: fixture[key].evidenceId });
      await transaction
        .insert(projectBlockers)
        .values({ ...blockerInput(tenants[key]), id: fixture[key].blockerId });
      await transaction
        .insert(projectNotes)
        .values({ ...noteInput(tenants[key]), id: fixture[key].noteId });
    }
  });
  return fixture;
}

export type ProjectKnowledgeFixtures = Awaited<ReturnType<typeof seedProjectKnowledge>>;
