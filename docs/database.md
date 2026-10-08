# Database, tenancy, project knowledge, and opportunities

## Scope and package boundaries

Exactly ten tables are implemented: tenants, users, tenant_memberships,
developer_profiles, clients, projects, project_evidence, project_blockers, and
project_notes, plus opportunities. The executable composes the implemented
read-only MCP tools; opportunity listing remains application-only in Milestone 5-A.

- `domain/entities` defines portable records and status/role values.
- `application/repositories` defines eight explicit repository contracts.
- `database/schema` contains Drizzle definitions; `database/client` owns pools.
- `infrastructure/postgres` implements scoped queries and safe failures.
- `test-support` provisions disposable databases and reusable two-tenant fixtures.

No core package imports Drizzle. The database package may use core status values
and record types. Test-only dependencies do not reverse production dependencies.

## Schema decisions

| Concern                       | Decision                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| IDs                           | UUID primary keys with PostgreSQL `gen_random_uuid()` defaults                                                |
| Timestamps                    | `timestamptz`, returned as JavaScript Dates; creation defaults use `now()`                                    |
| Updates                       | No update API exists. Future writers must set `updated_at` explicitly; there is no hidden ORM hook or trigger |
| Tenant/user/membership status | PostgreSQL enum: `active`, `inactive`                                                                         |
| Membership role               | PostgreSQL enum: `owner`, `member`, `viewer`                                                                  |
| Client status                 | PostgreSQL enum: `active`, `archived`                                                                         |
| Project status                | PostgreSQL enum matching the five specified states                                                            |
| Email identity                | Global unique index on `lower(email)`; stored values retain case and must be nonblank and trimmed             |
| Slugs                         | Lowercase ASCII words separated by hyphens; globally unique for tenants, unique within a tenant for projects  |
| Money                         | `numeric(12,2)`, nonnegative and finite; returned as a decimal string                                         |
| Experience                    | Nonnegative `smallint`, explicitly supplied                                                                   |
| JSONB collections             | Arrays of strings; database checks reject objects, non-string elements, and JSON null                         |
| Availability                  | JSONB object; its business shape is intentionally not specified yet                                           |
| Deletion                      | Foreign keys restrict deletion; no cascading tenant deletion                                                  |
| Project dates                 | Both are optional; when both exist, completion cannot precede start                                           |
| Opportunity source            | Required lowercase hyphenated slug, at most 100 characters                                                    |
| Opportunity budget type       | Nullable enum: `fixed`, `hourly`                                                                              |
| Opportunity status            | PostgreSQL enum matching the eight specified states                                                           |

Users are global identities and may belong to multiple tenants. Email uniqueness
does not implement email verification, account linking, or authentication. Those
decisions belong to the later authentication boundary.

Profile rate and profile URLs are nullable: an unpublished rate differs from a
zero rate, and a profile may have no public links. Project client, dates, and URLs
are nullable for the reasons in the specification. Other fields are NOT NULL.
Milestone 1 narrative fields may be empty strings; an absent client note defaults to an empty
string. Arrays default to `[]`, and availability defaults to `{}`.

No currency column was added to the specified profile model. Rates have no
cross-currency interpretation in this milestone. Currency semantics must be
settled before budget comparisons or pricing behavior.

## Same-tenant project/client relationship

`projects(tenant_id, client_id)` references `clients(tenant_id, id)`.
A matching composite unique constraint on clients supports this foreign key.
The extra unique index is justified by the ownership invariant, even though
client IDs are globally unique.

This prevents cross-tenant references during inserts, project updates, and client
ownership changes, including direct SQL. PostgreSQL's default MATCH SIMPLE allows
a null client, while the separate project-to-tenant foreign key still requires a
valid tenant. There is no application-only precheck susceptible to a race.

Other uniqueness constraints enforce tenant/user membership, one profile per
tenant, and project slug uniqueness within a tenant.

Milestone 1 indexes are supplied by primary keys and uniqueness constraints, plus
`projects(tenant_id, status)` for the implemented filtered listing. A speculative
client status index was not added: the current client API only looks up a scoped
ID and uses the composite unique index. There are no search indexes.

## Project knowledge invariants and indexes

All three child tables require an existing tenant and a project in that same tenant.
Their `(tenant_id, project_id)` foreign keys reference a new
`UNIQUE(tenant_id, id)` constraint on projects. This repeats the project/client
strategy and prevents invalid inserts, child updates, parent reassignment, and
parent deletion. All foreign keys use restricted deletion.

