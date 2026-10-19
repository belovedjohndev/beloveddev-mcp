# BelovedDev MCP V1 — Implementation Plan

## 1. Delivery Strategy

Build V1 as a sequence of small milestones.

Do not ask Codex or another agent to build the entire system in one task.

Each milestone should end with:

1. relevant implementation;
2. tests;
3. verification commands;
4. documentation alignment;
5. change/risk summary.

## 2. Milestone 0 — Project Foundation

### Goal

Create a clean TypeScript workspace with development infrastructure only.

### Deliverables

```text
workspace/package configuration
strict TypeScript
Vitest
ESLint
Prettier
Docker Compose
PostgreSQL service
environment validation
structured logger
basic CI
repository documentation
```

### Initial Structure

```text
apps/
  mcp-server/

packages/
  domain/
  application/
  database/
  infrastructure/
  mcp/
  shared/
  test-support/

docs/
```

### Do Not Implement Yet

- domain database tables
- MCP tools
- authentication
- authorization
- opportunity scoring
- project-note mutation
- external integrations

### Exit Criteria

- dependencies install successfully;
- TypeScript type-check passes;
- tests execute successfully;
- lint passes;
- formatting check passes;
- PostgreSQL starts via Docker Compose;
- environment validation fails safely on missing required variables;
- logger can be instantiated from the application composition root;
- CI runs the agreed verification commands.

---

## 3. Milestone 1 — Tenancy and Core Project Data

### Goal

Establish database ownership boundaries and basic project records.

### Tables

```text
tenants
users
tenant_memberships
developer_profiles
clients
projects
```

### Deliverables

- Drizzle schema
- first migrations
- database connection
- repository interfaces
- PostgreSQL repository implementations
- fixtures/test builders
- integration-test database strategy
- tenant-isolation tests

### Key Constraints

```text
UNIQUE tenants.slug
UNIQUE tenant_memberships(tenant_id, user_id)
UNIQUE developer_profiles(tenant_id)
UNIQUE projects(tenant_id, slug)
```

Project status must be constrained.

### Exit Criteria

A repository query cannot accidentally read a project belonging to another tenant.

The Milestone 1 implementation includes the six tables above, the initial Drizzle
migration, four explicit repository contracts/adapters, and disposable PostgreSQL
test databases with restricted runtime credentials. Tenant/User repositories,
authentication, and application use cases are deferred until needed.
See [database conventions and verification](database.md) for the implemented
schema decisions and commands.

---

## 4. Milestone 2 — Project Knowledge

### Goal

Make stored projects useful as operational and portfolio knowledge.

### Tables

```text
project_evidence
project_blockers
project_notes
```

### Deliverables

```text
EvidenceRepository
BlockerRepository
NoteRepository
```

plus:

- search-ready evidence representation
- note idempotency constraint
- project-child tenant validation
- representative seed/fixture data

### Exit Criteria

The database can represent:

- what a project proves;
- what is blocking the project;
- append-only contextual notes.

Milestone 2 is implemented with migration `0001_project_knowledge.sql`.
It adds exactly these three tables, project ownership foreign keys, constrained
enums/text/JSONB, the blocker resolution invariant, and note author membership
and idempotency constraints. Evidence and notes have bounded newest-first
project reads; open blockers have bounded oldest-first reads with optional
project and severity filters. UUIDs break timestamp ties.

Real PostgreSQL tests cover constraints, both directions of tenant isolation,
filters, ordering, bounds, safe failures, populated Milestone 1 upgrades, and
reproducible full-chain migrations on fresh databases. See
[database conventions](database.md) for the concrete decisions.

Milestone 3 is complete: the four initial read-only tools run over stdio through
trusted local context, permission checks, application use cases, scoped
repositories, signed cursor pagination, and safe errors/logging.

---

## 5. Milestone 3 — Read-Only MCP Foundation

### Goal

Expose the first useful MCP server backed by PostgreSQL.

### Tools

```text
get_profile
list_projects
get_project
get_blockers
```

### Deliverables

- MCP transport setup
- trusted request context abstraction
- authentication adapter boundary
- permission evaluation
- MCP input/output schemas
- safe application-error mapping
- structured request logs
- MCP contract tests
- authorization tests

### Exit Criteria

An MCP client can retrieve real tenant-scoped profile/project data from PostgreSQL.

The data path must be:

```text
MCP
→ application use case
→ repository interface
→ PostgreSQL adapter
```

No tool handler should contain SQL or domain rules.

---

