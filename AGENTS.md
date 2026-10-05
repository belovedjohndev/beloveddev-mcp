# BelovedDev MCP — Agent Instructions

## Project

BelovedDev MCP is a production-oriented MCP server for managing freelance development operations, project context, portfolio evidence, blockers, and opportunity/job-fit workflows.

The system is both:

1. a practical tool for daily freelance/developer operations; and
2. a portfolio project demonstrating production TypeScript, MCP, PostgreSQL, authorization, multi-tenancy, tool design, testing, observability, and safe agent-facing side effects.

## Default Stack

- TypeScript
- Node.js
- PostgreSQL
- Drizzle ORM
- Zod
- MCP TypeScript SDK
- Vitest
- Docker
- Structured logging

Frontend applications are not part of V1 unless explicitly added later.

## Architecture

Treat MCP as an interface layer, not as the domain.

Target dependency direction:

```text
AI Client / Agent
        ↓
    MCP Server
        ↓
Application Use Cases
        ↓
   Domain Rules
        ↓
Repository Interfaces
        ↓
Infrastructure Adapters
        ↓
PostgreSQL / External Systems
```

Business rules must not live inside MCP tool handlers.

## Working Rules

Before modifying code:

1. Inspect the existing repository.
2. Read the relevant files and documentation.
3. State the intended change set.
4. Identify affected domain rules, data, permissions, and failure behavior.
5. Implement the smallest coherent vertical slice.
6. Modify only relevant files.
7. Run verification commands.
8. Summarize changes, risks, and unresolved issues.

Do not perform unrelated cleanup during feature work.

## V1 Scope

V1 MCP tools:

```text
get_profile
list_projects
get_project
search_project_evidence
list_opportunities
evaluate_opportunity
create_project_note
get_blockers
```

Prefer read-only functionality first.

`create_project_note` is the only planned V1 MCP mutation.

Do not add new tools without a clear use case and explicit specification.

## Security Rules

Security and tenant isolation are correctness requirements.

### Trusted Context

The following values must come from trusted authenticated server context:

```text
userId
tenantId
membershipId
role
permissions
requestId
```

Never accept `tenantId` from model-controlled MCP input as proof of access.

### Authorization

Every use case must define its required permission.

Initial permissions:

```text
profile:read
projects:read
project_notes:create
opportunities:read
opportunities:evaluate
```

Do not let the model, MCP client, request body, or tool arguments bypass authorization.

### Tenant Isolation

Every tenant-owned query must be scoped by trusted tenant context.

Prefer repository APIs such as:

```text
getProject({
  tenantId,
  projectId,
})
```

over:

```text
getProject(projectId)
```

Cross-tenant resource access should normally return `NOT_FOUND`, not reveal that another tenant owns the requested resource.

Add tenant-isolation tests for all tenant-owned repositories and application use cases.

## Database Rules

Use migrations for every schema change.

Prefer PostgreSQL constraints for correctness-sensitive invariants.

Examples:

- foreign keys
- unique constraints
- check constraints
- not-null constraints
- indexes
- partial indexes where justified

Do not rely only on TypeScript or Zod validation when PostgreSQL can enforce the same invariant.

Do not add tables without a current use case.

## Transactions

Use transactions when an operation must succeed or fail atomically.

All mutations must define:

- authorization
- validation
- transaction boundaries
- failure behavior
- audit behavior
- retry behavior
- idempotency requirements

Retries are allowed only when the operation is safe to repeat.

## Idempotency

Agent-facing mutations must be designed for duplicate execution.

For `create_project_note`, use an explicit idempotency key and enforce uniqueness at the database layer.

A duplicate retry with the same idempotency key should return the previously created result rather than create another note.

## MCP Tool Design

Every MCP tool must have:

- clear name
- precise description
- explicit input schema
- explicit output schema where practical
- required permission
- tenant scope
- side-effect classification
- failure behavior
- audit behavior

MCP handlers should be thin.

Preferred flow:

```text
validate transport input
        ↓
resolve trusted request context
        ↓
authorize
        ↓
invoke application use case
        ↓
map result to MCP response
```

MCP handlers must not contain:

- SQL
- substantial domain logic
- scoring algorithms
- direct authorization shortcuts
- model-controlled tenant selection

## Opportunity Evaluation

V1 opportunity evaluation should be deterministic.

The application may calculate:

```text
overallFitScore
skillMatchScore
projectTypeMatch
budgetCompatibility
relevantEvidenceCount
matchedSkills
missingSkills
relevantProjects
riskFlags
recommendation
```

The model may interpret and explain those results, but correctness-sensitive scoring rules belong in deterministic code.

Every evaluation result must include an `evaluationVersion`.

Do not persist opportunity evaluations in V1 unless the specification is explicitly changed.

## Search

Use PostgreSQL full-text search for V1 project evidence search.

Do not introduce vector search, embeddings, or a vector database until the dataset and retrieval quality justify the additional complexity.

## Errors

Use explicit application error categories.

Initial categories:

```text
UNAUTHENTICATED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
CONFLICT
RATE_LIMITED
INTERNAL_ERROR
```

Never expose raw:

- SQL errors
- stack traces
- secrets
- credentials
- internal filesystem paths
- resources belonging to another tenant

## Logging

Use structured logs.

For each MCP invocation, log:

```text
requestId
toolName
actorUserId
tenantId
durationMs
resultStatus
errorCategory
```

Log resource IDs only when useful.

Never log:

- authentication secrets
- OAuth tokens
- database credentials
- unnecessary sensitive content
- full request/response bodies by default

## Audit

Durably audit mutations.

Initial audit fields:

```text
tenantId
actorUserId
action
resourceType
resourceId
requestId
metadata
createdAt
```

Do not indiscriminately store entire request bodies in audit metadata.

## Testing

Use Vitest.

Required test categories:

- domain unit tests
- application/use-case tests
- repository integration tests
- MCP contract tests
- authorization tests
- tenant-isolation tests
- mutation/idempotency tests

Use a real PostgreSQL instance for repository integration tests.

Do not mock PostgreSQL behavior when the purpose of the test is to verify constraints, transactions, tenant scoping, SQL queries, or indexes.

## Reliability

Design explicitly for:

- malformed model input
- duplicate tool calls
- database failures
- safe retries
- timeouts
- partial failures
- transport disconnects
- rate limits
- external integration failures in later versions

Production behavior matters more than demo behavior.

## Scope Control

Do not add the following to V1 unless explicitly requested:

- Gmail integration
- Google Calendar integration
- GitHub synchronization
- Upwork synchronization
- proposal submission
- email sending
- billing
- invoicing
- background workers
- agent orchestration
- vector databases
- embeddings
- persisted opportunity evaluations
- arbitrary update/delete MCP tools

## Documentation

Keep implementation aligned with:

```text
docs/product-spec.md
docs/domain-model.md
docs/architecture.md
docs/mcp-tool-contracts.md
docs/implementation-plan.md
```

If implementation changes a documented contract or architecture decision, update the relevant documentation in the same change.
