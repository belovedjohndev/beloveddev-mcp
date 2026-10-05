import { randomUUID } from 'node:crypto';
import type { Database } from '@beloveddev/database/client';
import {
  clients,
  developerProfiles,
  projects,
  projectEvidence,
  projectBlockers,
  projectNotes,
  tenantMemberships,
  tenants,
  users,
} from '@beloveddev/database/schema';
import { inArray } from 'drizzle-orm';

export function projectInput(tenantId: string, clientId: string | null) {
  return {
    tenantId,
    clientId,
    name: 'Portfolio Platform',
    slug: 'portfolio-platform',
    summary: 'Tenant-scoped portfolio management',
    problemStatement: 'Project evidence is difficult to find',
    outcome: 'A searchable project portfolio',
    status: 'active' as const,
    startedAt: new Date('2026-01-15T09:00:00Z'),
    completedAt: null,
    stack: ['TypeScript', 'PostgreSQL'],
    repositoryUrl: null,
    productionUrl: null,
    portfolioUrl: null,
  };
}

export async function seedTwoTenants(database: Database) {
  const makeIds = () => ({
    tenantId: randomUUID(),
    userId: randomUUID(),
    clientId: randomUUID(),
    projectId: randomUUID(),
    profileId: randomUUID(),
    membershipId: randomUUID(),
  });
  const fixture = { a: makeIds(), b: makeIds() };
  await database.transaction(async (transaction) => {
    for (const [label, ids] of Object.entries(fixture)) {
      await transaction.insert(tenants).values({
        id: ids.tenantId,
        name: `Studio ${label}`,
        slug: `studio-${ids.tenantId}`,
      });
      await transaction.insert(users).values({
        id: ids.userId,
        email: `developer-${ids.userId}@example.test`,
        displayName: `Developer ${label}`,
      });
      await transaction.insert(tenantMemberships).values({
        id: ids.membershipId,
        tenantId: ids.tenantId,
        userId: ids.userId,
        role: label === 'a' ? 'owner' : 'viewer',
      });
      await transaction.insert(developerProfiles).values({
        id: ids.profileId,
        tenantId: ids.tenantId,
        displayName: `Developer ${label}`,
        headline: 'Full-stack developer',
        summary: 'Builds reliable web applications',
        location: 'Bangkok',
        yearsExperience: 5,
        hourlyRate: '125.50',
        availability: { hoursPerWeek: 20 },
        skills: ['TypeScript', 'PostgreSQL'],
        serviceAreas: ['Web development'],
        preferredProjectTypes: ['SaaS'],
        excludedProjectTypes: ['Gambling'],
        portfolioUrl: null,
        githubUrl: null,
      });
      await transaction.insert(clients).values({
        id: ids.clientId,
        tenantId: ids.tenantId,
        name: `Client ${label}`,
      });
      await transaction.insert(projects).values({
        ...projectInput(ids.tenantId, ids.clientId),
        id: ids.projectId,
      });
    }
  });
  return fixture;
}

export type TenantFixtures = Awaited<ReturnType<typeof seedTwoTenants>>;

export async function removeTenantFixtures(database: Database, fixture: TenantFixtures) {
  const tenantIds = [fixture.a.tenantId, fixture.b.tenantId];
  const userIds = [fixture.a.userId, fixture.b.userId];
  await database.transaction(async (transaction) => {
    await transaction.delete(projectNotes).where(inArray(projectNotes.tenantId, tenantIds));
    await transaction.delete(projectBlockers).where(inArray(projectBlockers.tenantId, tenantIds));
    await transaction.delete(projectEvidence).where(inArray(projectEvidence.tenantId, tenantIds));
    await transaction.delete(projects).where(inArray(projects.tenantId, tenantIds));
    await transaction.delete(clients).where(inArray(clients.tenantId, tenantIds));
    await transaction
      .delete(developerProfiles)
      .where(inArray(developerProfiles.tenantId, tenantIds));
    await transaction
      .delete(tenantMemberships)
      .where(inArray(tenantMemberships.tenantId, tenantIds));
    await transaction.delete(users).where(inArray(users.id, userIds));
    await transaction.delete(tenants).where(inArray(tenants.id, tenantIds));
  });
}