## 6. Milestone 4 — Portfolio Evidence Search

Milestone 4 is split at the application/interface boundary.

### Milestone 4-A — PostgreSQL and application search

Implemented in this slice:

- stored weighted English full-text vector and GIN index
- `websearch_to_tsquery` user-query parsing
- deterministic `ts_rank_cd DESC, evidence_id ASC` ranking
- tenant, project, evidence-type, and exact normalized skill predicates
- signed rank/ID keyset cursors bound to a normalized search fingerprint
- `SearchProjectEvidence` with `projects:read` authorization
- application and real PostgreSQL tests

Milestone 4-A is complete and retained unchanged.

### Milestone 4-B — MCP exposure

### Goal

Allow agents to retrieve relevant prior work for job/proposal decisions.

### Tool

```text
search_project_evidence
```

### Search Strategy

Use PostgreSQL full-text search plus structured filters.

Do not use embeddings.

Implemented:

- MCP contract tests
- MCP schema, registration, invocation logging, and composition-root wiring
- compiled stdio/PostgreSQL coverage for isolation, filters, and cursor pagination

### Representative Initial Portfolio Data

Useful initial evidence can be prepared for projects such as:

```text
HVAC Estimate Widget
Health Scorecard
AGBI Portal
Job-Fit Engine
OpsGuard AI
Discovery Call Assistant
ReadyFolio
```

Only add evidence that is factual and useful.

### Exit Criteria

Queries such as:

```text
multi-tenant SaaS with PostgreSQL
lead capture estimator
AI production reliability
admin dashboard
```

return relevant structured project evidence.

---

## 7. Milestone 5 — Opportunities

Milestone 5 is split at the application/interface boundary.

### Milestone 5-A — PostgreSQL and application listing

Implemented in this slice:

- tenant-owned opportunity table and additive migration
- constrained source, status, budget, currency, and strict skill arrays
- partial external identity uniqueness
- `OpportunityRepository.listPage`
- exact status/source filters and literal cross-field query
- deterministic effective-timestamp/UUID keyset pagination
- signed cursors bound to tenant and every supported normalized filter
- `ListOpportunities` with `opportunities:read` authorization
- application and real PostgreSQL tests

M5-A stops at the application boundary; Milestone 5-B adds the interface below.

### Milestone 5-B — MCP exposure

### Goal

Expose the implemented read-only opportunity listing through MCP.

### Tool

```text
list_opportunities
```

### Implemented

- MCP input and output schemas
- explicit tool registration
- composition-root wiring
- MCP contract tests
- stdio/PostgreSQL smoke coverage

### Exit Criteria

An MCP client can list stored opportunities reliably and safely through the
existing trusted-context and shared invocation boundary.

Milestone 5-B is complete. Contract tests cover strict SDK input rejection,
trusted context, authorization, output validation, signed cursors, safe errors,
and invocation logs. Compiled stdio tests exercise tenant isolation, structured
filters, and multi-page reads against real PostgreSQL through SELECT-only runtime
credentials.

No Upwork/Gmail/browser synchronization is included yet.

---

## 8. Milestone 6 — Deterministic Opportunity Evaluation

### Goal

Evaluate opportunities using code-controlled rules and portfolio evidence, then
expose that application capability through MCP in a separate slice.

### Milestone 6-A — domain/application evaluation

Implemented:

- tenant-scoped `OpportunityRepository.getById`
- owner/member `opportunities:evaluate` authorization with viewer denial
- pure, versioned `EvaluationPolicyV1`
- fixed skill, project-type, and experience-evidence scoring
- nullable budget scoring while profile rate currency is unavailable
- existing tenant-scoped evidence search reused with a limit of 10
- structured strengths, concerns, and risk flags
- deterministic recommendation thresholds and overrides
- application orchestration with no persistence or side effects

### Inputs

```text
opportunityId
```

### Data Sources

```text
Opportunity
DeveloperProfile
ProjectEvidence
EvaluationPolicyV1
```

### Output Areas

```text
overallScore
recommendation
skill score
project-type score
budget score
experience-evidence score
matched skills
missing skills
strengths
concerns
risk flags
relevant evidence
evaluationVersion
```

### Required Tests

At minimum:

```text
excellent fit
partial skill gap
excluded project type
budget not comparable without profile currency
strong project evidence
weak/no project evidence
cross-tenant opportunity
missing developer profile
```

### Exit Criteria

Given the same stored data and evaluation version, the result is deterministic.

