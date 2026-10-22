# Database, tenancy, project knowledge, and opportunities

## Scope and package boundaries

Exactly eleven tables are implemented: tenants, users, tenant_memberships,
developer_profiles, clients, projects, project_evidence, project_blockers, and
project_notes, opportunities, and audit_logs. The executable composes seven
read-only MCP tools and the transactional `create_project_note` mutation.

- `domain/entities` defines portable records and status/role values.
- `application/repositories` defines explicit repository contracts.
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
trusted request context and are enforced by the M7-A application command.
Inactive memberships can retain history; referenced memberships cannot be deleted.
The database alone does not authorize note creation.

`UNIQUE(tenant_id, author_user_id, idempotency_key)` applies across projects.
Different authors or tenants may reuse a key. M7-A adds a dedicated transaction
adapter for note creation, exact retries, and durable auditing. Read-only suites
retain SELECT-only knowledge access; note-write suites explicitly opt into INSERT
on notes/audits. There is no append-only trigger preventing administrative updates.

## M7-A audit storage and transaction

Migration `0004_project_note_audit` adds `audit_logs` without changing applied
migrations or existing note rows. A composite unique key on note tenant/ID/author
supports an audit foreign key binding all three fields. Existing IDs already
guarantee uniqueness; building the supporting index still takes a table lock and
should be scheduled for a populated deployment.

The audit table records UUID identity, tenant, actor, resource, request ID, action,
resource type, safe JSONB metadata, and a database timestamp. Only note creation
is supported in this slice. Checks restrict action/type and metadata to exactly
the project/category fields. The tenant/action/resource unique constraint prevents
duplicate creation audits. Historical notes remain unchanged with no invented
audit history.

The adapter uses an explicit READ COMMITTED transaction for project verification,
`INSERT ... ON CONFLICT DO NOTHING`, retry lookup, and audit insertion. The unique
index serializes competing keys; a separate statement observes the committed
winner after a blocked insert. Exact project/category/content comparison decides
retry versus conflict. New notes and audits commit together, including failures
raised at deferred-constraint/commit time. The adapter never updates or deletes
either record and never automatically retries a failed transaction.

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
migration history. `db:migrate` requires the explicit administrative
`DATABASE_MIGRATION_URL` and optional `DATABASE_MIGRATION_TLS_CA`. It never falls
back to runtime or test credentials/CA. It serializes through PostgreSQL, validates
the recorded history, uses Drizzle's transactional migrator, and closes its
dedicated session. Repeated execution preserves existing ledger hashes and IDs.
Schema push is not part of this workflow.

Database URLs are supplied per process. Migration commands require an owner/migration
role. The stdio application must use a separate restricted role. Deployment
must include the migrations directory beside the database package's `dist` directory.

Keep administrator settings in a separate protected file, outside the runtime
launcher configuration. After `npm run build`, run the migration script directly
with that file, for example `node --env-file=/absolute/migrations.env scripts/migrate.ts`.
Use `docker compose --env-file=/absolute/database.env up -d --wait` for Compose
administration once the repository `.env` contains only runtime settings.
Integration verification needs `TEST_DATABASE_URL` injected into the test process
from the administrative configuration; never inject that variable or Compose's
administrator password into the MCP subprocess. Existing process values override
env-file values, so clear stale administrator `DATABASE_URL` exports before launching
the server. The readiness gate will reject an accidentally inherited privileged URL.

### M8-H1 administrative execution policy

Use an owner/migration login with CONNECT, database/schema CREATE and ownership
of the existing migration objects (or a deliberately provisioned equivalent).
The migration process never grants privileges or promotes the runtime role.
Keep all administrative variables out of MCP launchers, including
`DATABASE_MIGRATION_URL`, its CA, `TEST_DATABASE_URL`, and Compose passwords.
The CLI needs no MCP identity, cursor secret, runtime URL, or NODE_ENV setting.

