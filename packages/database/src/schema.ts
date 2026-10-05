import {
  clientStatuses,
  membershipRoles,
  projectStatuses,
  recordStatuses,
  type DeveloperProfile,
} from '@beloveddev/domain/entities';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const recordStatus = pgEnum('record_status', recordStatuses);
export const membershipRole = pgEnum('membership_role', membershipRoles);
export const clientStatus = pgEnum('client_status', clientStatuses);
export const projectStatus = pgEnum('project_status', projectStatuses);

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const stringArray = (column: AnyPgColumn) => sql`
  jsonb_typeof(${column}) = 'array'
  AND NOT jsonb_path_exists(${column}, '$[*] ? (@.type() != "string")')
`;

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: recordStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    unique('tenants_slug_unique').on(table.slug),
    check('tenants_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('tenants_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    status: recordStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(sql`lower(${table.email})`),
    check(
      'users_email_trimmed',
      sql`${table.email} = btrim(${table.email}) AND length(${table.email}) > 0`,
    ),
    check('users_display_name_nonempty', sql`length(btrim(${table.displayName})) > 0`),
  ],
);

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: membershipRole('role').notNull(),
    status: recordStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tenant_memberships_tenant_user_unique').on(table.tenantId, table.userId)],
);

export const developerProfiles = pgTable(
  'developer_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary').notNull(),
    location: text('location').notNull(),
    yearsExperience: smallint('years_experience').notNull(),
    hourlyRate: numeric('hourly_rate', { precision: 12, scale: 2 }),
    availability: jsonb('availability')
      .$type<DeveloperProfile['availability']>()
      .notNull()
      .default({}),
    skills: jsonb('skills').$type<readonly string[]>().notNull().default([]),
    serviceAreas: jsonb('service_areas').$type<readonly string[]>().notNull().default([]),
    preferredProjectTypes: jsonb('preferred_project_types')
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    excludedProjectTypes: jsonb('excluded_project_types')
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    portfolioUrl: text('portfolio_url'),
    githubUrl: text('github_url'),
    ...timestamps(),
  },
  (table) => [
    unique('developer_profiles_tenant_unique').on(table.tenantId),
    check('developer_profiles_display_name_nonempty', sql`length(btrim(${table.displayName})) > 0`),
    check('developer_profiles_years_experience_nonnegative', sql`${table.yearsExperience} >= 0`),
    check(
      'developer_profiles_hourly_rate_valid',
      sql`${table.hourlyRate} BETWEEN 0 AND 9999999999.99`,
    ),
    check(
      'developer_profiles_availability_object',
      sql`jsonb_typeof(${table.availability}) = 'object'`,
    ),
    check('developer_profiles_skills_array', stringArray(table.skills)),
    check('developer_profiles_service_areas_array', stringArray(table.serviceAreas)),
    check(
      'developer_profiles_preferred_project_types_array',
      stringArray(table.preferredProjectTypes),
    ),
    check(
      'developer_profiles_excluded_project_types_array',
      stringArray(table.excludedProjectTypes),
    ),
  ],
);

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    status: clientStatus('status').notNull().default('active'),
    notes: text('notes').notNull().default(''),
    ...timestamps(),
  },
  (table) => [
    unique('clients_tenant_id_unique').on(table.tenantId, table.id),
    check('clients_name_nonempty', sql`length(btrim(${table.name})) > 0`),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    clientId: uuid('client_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    summary: text('summary').notNull(),
    problemStatement: text('problem_statement').notNull(),
    outcome: text('outcome').notNull(),
    status: projectStatus('status').notNull().default('planned'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stack: jsonb('stack').$type<readonly string[]>().notNull().default([]),
    repositoryUrl: text('repository_url'),
    productionUrl: text('production_url'),
    portfolioUrl: text('portfolio_url'),
    ...timestamps(),
  },
  (table) => [
    unique('projects_tenant_slug_unique').on(table.tenantId, table.slug),
    foreignKey({
      name: 'projects_tenant_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    index('projects_tenant_status_idx').on(table.tenantId, table.status),
    check('projects_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('projects_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('projects_stack_array', stringArray(table.stack)),
    check(
      'projects_dates_ordered',
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);