Milestone 6-A is complete. Domain tests lock the weights, thresholds, overrides,
findings, and evidence ranking. Application tests cover strict input,
authorization order, trusted tenant scope, safe errors, and missing resources.
Real PostgreSQL tests cover scoped opportunity lookup, bounded full-text evidence
search, cross-tenant isolation, deterministic end-to-end evaluation, and the
absence of database writes.

### Milestone 6-B — MCP exposure

Implemented tool:

```text
evaluate_opportunity
```

Milestone 6-B adds strict MCP input/success-output schemas, explicit registration,
and composition-root wiring through the existing repositories, authorization,
and versioned evaluation use case. Contract tests verify SDK input rejection,
safe application errors, request IDs, owner/member access, viewer denial before
protected repository work, strict result validation, and invocation logging.
Real PostgreSQL stdio tests exercise all seven tools, evaluation determinism,
tenant isolation, owner/member access, viewer denial, role revalidation, safe
errors, and protocol-only stdout through SELECT-only runtime credentials.
The policy, scoring, and evidence retrieval remain the M6-A implementation.

---

## 9. Milestone 7 — First Mutation

### Goal

Introduce one production-grade agent-facing write operation.

### Tool

```text
create_project_note
```

### Required Properties

```text
authenticated
authorized
validated
tenant scoped
transactional
idempotent
audited
safe on retry
```

### Tables

Existing:

```text
project_notes
audit_logs
```

If `audit_logs` has not yet been introduced, add it here with a migration.

### Transaction

```text
project ownership check
→ note insert using the unique constraint
→ resolve committed duplicates and compare exact payload
→ audit insert for new notes
→ commit
```

### Required Tests

```text
successful note
unauthenticated request
missing permission
invalid input
cross-tenant project
duplicate retry returns original result
conflicting idempotency reuse
audit inserted atomically
audit failure rolls back note
database failure does not partially commit
```

### Exit Criteria

The system has demonstrated a safe, production-oriented MCP mutation.

### Milestone 7-A — application and persistence (implemented)

`CreateProjectNote` is an application command only. Its strict schema requires
project UUID, category, nonblank content (1–10,000 UTF-16 units), and a nonblank
opaque key (8–128 units), preserving text exactly. Owner/member permission checks
precede validation and protected work. Tenant and author are trusted values.

A dedicated PostgreSQL adapter verifies project ownership and creates the note
and durable audit in one READ COMMITTED transaction. The existing unique key
arbitrates concurrent insertion; matching retries return the original note and
`created=false`, while project/category/content differences return `CONFLICT`.
The additive audit migration binds tenant, note, and actor and constrains safe
metadata. Write runtime credentials have append-only note/audit privileges.

Tests cover strict input, authorization order, tenant and author identity,
cross-tenant and unknown projects, exact retries, key conflicts across projects,
independent tenant/author scopes, forced concurrent insert races, database/audit/
commit rollback, safe retry after rollback, migration integrity, and privileges.
Archived projects remain eligible for notes. Real PostgreSQL tests also verify
author-membership enforcement and malformed-input rejection without writes.
Concurrent tests use a five-second lock-barrier deadline, ten-second database
statement timeouts, and the integration runner's twenty-second test timeout.
They release the lock and await all attempts in cleanup before removing fixtures.

### Milestone 7-B — MCP exposure (implemented)

`create_project_note` is explicitly registered with the existing strict input,
strict success output, and write/non-destructive/idempotent/closed-world
annotations. The composition root reuses the M7-A command and transactional
adapter. The shared invocation boundary supplies trusted context, response
`meta.requestId`, safe errors, and content-free structured logs. M7-A transaction,
audit, and retry semantics remain unchanged; no second write path is introduced.

MCP contract tests cover discovery, SDK validation before application work,
owner/member access, viewer denial, output shape, safe errors, context/request IDs,
and log privacy. Compiled PostgreSQL stdio tests verify creation, idempotent retry,
tenant isolation, live authorization changes, conflicts, atomic rollback,
concurrent duplicate/conflicting sessions, audit correlation, restricted runtime
credentials, and protocol-only stdout. All seven read-only tools retain their
existing behavior and regression tests. Subsequent hardening is tracked below.

---

## 10. Milestone 8 — Production Hardening

### Goal

Prepare V1 for reliable deployment and portfolio review.

### Deliverables

- graceful shutdown
- database connection lifecycle
- tool/input limits
- timeouts where appropriate
- safe error classification
- production Docker image
- CI verification
- health/readiness strategy if transport/deployment requires it
- dependency/security review
- complete structured logging review
- migration deployment procedure
- environment documentation