Evidence type, blocker severity/status, and note category are PostgreSQL enums
matching the domain model. Evidence title/summary/details, blocker
title/description, and note content/idempotency key are NOT NULL and must contain
a non-whitespace character. PostgreSQL POSIX whitespace checks reject empty strings,
spaces, tabs, and line breaks. Evidence skills, capabilities, and business outcomes
use JSONB string-array checks and default to `[]`. New evidence checks use strict
JSONPath to reject nested arrays, including empty arrays. The unchanged Milestone 1
checks use lax JSONPath, which can unwrap nested arrays; tightening those existing
profile/stack constraints requires a separate migration outside this milestone.
All specified fields are required except blocker `resolved_at`.

Blockers enforce both directions of the resolution invariant:

- `open` requires `resolved_at IS NULL`.
- `resolved` requires `resolved_at IS NOT NULL`.
- When present, `resolved_at >= blocked_since`.

A future writer must change status and resolution timestamp in the same statement.
Blockers default to open and `blocked_since = now()`; severity is explicit.
These are persistent invariants, not a resolution workflow.

Notes reference the global author user and have a composite foreign key from
`(tenant_id, author_user_id)` to `tenant_memberships(tenant_id, user_id)`.
Membership existence is a stable ownership invariant and belongs in PostgreSQL,
avoiding a check-then-insert race. Membership activity and permissions depend on
trusted request context and belong in the future application mutation.
Inactive memberships can retain history; referenced memberships cannot be deleted.
The database alone does not authorize note creation.

`UNIQUE(tenant_id, author_user_id, idempotency_key)` applies across projects.
Different authors or tenants may reuse a key. No note write repository, retry
result handling, auditing, or update/delete API is added. The runtime test role
has only SELECT privileges on the three knowledge tables; there is no append-only
trigger preventing administrative updates.

Indexes follow the implemented reads:

| Table            | Index columns and order                                  |
| ---------------- | -------------------------------------------------------- |
| project_evidence | tenant_id, project_id, created_at DESC, id DESC          |
| project_evidence | GIN on stored search_vector                              |
| project_notes    | tenant_id, project_id, created_at DESC, id DESC          |
| project_blockers | tenant_id, status, blocked_since ASC, id ASC             |
| project_blockers | tenant_id, project_id, status, blocked_since ASC, id ASC |

Blocker severity is an optional predicate; no additional speculative index is
introduced. Descending queries explicitly use NULLS LAST to match their indexes;
the indexed fields are NOT NULL. UUIDs supply a stable tie-breaker.

Milestone 4-A adds a stored generated `tsvector` to project evidence. It uses the
English configuration and weights title A, summary B, details C, and the JSONB
skills/capabilities/business-outcomes text D. PostgreSQL recomputes the vector on
write without a trigger. A GIN index supports the `@@` predicate. The migration
computes vectors for existing rows while adding the generated column.

## Opportunity invariants and indexes

Opportunities belong directly to a tenant through a restricted foreign key.
`source` is a required lowercase slug of at most 100 characters. When present,
`external_id`, client name, and project type must contain a non-whitespace
character; title and description always must. The partial unique index on
`(tenant_id, source, external_id)` applies only when `external_id IS NOT NULL`,
allowing manual records without an external identity while preventing duplicate
source imports within one tenant.

`budget_type` is nullable and constrained to `fixed` or `hourly`. The generic
`amount_min` and `amount_max` columns use exact nonnegative `numeric(12,2)` values;
when both are present, maximum cannot be lower than minimum. A null budget type
requires both amounts to be null. Any present amount requires a budget type and
an uppercase three-letter currency code. Required and preferred skills are strict
JSONB string arrays and default to empty arrays.

Opportunity listing sorts by `coalesce(published_at, created_at) DESC, id DESC`.
The matching tenant-leading expression index supports this keyset path. Separate
tenant/status and tenant/source indexes support the documented exact filters.
The list query also accepts a literal case-insensitive substring across title,
client name, description, and project type; LIKE metacharacters are escaped and
there is no full-text opportunity search in M5-A.

## Repository behavior

| Contract                   | Operations                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| MembershipRepository       | `getByUser({ tenantId, userId })`                                                         |
| DeveloperProfileRepository | `getByTenant({ tenantId })`                                                               |
| ClientRepository           | `getById({ tenantId, clientId })`                                                         |
| ProjectRepository          | `getById({ tenantId, projectId })`, `list({ tenantId, status?, limit })`, `create(input)` |

The new read-only contracts are:

