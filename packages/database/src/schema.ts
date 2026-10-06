import {
  evidenceTypes,
  blockerSeverities,
  blockerStatuses,
  noteCategories,
  clientStatuses,
  membershipRoles,
  projectStatuses,
  recordStatuses,
  type DeveloperProfile,
} from '@beloveddev/domain/entities';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
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

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

export const recordStatus = pgEnum('record_status', recordStatuses);
export const membershipRole = pgEnum('membership_role', membershipRoles);
export const clientStatus = pgEnum('client_status', clientStatuses);
export const projectStatus = pgEnum('project_status', projectStatuses);
export const evidenceType = pgEnum('evidence_type', evidenceTypes);
export const blockerSeverity = pgEnum('blocker_severity', blockerSeverities);
export const blockerStatus = pgEnum('blocker_status', blockerStatuses);
export const noteCategory = pgEnum('note_category', noteCategories);

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
    unique('projects_tenant_id_unique').on(table.tenantId, table.id),
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

// Keep Milestone 1 check definitions stable; new arrays use strict JSONPath
// so nested arrays, including empty arrays, cannot be implicitly unwrapped.
const strictStringArray = (column: AnyPgColumn) => sql`
  CASE WHEN jsonb_typeof(${column}) = 'array'
    THEN NOT jsonb_path_exists(${column}, 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
`;

export const projectEvidence = pgTable(
  'project_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    type: evidenceType('type').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    details: text('details').notNull(),
    skills: jsonb('skills').$type<readonly string[]>().notNull().default([]),
    capabilities: jsonb('capabilities').$type<readonly string[]>().notNull().default([]),
    businessOutcomes: jsonb('business_outcomes').$type<readonly string[]>().notNull().default([]),
    searchVector: tsvector('search_vector').notNull().generatedAlwaysAs(sql`
        setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce("summary", '')), 'B') ||
        setweight(to_tsvector('english'::regconfig, coalesce("details", '')), 'C') ||
        setweight(to_tsvector('english'::regconfig,
          coalesce("skills"::text, '') || ' ' ||
          coalesce("capabilities"::text, '') || ' ' ||
          coalesce("business_outcomes"::text, '')
        ), 'D')
      `),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'project_evidence_tenant_project_fk',
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('restrict'),
    index('project_evidence_tenant_project_created_idx').on(
      table.tenantId,
      table.projectId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('project_evidence_search_vector_idx').using('gin', table.searchVector),
    check('project_evidence_title_nonblank', sql`${table.title} ~ '[^[:space:]]'`),
    check('project_evidence_summary_nonblank', sql`${table.summary} ~ '[^[:space:]]'`),
    check('project_evidence_details_nonblank', sql`${table.details} ~ '[^[:space:]]'`),
    check('project_evidence_skills_array', strictStringArray(table.skills)),
    check('project_evidence_capabilities_array', strictStringArray(table.capabilities)),
    check('project_evidence_business_outcomes_array', strictStringArray(table.businessOutcomes)),
  ],
);

export const projectBlockers = pgTable(
  'project_blockers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    severity: blockerSeverity('severity').notNull(),
    status: blockerStatus('status').notNull().default('open'),
    blockedSince: timestamp('blocked_since', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'project_blockers_tenant_project_fk',
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('restrict'),
    index('project_blockers_tenant_status_blocked_idx').on(
      table.tenantId,
      table.status,
      table.blockedSince,
      table.id,
    ),
    index('project_blockers_tenant_project_status_blocked_idx').on(
      table.tenantId,
      table.projectId,
      table.status,
      table.blockedSince,
      table.id,
    ),
    check('project_blockers_title_nonblank', sql`${table.title} ~ '[^[:space:]]'`),
    check('project_blockers_description_nonblank', sql`${table.description} ~ '[^[:space:]]'`),
    check(
      'project_blockers_resolution_consistent',
      sql`
      (${table.status} = 'open' AND ${table.resolvedAt} IS NULL)
      OR (${table.status} = 'resolved' AND ${table.resolvedAt} IS NOT NULL)
    `,
    ),
    check('project_blockers_dates_ordered', sql`${table.resolvedAt} >= ${table.blockedSince}`),
  ],
);

export const projectNotes = pgTable(
  'project_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    category: noteCategory('category').notNull(),
    content: text('content').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_notes_tenant_project_fk',
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_notes_tenant_author_fk',
      columns: [table.tenantId, table.authorUserId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }).onDelete('restrict'),
    unique('project_notes_tenant_author_idempotency_unique').on(
      table.tenantId,
      table.authorUserId,
      table.idempotencyKey,
    ),
    index('project_notes_tenant_project_created_idx').on(
      table.tenantId,
      table.projectId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('project_notes_content_nonblank', sql`${table.content} ~ '[^[:space:]]'`),
    check('project_notes_idempotency_key_nonblank', sql`${table.idempotencyKey} ~ '[^[:space:]]'`),
  ],
);