### Exit Criteria

The server has documented startup, deployment, failure, migration, and shutdown behavior.

### Milestone 8-A — Read-only readiness audit (complete)

The source audit distinguished an operator-controlled local stdio process from
a remote multi-user service. V1 does not require HTTP or an identity provider.
Production authentication remains unsupported and fail-closed. Lifecycle,
readiness, resource bounds, packaging, recovery, and operational assurance remain
separate hardening work; a working local launcher does not satisfy those gates.

### Milestone 8-B — Local trust boundary and launcher (implemented)

`node --env-file=.env apps/mcp-server/dist/main.js` launches the compiled MCP server
directly from the repository root, without npm lifecycle output. MCP clients
configure absolute Node executable, env-file, and compiled entry-point paths;
these work from another directory and support spaces. The selected env file is
required: Node fails on stderr before bootstrap if it is missing. Other ambient
env files are not discovered. The README documents the exact command,
environment precedence, and trust in the operator's OS account, launcher, host,
protected configuration, and client-managed subprocess lifecycle. Configured
identity is an operator assertion rather than independent authentication;
membership is revalidated, and runtime database credentials have no RLS protection.

Executable PostgreSQL regressions read and run the documented command, initialize
MCP, discover all eight tools, validate every stdout message, and check structured
logs on stderr. They exercise absolute paths and explicit env files with spaces
from another working directory and reject identity in tool arguments. Bootstrap
tests retain production/unsupported-auth rejection and cover missing env files,
missing settings, and environment precedence. Existing real PostgreSQL stdio
tests use the absolute compiled entry point from another working directory.
Application rules, permissions,
schemas, persistence, transaction behavior, and idempotency are unchanged.
M8-B includes no remote transport or identity provider.
Milestone 8 remains incomplete: broader resource limits, operational
readiness, release packaging, and backup/recovery and migration deployment
procedures remain open. Production authentication requires a separate owner
decision; local stdio is not a production-authentication bypass.

### Milestone 8-C — Bounded local process lifecycle (implemented)

One process-owned shutdown path handles SIGINT, SIGTERM, stdin EOF/MCP transport
closure, fatal database pool/client errors, and partial startup failure. New application
admission stops before context resolution, while admitted invocations have a
10-second grace period. Transport and database cleanup are both attempted
independently. A single 15-second total deadline includes cleanup and protocol
output flushing; expiry forces nonzero termination. Repeated triggers are
idempotent, and later fatal triggers preserve a nonzero exit. Diagnostics remain
safe structured stderr logs. Existing database statement/connection timeouts remain.
Checked-out clients retain an error listener so socket loss during a Drizzle
transaction cannot escape as an unhandled event with raw Node diagnostics.

The SDK can close its wire while an admitted write continues. A lost response does
not prove rollback, and invocation success does not prove delivery. A note/audit
committed before termination remains durable; explicit retries reuse the exact
payload and original idempotency key under the same trusted actor/tenant. No
automatic mutation retries, transaction changes, or cancellation promises are added.

Deterministic lifecycle tests cover all trigger reasons, repeated/reentrant
shutdown, draining, admission refusal, safe errors, failed or stuck cleanup,
output flushing, and deadlines. Compiled process tests cover both signal-event
handlers and partial startup with an initialized wire but no SDK handle. Sink
failures and late cleanup rejections cannot skip cleanup or escape unobserved.
A bounded subprocess test holds an admitted invocation and a real PostgreSQL
client to exercise the full drain/pool deadline and subsequent connection release.
Real PostgreSQL stdio tests cover fatal idle-backend loss, interrupted
transaction rollback with explicit retry, and an admitted write committing after
EOF without a delivered response or duplicate retry audit. Actual POSIX signal
delivery tests are conditional on POSIX; Windows forced termination cannot invoke
graceful cleanup. All eight tool contracts, authorization, tenant scope, and
transaction/idempotency semantics remain unchanged.

M8 as a whole remains unfinished. This slice adds no HTTP transport, authentication
system, migration, automatic process restart, or unrelated hardening feature.

### Milestone 8-D — Database policy and bounded readiness (implemented)