| Contract              | Method                                                            | Ordering                          |
| --------------------- | ----------------------------------------------------------------- | --------------------------------- |
| EvidenceRepository    | `listByProject(...)`, `search(...)`                               | createdAt DESC; rank DESC, id ASC |
| BlockerRepository     | `listOpen({ tenantId, projectId?, severity?, limit })`            | blockedSince ASC, id ASC          |
| NoteRepository        | `listRecentByProject({ tenantId, projectId, limit })`             | createdAt DESC, id DESC           |
| OpportunityRepository | `listPage({ tenantId, status?, source?, query?, limit, after? })` | effective timestamp DESC, id DESC |

Evidence returns full records including summary and details. Blocker reads always
exclude resolved records. Project and severity filters combine with tenant scope
using AND. All three methods require integer limits from 1 through 100 and return
empty arrays for nonexistent or foreign-tenant projects. Malformed UUIDs/enums and
invalid limits map to safe INVALID_INPUT errors; connection failures map to
UNAVAILABLE. Each read is a single statement with no extra transaction or retry.
The original project-knowledge methods return bounded subsets. Evidence search is
a separate tenant-scoped query using `websearch_to_tsquery('english', query)`, so
callers supply ordinary user text rather than tsquery syntax. It combines the FTS
predicate with optional project IDs, evidence types, and skills in one SQL query.
Project and type lists use any-member semantics. Skill matching also uses
any-member semantics and compares exact trimmed memberships case-insensitively;
it is not fuzzy or substring matching.

`ts_rank_cd` supplies the relevance score. Results sort by rank descending and
evidence UUID ascending. Search keysets carry PostgreSQL's canonical `real` text
plus the UUID, avoiding a JavaScript floating-point round trip in the next-page
predicate. The application signs the cursor and binds it to the trusted tenant and
a SHA-256 fingerprint of the normalized query and filters. Offset pagination is
not used. Like other keyset pagination, a stable dataset is required for a stable
multi-page snapshot; concurrent evidence edits may change rank between calls.

Opportunity pages require trusted tenant scope and a limit from 1 through 100.
Optional status and source filters are exact; source and query are canonicalized
by the application before repository access. The cursor position contains the
effective ordering timestamp at PostgreSQL's six-digit precision and the UUID.
The application signs it and binds it to the tenant plus normalized status,
source, and query semantics. M5-A supports no project-type, skill, budget, or
client-name filter beyond the documented cross-field query, so there are no
unbound filter semantics.

Tenant and user repositories are deferred because no current use case needs them.
Lookups return `null` for both nonexistent and cross-tenant identifiers. SQL
contains tenant predicates before retrieval. Membership status is returned as
data; repositories do not decide authorization.

Project lists require a limit from 1 through 100 and are ordered by UUID. They are
bounded subsets, not a pagination or search API. Creation requires tenant scope
and explicit project fields; IDs and timestamps are assigned by PostgreSQL.

The create operation is one atomic INSERT. The composite foreign key enforces
ownership without a separate transaction or check-then-write race. Duplicate
tenant slugs fail with CONFLICT, including concurrent inserts. This is a storage
primitive, not an authenticated or audited user-facing mutation. No automatic
retry, idempotency contract, or MCP write operation is introduced here.

Infrastructure maps driver failures to `RepositoryError` with one of
`CONFLICT`, `INVALID_REFERENCE`, `INVALID_INPUT`, or `UNAVAILABLE`. Missing
and cross-tenant client references share the same safe failure. Raw SQL, driver
details, and causes do not cross this boundary. Final application/MCP error
mapping remains deferred.

Every caller must eventually supply tenant IDs from authenticated server context.
Passing a tenant ID is not authorization. There is no row-level security policy:
the protection demonstrated here is scoped repository SQL and database ownership
constraints, not protection against arbitrary SQL using compromised credentials.

## Migrations

The initial migration is `packages/database/migrations/0000_tenancy_foundation.sql`.
Its generated snapshot is unchanged. Milestone 2 adds
`packages/database/migrations/0001_project_knowledge.sql`, its generated snapshot,
and a journal entry. Milestone 4-A adds `0002_evidence_search.sql`, which adds the
stored generated vector and its GIN index without changing existing evidence
fields. Milestone 5-A adds `0003_opportunities.sql`, the two opportunity enums,
the constrained table, and its access-path indexes without modifying existing
rows. The Milestone 2 SQL creates the project composite unique constraint
before adding child foreign keys: Drizzle Kit initially emitted that prerequisite
last, so the new migration's statement order was corrected during review.
The migration adds no data backfill and preserves existing Milestone 1 rows.

Adding the project unique constraint builds an index and takes a table lock.
Schedule migrations appropriately on a populated deployment; the local tests do
not measure production migration duration.

```sh
npm ci
npm run db:generate -- --name=descriptive_change
npm run db:check
npm run db:migrate
```

