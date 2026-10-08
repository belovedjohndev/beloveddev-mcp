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

Evaluate opportunities using code-controlled rules and portfolio evidence.

### Tool

```text
evaluate_opportunity
```

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
budget mismatch
strong project evidence
weak/no project evidence
cross-tenant opportunity
missing developer profile
```

### Exit Criteria

Given the same stored data and evaluation version, the result is deterministic.

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
→ idempotency check
→ note insert
→ audit insert
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