The local stdio SDK factory and `mcp.ready` wait for a single read-only startup
probe, bounded to 10 seconds including connection acquisition. PostgreSQL 18,
the configured database and session/active role identities,
the complete committed migration ledger, and a reviewed catalog schema signature
must match. Effective grants must supply all eight tools' narrow reads and
append-only note/audit writes without dangerous role attributes, ownership,
PUBLIC/inherited/SET ROLE escalation, excess table/column grants, grant options,
sequence access, schema/database creation, temporary objects, or callable user
SECURITY DEFINER functions. Provisioning is an explicit administrator action;
startup never migrates, grants, mutates, or retries. Migration and runtime
credentials remain separate. Runtime gets SELECT on migration metadata only.

Remote database transport requires verify-full certificate/hostname validation
and TLS 1.2 minimum, with optional private-CA PEM configuration. Plaintext is
restricted to explicit loopback; URL and ambient PG* overrides cannot weaken
transport, choose a different endpoint, or change session roles. Startup errors
remain static safe stderr diagnostics. EOF/signals/fatal database errors keep
the M8-C shutdown path, and no application operation starts before readiness.

Focused deterministic tests cover transport policy, probe deadline/late-client
cleanup, and startup closure/failure. Real PostgreSQL tests cover accepted and
rejected role grants, schema/ledger drift, failed process readiness, and verified
TLS including untrusted certificates and hostname mismatch. Existing eight-tool,
authorization, tenant, audited mutation, idempotency, and lifecycle tests remain.

M8 remains unfinished: no production-authentication approval, RLS, HTTP/OAuth,
migration, new tool contract, automatic mutation retry, packaging, backup/restore
automation, or unrelated operational feature is included. Startup checks cannot
prevent a trusted administrator from changing grants/schema after readiness or
protect stolen runtime credentials across tenants.

### Milestone 8-E — Invocation admission and response bounds (implemented)

The process shares one eight-slot admission gate across all eight tools and SDK
server factories. There is no queue. Saturation returns existing `RATE_LIMITED`
before context lookup or application execution. Shutdown refusal retains the
M8-C boundary; M8-D database readiness still gates all application admission.

A 30-second application response deadline includes context, execution, success
validation, and serialization. Expiry returns safe `INTERNAL_ERROR` but does not
cancel or retry application/database work. Capacity and shutdown leases remain
occupied until the underlying execution settles. Late context resolution cannot
start a new use case, and late execution rejection remains observed. The single
invocation log reports the response outcome, without later success relabeling.

The UTF-8 JSON representation of a successful `CallToolResult` must be at most
1,048,576 bytes, including both content representations and escaping, excluding
SDK JSON-RPC framing. Oversized results return safe `INTERNAL_ERROR`, without
truncation, altered schemas, or leaked output. A timed-out/oversized mutation
response may follow or precede commit: explicit retries preserve the exact
payload and original idempotency key. No automatic mutation retry is added.

Fake-timer SDK tests cover shared capacity, immediate rejection/no queue, exact
deadlines, late success/failure, context expiry, cleanup, elapsed-time checks, and
exact/over-limit UTF-8 serialization. Real PostgreSQL tests hold eight note writes
at audit insertion, expire their responses, verify retained capacity/shutdown
accounting, then recover committed work without duplicate audit. Direct stdio
tests verify process admission and safe oversized responses with protocol-only
stdout. Existing authorization, tenant isolation, readiness, and lifecycle suites
remain. SDK input framing, synchronous event-loop blocking, PostgreSQL server
resource consumption, and response delivery to disconnected clients are not fully
bounded by this policy. Explicit mutation recovery also requires the same trusted
tenant and author. M8 as a whole is not declared production-ready.

### Milestone 8-F — Local stdio Docker release (implemented)

A multi-stage Dockerfile uses a digest-pinned official Node 24 slim base and
locked npm installs with install hooks disabled. Build tools and test dependencies
remain in build stages. The non-root release image contains production
dependencies, compiled runtime workspaces, and the original full migration
directory required by M8-D readiness. It launches Node directly, accepts runtime
configuration only, publishes no port, and never runs migrations automatically.
The Docker context uses an allowlist excluding local env files, registry
configuration, credentials, host dependencies, compiled output, and test fixtures.

`npm run test:container` builds the Linux artifact from an isolated source-only
snapshot and compares it with a cold
rebuild, inspects runtime contents/identity, and uses existing disposable TLS
PostgreSQL fixtures with the approved restricted role. It initializes MCP,
discovers/calls all eight tools, checks protocol-only stdout and structured
stderr, tenant isolation and note/audit retry safety, EOF and actual SIGINT/SIGTERM
shutdown, safe configuration/database-policy rejection, missing-migration
readiness rejection, and absence of Node-owned TCP/UDP listeners. Linux CI runs this
gate separately from the existing verification suite. Container run guidance
uses a read-only filesystem, dropped capabilities, no-new-privileges, bounded
resources, runtime secrets, and a shutdown grace exceeding M8-C's deadline.