Generation loads the TypeScript schema and creates SQL plus metadata. Review and
commit all three; do not edit an applied migration. `db:check` validates Drizzle's
migration history. `db:migrate` uses the validated `DATABASE_URL`, applies SQL
through Drizzle's transactional migrator, and closes its pool. It can be rerun
without reapplying recorded migrations. Run one migration process at a time.
Schema push is not part of this workflow.

Database URLs are supplied per process. Migration commands require an owner/migration
role. Future application processes must use a separate restricted role. Deployment
must include the migrations directory beside the database package's `dist` directory.

For a local runtime role, provision privileges outside schema migrations so
environment-specific credentials are never committed. For example, using psql
against the target database as its administrator:

```sql
CREATE ROLE beloveddev_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
\password beloveddev_runtime
GRANT USAGE ON SCHEMA public TO beloveddev_runtime;
GRANT SELECT ON tenant_memberships, developer_profiles, clients, projects,
  project_evidence, project_blockers, project_notes TO beloveddev_runtime;
GRANT INSERT ON projects TO beloveddev_runtime;
```

Supply that role's credentials to the future application, and keep the owner
credentials for migrations. The current test helper provisions equivalent
restricted runtime permissions and verifies them.

## Real PostgreSQL integration tests

`TEST_DATABASE_URL` must explicitly point to a dedicated local/CI administrative
database on the test PostgreSQL instance. There is no fallback to `DATABASE_URL`.
Tests require CREATE DATABASE and CREATE ROLE privileges. Never use production
infrastructure for this test workflow.

Each suite creates a uniquely named empty database, applies the committed
migration chain, and creates a separate non-superuser runtime login. Administrative
connections seed and clean fixtures in transactions. Repository calls use the
restricted login. The fixture relationships and content are fixed; UUID namespaces
vary to avoid collisions. Every test seeds its own two tenants and removes only
their data. Tests have no execution-order dependency.

Teardown closes pools, drops only the database generated by that suite, and removes
its generated role. It never truncates a supplied database. If a test process is
forcibly killed, temporary `beloveddev_test_*` databases/roles may need manual
inspection and cleanup on the dedicated test instance.

```sh
npm run test:integration
npm run verify:all
```

`verify` remains the fast database-independent check; `verify:all` adds migration
history checks and integration tests. Integration coverage includes fresh migration
application, repeat application, reproduction on another empty database, Drizzle
column/constraint/index agreement, restricted privileges, two-tenant reads/writes,
concurrent slug/note-key conflicts, and actual PostgreSQL constraints. An upgrade
test first applies only the committed Milestone 1 migration, seeds all six original
tables, then runs the complete chain and verifies unchanged rows and schema
agreement with a fresh database. Knowledge tests cover required fields, enums,
arrays, same-tenant references, author membership, idempotency, resolution,
repository ordering/limits/filters, and safe invalid-input failures. No PostgreSQL mocks
are used. Opportunity coverage adds the complete constraint matrix, partial
external identity uniqueness, pre-M5 upgrade preservation, tenant isolation,
literal query escaping, all supported filters, deterministic keyset pagination,
and restricted-role reads.

For this machine, use an assigned host port without touching services on 5432 or 55432. From PowerShell, the public local example credentials can be used as follows:

```powershell
$env:POSTGRES_PORT = '0'
docker compose --env-file .env.example up -d --wait
$databaseEndpoint = (docker compose --env-file .env.example port postgres 5432).Trim()
$env:DATABASE_URL = "postgresql://beloveddev:beloveddev_local_only@$databaseEndpoint/beloveddev"
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run db:migrate
npm run verify:all
docker compose --env-file .env.example down
```

The `5432` argument above identifies the container's internal service port; the
host port comes from Docker. The same approach runs in CI. With a fixed host port,
update the two URLs and `POSTGRES_PORT` together in your untracked `.env`.

## Tooling compatibility

Drizzle 0.45.3 declaration files include incompatible optional-driver declarations.
`skipLibCheck` is enabled only in database, infrastructure, test-support, and the
aggregate test/configuration typecheck. Source code still uses all strict flags.
Domain and application builds retain declaration checking. No unrelated database
drivers were installed.

Drizzle Kit's legacy loader includes an older esbuild. A targeted npm override
uses the patched 0.25 line for that nested dependency; migration generation is
verified with the override. Review these workarounds when upgrading Drizzle.

References: [Drizzle constraints](https://orm.drizzle.team/docs/indexes-constraints),
[Drizzle migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate),
and [node-postgres pool lifecycle](https://node-postgres.com/apis/pool).