The dedicated policy reuses M8-D's URL validation: explicit username, password,
host, port, and database; loopback-only plaintext; remote `sslmode=verify-full`
with certificate-chain/hostname verification and TLS 1.2 minimum. Private CA PEM
contents use only `DATABASE_MIGRATION_TLS_CA` (1–65,536 characters). Only unique
`sslmode` and `application_name` URL parameters are accepted; the migration
session always uses `application_name=beloveddev-migrate`. Endpoint, session-role,
and TLS URL overrides are rejected. Explicit driver fields override ambient PG*
endpoint, credentials, SSL negotiation, client encoding, and session options.
As with runtime, protect the selected env file and remove stale exported
`DATABASE_MIGRATION_*` values: Node process variables take precedence over files.

After building, these commands work from the repository root (quote paths with
spaces). Neither command performs a backup:

```powershell
npm run build
node --env-file="C:/protected/migrations.env" scripts/migrate.ts
```

```sh
npm run build
node --env-file=/protected/migrations.env scripts/migrate.ts
```

Alternatively `npm run db:migrate` builds and reads the optional repository `.env`;
inject the explicit migration variables or place them in a protected admin-only
file. Do not put administrator secrets in a shared runtime env file.

The executor owns one physical `pg.Client`, never a pool. PostgreSQL's session
advisory lock `(0x42444556, 1)` is database-scoped and held by that same session
through ledger preflight, actual Drizzle DDL/transaction/commit, and postflight.
Executors targeting one database queue at this lock; different databases do not
block each other. Successful execution explicitly unlocks, verifies release, and
closes the connection before reporting success. Failure destroys the owned socket;
the server releases the session lock when it detects termination. Arbitrary
administrative SQL or an older migration executable can bypass this cooperative
protocol: require all deployment operators to use the reviewed executor.

| Limit                | Default              | Administrative override                       | Reason                                                   |
| -------------------- | -------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Connect/auth/TLS     | 5 seconds            | `DATABASE_MIGRATION_CONNECT_TIMEOUT_MS`       | Fail promptly on unreachable/stalled endpoints           |
| Advisory acquisition | 10 seconds           | `DATABASE_MIGRATION_ADVISORY_LOCK_TIMEOUT_MS` | Permit short overlap without waiting indefinitely        |
| Each other lock wait | 5 seconds            | `DATABASE_MIGRATION_LOCK_TIMEOUT_MS`          | Bound impact from active runtime transactions            |
| Each SQL statement   | 120 seconds          | `DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS`     | Allow V1 DDL longer than runtime's 10-second policy      |
| Overall operation    | 300 seconds          | `DATABASE_MIGRATION_OPERATION_TIMEOUT_MS`     | Bound connection, lock, migration, and verification work |
| Cleanup ceiling      | 5 additional seconds | Fixed                                         | Bound disconnect even after operation expiry             |