See [local stdio container operations](local-stdio-container.md). M8-C lifecycle,
M8-D readiness/TLS, M8-E bounds, and production-local-auth rejection are unchanged.
No remote hosting, HTTP, OAuth, new authentication mode, business feature,
automatic migration/retry, or image publishing is added. M8 remains incomplete:
M8-G dependency/image vulnerability maintenance and M8-H backup/recovery and
migration deployment procedures remain separate work, along with production
authentication approval. These follow-up slices are not implemented here.

---

### Milestone 8-H1 — Safe serialized migrations (implemented)

The administrative CLI requires `DATABASE_MIGRATION_URL` and optional private CA
`DATABASE_MIGRATION_TLS_CA`, independently of runtime/test settings. It preserves
M8-D verified TLS and explicit endpoint/session policy, with no credential fallback.
One owned pg session holds a deterministic database-scoped advisory lock while
the unchanged Drizzle migrator executes. Exact ledger prefix/full verification
detects mismatches instead of silently skipping or repairing history.

Dedicated configurable defaults bound connection (5s), advisory acquisition (10s),
other lock waits (5s), individual SQL (120s), and overall execution (300s), with at
most 5s additional disconnect cleanup. PostgreSQL timeouts and socket destruction
bound underlying work; operation expiry, SIGINT/SIGTERM, and connection loss
return nonzero safe diagnostics without claiming rollback. No automatic retries
or runtime startup migrations exist. The original ledger scaffolding can survive
a failed first transaction; an uncertain commit requires operator inspection.

Real PostgreSQL 18 tests exercise independent CLI processes, held-lock contention,
same-backend DDL/lock ownership, repeated history preservation, SQL failure,
statement/lock/operation/connect deadlines, interruption/termination, backend loss,
cleanup, drift/readiness rejection, restricted-runtime privileges, and TLS policy.
Tests create only unique disposable databases using explicit administrator
credentials. They leave existing development data and persistent volumes intact.
See [technical specification](m8-h1-migration-spec.md) and
[operator procedure](database.md#m8-h1-administrative-execution-policy).

M8-H2 remains open: backup creation, backup verification, restore drills, and
recovery objectives. M8-H and Milestone 8 are not complete. This slice imports no
M8-G changes and changes no schema, MCP contract, or authentication behavior.

---

## 11. Milestone 9 — Portfolio Documentation

### Goal

Make the repository explain its engineering decisions without requiring private context.

### README Should Explain

```text
problem
product goal
architecture
MCP tool catalog
domain model
security model
tenant isolation
authorization
safe side effects
idempotency
failure behavior
search strategy
opportunity evaluation
testing strategy
observability
deployment
example AI interactions
future integrations
```

### Exit Criteria

A technical reviewer can understand why the project is production-oriented rather than a thin MCP demo.

---

## 12. Verification Commands

Milestone 0 uses npm workspaces and the committed npm lockfile:

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run verify
```

`verify` checks formatting, lint, production/test types, the build, and Vitest.
The test and lint commands build package declarations first so they work after a
clean install. CI additionally starts PostgreSQL via Docker Compose and executes
an authenticated `SELECT 1`. See the README for local environment setup and
`db:up`/`db:down` commands.

Milestone 1 adds `npm run test:integration` and `npm run verify:all`.
The latter runs the existing checks, validates Drizzle migration history, and runs
real PostgreSQL integration tests. CI additionally applies the migration to its
development database and checks that generation has no schema drift. Test
databases and runtime roles are disposable; no database mocks are used.

## 13. Change Discipline

For every milestone:

```text
write/update spec
inspect repository
identify affected files
implement smallest coherent slice
add migration when schema changes
add tests
run verification
update documentation
summarize changes and risks
```

Do not combine unrelated milestones in one Codex task unless the previous milestone is already complete and verified.

## 14. V1 Completion Definition

BelovedDev MCP V1 is complete when all eight tools are available:

```text
get_profile
list_projects
get_project
search_project_evidence
get_blockers
list_opportunities
evaluate_opportunity
create_project_note
```

and the system has:

```text
tenant isolation
authorization
database constraints
migrations
deterministic evaluation
PostgreSQL FTS
idempotent note creation
mutation audit logging
structured request logging
contract tests
security regression tests
production startup/shutdown behavior
```

External integrations are not required for V1 completion.
