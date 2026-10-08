import type {
  OpportunityListQuery,
  OpportunityRepository,
} from '@beloveddev/application/repositories';
import { RepositoryError } from '@beloveddev/application/repository-error';
import type { RepositoryDatabase } from '@beloveddev/database/client';
import { opportunities } from '@beloveddev/database/schema';
import { opportunityStatuses } from '@beloveddev/domain/entities';
import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { repositoryQuery } from './repository-query.js';

const listQuerySchema = z.strictObject({
  tenantId: z.uuid(),
  status: z.enum(opportunityStatuses).optional(),
  source: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100),
  after: z
    .strictObject({
      id: z.uuid(),
      orderingTimestamp: z.iso.datetime({ precision: 6 }),
    })
    .optional(),
});

export class PostgresOpportunityRepository implements OpportunityRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listPage(input: OpportunityListQuery) {
    const parsed = listQuerySchema.safeParse(input);
    if (!parsed.success) throw new RepositoryError('INVALID_INPUT');
    const values = parsed.data;
    const pattern =
      values.query === undefined ? undefined : `%${values.query.replace(/[\\%_]/g, '\\$&')}%`;
    const orderingTimestamp = sql`coalesce(${opportunities.publishedAt}, ${opportunities.createdAt})`;
    const orderingTimestampText = sql<string>`to_char(
      ${orderingTimestamp} AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )`;

    return repositoryQuery(async () => {
      const rows = await this.database
        .select({ opportunity: opportunities, orderingTimestamp: orderingTimestampText })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.tenantId, values.tenantId),
            values.status === undefined ? undefined : eq(opportunities.status, values.status),
            values.source === undefined ? undefined : eq(opportunities.source, values.source),
            pattern === undefined
              ? undefined
              : or(
                  ilike(opportunities.title, pattern),
                  ilike(opportunities.clientName, pattern),
                  ilike(opportunities.description, pattern),
                  ilike(opportunities.projectType, pattern),
                ),
            values.after === undefined
              ? undefined
              : or(
                  sql`${orderingTimestamp} < ${values.after.orderingTimestamp}::timestamptz`,
                  and(
                    sql`${orderingTimestamp} = ${values.after.orderingTimestamp}::timestamptz`,
                    lt(opportunities.id, values.after.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(orderingTimestamp), desc(opportunities.id))
        .limit(values.limit + 1);
      const pageRows = rows.slice(0, values.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(({ opportunity }) => opportunity),
        nextPosition:
          rows.length > values.limit && last
            ? { id: last.opportunity.id, orderingTimestamp: last.orderingTimestamp }
            : null,
      };
    });
  }
}