Overrides are positive decimal integer milliseconds, at most 3,600,000 per value;
zero, signs, whitespace, fractions, exponent notation, and unbounded values fail
closed. The overall deadline can expire before any individual limit. During lock
acquisition both PostgreSQL lock_timeout and statement_timeout use the advisory
limit; afterward the separate DDL limits apply. PostgreSQL transaction_timeout
uses the remaining overall budget before migration execution. Idle transactions
also have the statement-duration ceiling. An absolute monotonic timer destroys
the socket on expiry; this is not merely a Promise timeout. PostgreSQL timeouts
bound remote work even if disconnect detection is delayed. Large production
datasets need reviewed DDL planning and explicitly chosen bounds; these defaults
are intended for the current small V1 schema, not measured production capacity.
The server-side behavior follows PostgreSQL 18's
[timeout policy](https://www.postgresql.org/docs/18/runtime-config-client.html)
and [advisory lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).

### Failure diagnosis and manual recovery

All CLI failures return nonzero with one safe structured stderr event,
`database.migration_failed`, `outcome=unconfirmed`, duration, and category:
`CONFIGURATION`, `CONNECTION`, `IDENTITY`, `MIGRATION_FILES`, `LEDGER`,
`ADVISORY_LOCK_TIMEOUT`, `LOCK_TIMEOUT`, `STATEMENT_TIMEOUT`, `SQL_FAILURE`,
`INTERRUPTED`, `OPERATION_TIMEOUT`, `CLEANUP`, or unexpected `INTERNAL`.
No raw exception, SQL, parameters, URL, password, CA, or filesystem path is logged.
SIGINT/SIGTERM use the same abort/cleanup path. Forced Windows termination and
SIGKILL cannot run handlers. No failure initiates an automatic retry.

Drizzle 0.45.3 creates its schema/ledger scaffolding outside its migration
transaction. It applies all pending committed SQL and ledger rows in one
transaction using the dedicated client. The existing chain uses transactional
DDL; future SQL must be reviewed for transaction compatibility. A failed first
run may leave empty ledger scaffolding. Connection loss near COMMIT may mean the
transaction committed without an acknowledgement. Neither a timeout, an abort,
nor nonzero exit proves rollback. Do not infer rollback from an absent CLI success
message. Server disconnect detection/rollback may finish after client cleanup.

Before Drizzle executes, the ledger must exactly match a prefix of the committed
hash/timestamp sequence. Afterward it must match the complete sequence. Gaps,
duplicates, changed hashes/timestamps, or future entries fail with `LEDGER`.
Drizzle's own latest-timestamp check is insufficient for this invariant. Missing
or malformed ledger structures fail safely; nothing edits history automatically.
This executor does not certify arbitrary schema drift: M8-D remains authoritative.

1. Stop deployment orchestration; keep the runtime stopped if readiness fails.
   Preserve diagnostics and the exact deployed migration artifact/SQL bytes.
2. As a trusted administrator on the intended database, inspect `pg_stat_activity`
   for `application_name='beloveddev-migrate'` and `pg_locks` for advisory keys
   classid=1111770454, objid=1, objsubid=2 in that database. Verify the session's
   identity before taking action. Do not kill an unidentified backend or bypass a
   held lock. Wait for a known executor to finish or escalate to its owner.
3. Inspect `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY
created_at, id` read-only. Compare every row with the reviewed journal and the
   SHA-256 of the exact committed SQL bytes. An absent table can be normal before
   the first run; unexplained history/schema disagreement requires investigation.
   Do not delete ledger rows, regenerate applied SQL, or stamp versions manually.
4. Once the prior session/transaction has ended and history is an intact prefix,
   inspect the actual schema for partial or out-of-band work. Resolve only through
   a reviewed manual incident/change procedure. No automatic drift repair exists.
5. A manual rerun with the same reviewed artifacts is safe only after establishing
   that the target, history, schema, and ownership are consistent. A fully current
   ledger results in no reapplication. Lost commit acknowledgements require this
   inspection before deciding to rerun. Lock contention alone is safe to retry
   manually once the known holder has released the lock.
6. Provision/verify the separate least-privilege runtime role using the SQL below.
   Launch the compiled runtime with its minimal protected runtime env file. Its
   read-only M8-D probe checks PostgreSQL 18, identity, schema signature, complete
   ledger, and effective grants before emitting `mcp.ready`. Nonzero startup or
   missing readiness must be investigated; migrations never bypass that gate.

The direct Node entrypoint leaves stdout empty and logs on stderr; the npm wrapper
also prints build/lifecycle output. PostgreSQL's own administrator
logs may contain SQL under server logging policies and require separate access
controls. Advisory locks do not provide backups, rollback after commit, zero
downtime, or a substitute for operational monitoring. M8-H2 implements separate
logical backup validation and isolated restore drills; see the
[recovery runbook](recovery.md). Deployment-specific RPO/RTO, scheduling,
retention and encrypted/off-site storage still require owner decisions.
Milestone 8 remains incomplete.

### M8-H2 recovery boundary

`database/recovery` runs PostgreSQL 18 pg_dump/pg_restore outside MCP startup.
Explicit backup and restore administrator URLs/CA settings never fall back to
runtime/test/migration credentials. The H1 shared lock and exported read-only
snapshot bind the dump to deterministic full-row digests for all eleven tables
and the complete migration ledger. Private new-only artifact directories hold a
custom archive and strict Zod completion/integrity metadata. Validation checks
the entire archive; a real isolated restore is required to prove recoverability.

Restores create only generated disposable databases/roles. They never accept an
existing destination name, restore source grants/ownership, or replace production.
Strict transactional pg_restore is followed by exact data, ledger and reviewed
schema verification, explicit reconstruction of the existing M8-D runtime grants,
and unchanged restricted-role readiness. Catalog ownership/OIDs are verified
before target retirement. Interruption/deadlines fail closed without claiming
rollback; cleanup failure remains failure. The runbook covers platform permissions,
TLS, encryption responsibilities, manual incident recovery and owner decisions.
Real PostgreSQL drills verify MCP reads, tenant refusal, search indexes, audited
note identity and retry without duplicate audit. No schema/MCP/auth changes occur.

For a local runtime role, provision privileges outside schema migrations so
environment-specific credentials are never committed. For example, using psql
against the target database as its administrator:

```sql
CREATE ROLE beloveddev_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
\password beloveddev_runtime
-- Replace beloveddev with the actual application database identifier.
REVOKE CREATE, TEMPORARY ON DATABASE beloveddev FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE beloveddev TO beloveddev_runtime;
GRANT USAGE ON SCHEMA public, drizzle TO beloveddev_runtime;
GRANT SELECT ON drizzle.__drizzle_migrations TO beloveddev_runtime;
GRANT SELECT ON tenant_memberships, developer_profiles, clients, projects,
  project_evidence, project_blockers, project_notes, opportunities TO beloveddev_runtime;
GRANT SELECT (id, status) ON tenants, users TO beloveddev_runtime;
-- Required for the create_project_note MCP tool (M7-B):
GRANT INSERT ON project_notes, audit_logs TO beloveddev_runtime;
```

Use a fresh non-owner role without additional grants or role memberships. Do not
grant UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, schema/database CREATE,
TEMPORARY, sequence access, unrelated INSERT, SELECT on audit_logs, or grant options.
The runtime must not own database/schema/table/type/function objects or reach a
privileged role through inheritance or SET ROLE. Callable user-defined SECURITY
DEFINER functions are rejected. PUBLIC grants count as effective privileges.
System-schema CREATE and ownership are rejected too. System table/column and
builtin-function capabilities are limited to PostgreSQL's initial PUBLIC grants
recorded in `pg_init_privs` (or its default ACL where no initial override exists).
The SQL-standard `information_schema` has no recorded initial ACLs; its metadata
SELECT access is permitted explicitly, while extra writes/grant options are denied.
Extra credential-catalog reads, catalog writes, privileged builtin execution, and
grant options fail readiness, including grants supplied through PUBLIC or roles.
Keep migration/administrator credentials out of the runtime process environment.
Both stdio suites now use `mcpRuntime: true` provisioning: all eight tools require
the two append-only INSERT grants even when a particular principal is read-only.
Older repository fixtures retain their internal project-insert grant and are
intentionally not suitable for the MCP executable. No grants run during startup.

### M8-D connection and readiness policy

The supported database major is PostgreSQL 18. Before `mcp.ready` or application
request handling, one 10-second deadline covers acquisition and read-only checks:

- A working connection to a writable primary, with default read-write transactions.
- Reported database, session role, and active role matching the explicit database
  and user configured on the physical pg client. Mismatches fail with a static
  `IDENTITY` category; names and credentials are not logged. Proxies must preserve
  these identities rather than silently routing to another database or login role.
- The committed migration ledger's complete ordered hashes and timestamps.
- A reviewed catalog SHA-256 signature of the public relations, columns/types,
  defaults, generated expressions, constraints, indexes, enum order, RLS flags,
  triggers and rewrite rules. Missing, modified, or future schema fails closed.
- Effective required and forbidden privileges, including column grants, PUBLIC,
  inherited/NOINHERIT membership paths, ownership, and privileged role attributes.

Checks run in a read-only transaction and roll back. Failure/timeout destroys the
probe connection; a connection acquired after expiry is also destroyed. No tool
can resolve context or access repositories before this gate. Startup failures
log only safe categories and use the M8-C cleanup path. EOF/signals during the
probe still shut down normally; fatal pool failures retain nonzero exit status.
The existing 5-second connection, 10-second statement, and 15-second shutdown
bounds remain. There is no HTTP health endpoint. Protocol initialization/tool
discovery only become available after the gate; `mcp.ready` is the stderr
operational signal when info logging is enabled.

The schema signature is deliberately strict for a dedicated application database.
After an approved schema change, review the catalog query and regenerate its
constant from a fresh database migrated from committed SQL, never from a live
database with unexplained drift. Deploy reviewed migrations with a separate
administrator process before starting the runtime. Package the unchanged
`packages/database/migrations` alongside `dist`; startup reads these files but
never applies migrations, repairs schema, or grants itself permissions.
The deployed SQL bytes (including line endings) must match the artifacts used
by the migrator, because Drizzle records hashes of those exact bytes.

| Configured endpoint             | Transport setting                                    | Result                                                     |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Explicit loopback, no custom CA | SSL mode absent or `disable`                         | Plaintext allowed under local-host trust                   |
| Any endpoint                    | `verify-full`                                        | TLS 1.2+, certificate-chain and host verification required |
| Non-loopback                    | SSL mode absent or `disable`                         | Rejected                                                   |
| Any endpoint with a custom CA   | Any mode other than `verify-full`                    | Rejected                                                   |
| Any endpoint                    | Unverified/ambiguous modes or overriding URL options | Rejected                                                   |

The loopback exception trusts the OS/network namespace and the local PostgreSQL
endpoint. It provides neither channel encryption nor cryptographic server
identity. A loopback forwarder can lead to a remote database; this cannot be
inferred from the URL. Such deployments must use verified TLS, with the server
certificate matching the configured host, rather than relying on this exception.

Remote connections require `DATABASE_URL=postgresql://.../database?sslmode=verify-full`.
Node verifies both certificate chain and hostname, with TLS 1.2 minimum. For a
private CA, inject PEM contents through optional `DATABASE_TLS_CA` (1–65,536
characters); otherwise Node's trust store applies. A CA requires verify-full even
for loopback. Invalid certificates, wrong hostnames, and servers without TLS
fail closed; there is no downgrade. Keep CA/configuration integrity protected.

Plaintext is allowed only for explicit `127.0.0.1`, `::1`, or `localhost`; plaintext
localhost is pinned to IPv4 loopback. Containers/private-network hostnames and
private IPs are remote and require TLS. Only absent/`disable` (loopback) or
`verify-full` SSL modes are supported. Username, password, and database are explicit.
The only accepted URL query keys are `sslmode` and `application_name`, each once.
URL endpoint/session-role/SSL overrides and ambiguous modes such as `require`,
`prefer`, `verify-ca`, and `no-verify` are rejected. Explicit pg connection fields
prevent ambient PG* variables from replacing credentials, endpoint, TLS, or
session options. `search_path=public` keeps PostgreSQL's implicit catalog-first
lookup and excludes user schemas; TEMPORARY and schema CREATE privileges are denied.

These are startup checks, not continuous grant monitoring or independent proof
that the database administrator is trustworthy. Administrators can change schema
or grants after readiness. A later revoked write grant still causes the existing
safe application error and atomic rollback. There is no RLS: stolen runtime
credentials can read all granted tenants and append directly to notes/audits.
Protect the local account, launcher, runtime credentials, database administrators,
and migration artifacts. Backup/restore drills, release packaging, and an approved
production authentication profile remain separate requirements.

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
$env:DATABASE_MIGRATION_URL = $env:DATABASE_URL
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
