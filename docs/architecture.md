# BelovedDev MCP V1 — Architecture

## Milestone 0 implementation

The current executable is a configuration/logging bootstrap that exits without
starting a transport or opening a database connection. npm workspaces establish
the package boundaries; TypeScript project references build the two active
packages, `infrastructure` and `mcp-server`. Other packages contain metadata only.

`packages/infrastructure` currently owns the Zod environment validator and Pino
logger. `apps/mcp-server` supplies the environment and instantiates the logger.
There are no application ports or domain abstractions until a use case needs them.
The domain and application layers will remain independent of MCP and concrete
database adapters; the runtime flow below does not reverse that dependency rule.

Logs go to stderr to preserve future MCP stdout framing. Configuration failures
expose field names only. Local PostgreSQL is bound to loopback, with no domain
schema or connection pool. Trusted tenancy, authorization, least-privilege database
roles, and transactional data access must be implemented with the first relevant
features; this milestone does not claim to enforce tenant isolation on data.

The remaining sections describe the target V1 architecture.

## 1. Architectural Goal

BelovedDev MCP should remain simple enough for V1 while demonstrating production-quality boundaries.

The most important separation is:

```text
MCP transport
≠ application behavior
≠ domain rules
≠ database implementation
```

## 2. Dependency Direction

```text
AI Client / Agent
        ↓
    MCP Server
        ↓
    MCP Handlers
        ↓
Application Use Cases
        ↓
 Domain Services / Rules
        ↓
Repository Interfaces
        ↓
Infrastructure Adapters
        ↓
     PostgreSQL
```

Dependencies point inward.

The domain must not know that MCP exists.

## 3. Proposed Repository Structure

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

V1 deliberately does not create `apps/api`, `apps/worker`, or `packages/evals` without a real requirement.

## 4. Package Responsibilities

### `packages/domain`

Contains pure domain concepts and correctness-sensitive rules.

Examples:

```text
Project
ProjectEvidence
ProjectBlocker
Opportunity
OpportunityEvaluationResult
FitScore
Recommendation
domain errors
domain policies
```

Must not depend on:

- MCP SDK
- Drizzle
- PostgreSQL
- environment variables
- transport concepts

### `packages/application`

Contains use cases and ports.

Planned use cases:

```text
GetProfile
ListProjects
GetProject
SearchProjectEvidence
GetBlockers
ListOpportunities
EvaluateOpportunity
CreateProjectNote
```

Repository interfaces are defined at the application/domain boundary.

Examples:

```text
DeveloperProfileRepository
ProjectRepository
EvidenceRepository
BlockerRepository
OpportunityRepository
NoteRepository
AuditRepository
```

The application layer owns orchestration such as:

- authorization calls
- resource loading
- transaction orchestration
- domain-service invocation
- idempotency behavior
- safe error mapping to application errors

### `packages/database`

Contains database-specific schema and lifecycle concerns:

```text
Drizzle schema
migrations
database connection
transaction helpers
database configuration
```

It should not contain MCP tool definitions.

### `packages/infrastructure`

Contains concrete adapters implementing application ports.

Examples:

```text
PostgresProjectRepository
PostgresEvidenceRepository
PostgresOpportunityRepository
PostgresAuditRepository
```

Future external-system adapters also belong here.

### `packages/mcp`

Contains MCP-specific transport code:

```text
tool registration
tool descriptions
input schemas
output DTOs
MCP error mapping
handler adapters
```

Handlers must remain thin.

### `packages/shared`

Contains genuinely cross-cutting primitives used by multiple layers.

Potential examples:

```text
Result
branded IDs
clock interface
request context types
common validation helpers
```

Do not turn `shared` into a miscellaneous dumping ground.

### `packages/test-support`

Contains reusable test infrastructure such as:

```text
fixture builders
database test helpers
tenant fixtures
authenticated context builders
```

Do not place production business logic here.

### `apps/mcp-server`

Acts as the composition root.

Responsibilities:

```text
load configuration
create logger
create database pool
construct repositories
construct application services
construct MCP handlers
configure authentication
start transport
graceful shutdown
```

## 5. Request Context

Every request should resolve a trusted context similar to:

```text
RequestContext
- requestId
- userId
- tenantId
- membershipId
- role
- permissions
```

This context must be produced by server-side authentication/membership logic.

Tool arguments must not override it.

## 6. Request Lifecycle

```text
MCP request
      ↓
request ID
      ↓
authenticate principal
      ↓
resolve active tenant membership
      ↓
validate MCP input
      ↓
authorize required permission
      ↓
invoke application use case
      ↓
execute repository/domain work
      ↓
serialize safe output
      ↓
structured log
      ↓
MCP response
```

For mutations:

```text
MCP request
      ↓
trusted context
      ↓
validation
      ↓
authorization
      ↓
transaction
  ├─ check resource ownership
  ├─ check idempotency
  ├─ mutate resource
  └─ append audit record
      ↓
commit
      ↓
response
```

## 7. Authorization Design

Roles should map to permissions.

Initial permissions:

```text
profile:read
projects:read
project_notes:create
opportunities:read
opportunities:evaluate
```

Possible role mapping:

| Role   | Effective permissions            |
| ------ | -------------------------------- |
| owner  | all V1 permissions               |
| member | normal V1 read/write permissions |
| viewer | read-only permissions            |

