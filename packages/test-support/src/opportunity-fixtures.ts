import { randomUUID } from 'node:crypto';
import type { Database } from '@beloveddev/database/client';
import { opportunities } from '@beloveddev/database/schema';

type NewOpportunity = typeof opportunities.$inferInsert;
type OpportunityOverrides = Partial<Omit<NewOpportunity, 'tenantId'>>;

export async function seedOpportunity(
  database: Database,
  tenantId: string,
  overrides: OpportunityOverrides = {},
) {
  const [opportunity] = await database
    .insert(opportunities)
    .values({
      tenantId,
      source: 'manual',
      externalId: randomUUID(),
      title: 'Build a reliable SaaS platform',
      clientName: 'Example Client',
      description: 'Design and implement a production TypeScript application.',
      projectType: 'SaaS',
      budgetType: 'fixed',
      amountMin: '5000.00',
      amountMax: '10000.00',
      currency: 'USD',
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      preferredSkills: ['Docker'],
      status: 'new',
      sourceUrl: 'https://example.test/opportunities/1',
      publishedAt: new Date('2026-09-01T12:00:00.000Z'),
      ...overrides,
    })
    .returning();
  if (!opportunity) throw new Error('Opportunity fixture insert returned no row.');
  return opportunity;
}