Business code should authorize permissions, not scatter direct role comparisons everywhere.

## 8. Tenant Isolation

Tenant isolation is mandatory at multiple layers.

### Repository contract

Tenant-owned repository methods should require tenant scope.

Example:

```text
getById({
  tenantId,
  projectId,
})
```

### Application behavior

If a resource ID exists under another tenant, return:

```text
NOT_FOUND
```

rather than revealing ownership.

### Database constraints

Foreign keys protect referential integrity.

Application/repository logic protects same-tenant relationships where standard foreign keys alone cannot express the ownership rule.

Composite foreign keys may be considered where they materially simplify and strengthen tenant invariants, but should not be introduced mechanically.

## 9. Authentication

The exact production identity provider is not part of V1 specification yet.

The architecture should depend on an authentication abstraction that produces an authenticated principal.

Do not build a custom password/authentication system merely to unblock MCP development.

For local development, a clearly isolated development authentication adapter may be used if necessary, but it must not be confused with a production security model.

## 10. Validation

Use Zod at transport/configuration boundaries.

Use:

- Zod for model-controlled input and configuration;
- domain rules for domain invariants;
- PostgreSQL constraints for persistent data integrity.

Avoid duplicating the same rule unnecessarily across every layer.

## 11. Error Model

Initial application errors:

```text
UNAUTHENTICATED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
CONFLICT
RATE_LIMITED
INTERNAL_ERROR
```

MCP should map application errors to stable, safe tool responses.

Never return raw:

- SQL
- stack traces
- secrets
- internal paths
- database implementation details

Unexpected errors should be logged with request ID and safe metadata.

## 12. Transaction Model

Use transactions when multiple writes form a single logical operation.

Initial mandatory transactional mutation:

```text
create_project_note
```

Transaction contents:

```text
verify project tenant scope
check idempotency key
insert note
insert audit record
commit
```

If any step fails, roll back the complete operation.

## 13. Idempotency Model

Agent/tool execution may be duplicated because of:

- retries
- reconnects
- user actions
- agent loops
- transport uncertainty

Therefore agent-facing mutations should not assume exactly-once delivery.

`create_project_note` accepts:

```text
idempotencyKey
```

and enforces:

```text
UNIQUE(tenant_id, author_user_id, idempotency_key)
```

A duplicate request returns the existing operation result.

Do not create a second note.

## 14. Search Architecture

V1 uses PostgreSQL full-text search for project evidence.

Search combines:

- textual query
- tenant scope
- optional project filter
- optional evidence type filter
- optional skill filter
- cursor pagination

PostgreSQL FTS is preferred initially because it is:

- operationally simple
- deterministic
- inexpensive
- easy to integration-test
- sufficient for the expected V1 data size

No vector database is required for V1.

## 15. Opportunity Evaluation Architecture

Opportunity evaluation is an application/domain operation.

It may use:

```text
DeveloperProfile
Opportunity
ProjectEvidence
EvaluationPolicy v1
```

Possible deterministic signals:

```text
skill match
project-type match
budget compatibility
evidence strength
excluded-project penalties
risk flags
```

Output must include:

```text
evaluationVersion = "v1"
```

The MCP handler does not calculate scores.

The evaluation is read-only and not persisted in V1.

## 16. Logging

Use structured logs.

At minimum, MCP requests should record:

```text
requestId
toolName
actorUserId
tenantId
durationMs
resultStatus
errorCategory
```

Do not log full sensitive payloads by default.

## 17. Audit

Operational logs and audit logs are different.

Structured logs support observability.

Audit records provide durable evidence of state changes.

V1 durable audit is required for:

```text
create_project_note
```

Future mutations must define audit requirements before implementation.

## 18. Configuration

Validate environment variables at startup.

Fail fast on invalid required configuration.

Likely configuration areas:

```text
NODE_ENV
DATABASE_URL
LOG_LEVEL
MCP transport configuration
authentication configuration
```

Do not scatter direct `process.env` access throughout packages.

## 19. Graceful Shutdown

The application should respond to process termination by:

1. stopping acceptance of new work where supported;
2. shutting down MCP transport;
3. closing database connections;
4. flushing logs if required;
5. exiting predictably.

## 20. Testing Architecture

### Domain tests

Fast, isolated tests for rules such as:

```text
fit scoring
recommendation thresholds
skill normalization/matching
budget compatibility
```

### Application tests

Test use cases with repository fakes/mocks.

Focus on:

```text
authorization
orchestration
error behavior
idempotency decisions
```

### Repository integration tests

Run against real PostgreSQL.

Verify:

```text
tenant scope
constraints
transactions
indexes
pagination
full-text search
```

### MCP contract tests

Verify:

```text
tool registration
input schema
output shape
error mapping
```

### Security tests

Mandatory regression cases:

```text
tenant A cannot read tenant B project
tenant A cannot search tenant B evidence
tenant A cannot read tenant B blockers
tenant A cannot evaluate tenant B opportunity
tenant A cannot create notes on tenant B project
```

## 21. V1 Architectural Constraints

Do not introduce without an explicit requirement:

```text
CQRS
event sourcing
message brokers
distributed transactions
background worker architecture
vector databases
microservices
custom dependency injection framework
generic repository abstractions
```

Prefer explicit, boring, testable TypeScript.
