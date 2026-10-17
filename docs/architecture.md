# BelovedDev MCP V1 — Architecture

## Implemented architecture through Milestone 8-D

The stdio executable composes trusted local request context, application use
cases, PostgreSQL repositories, signed cursors, MCP handlers, and structured
logging. Database setup remains an explicit migration CLI action.

M8-D gates the SDK server factory and `mcp.ready` on a read-only database probe.
One 10-second total budget covers connection acquisition, configured database/role
identity verification, PostgreSQL 18 schema
compatibility (migration ledger and reviewed catalog signature), and effective
least-privilege checks. The transport still observes EOF during the probe;
queued requests cannot reach context resolution/use cases until it succeeds.
Failure destroys the probe connection and uses M8-C cleanup. Signals/EOF during
startup do not produce false readiness. Pool acquisition, statement timeouts,
admission/draining, and uncertain committed-write outcomes remain unchanged.

The database adapter parses an allowlisted connection URL into explicit pg
fields. Remote endpoints require verified TLS 1.2+ with hostname validation;
only explicit loopback permits plaintext. Optional `DATABASE_TLS_CA` supplies
private trust roots. There is no permissive SSL fallback, session-role URL
override, ambient PG* override, or runtime migration/privilege escalation. Runtime
checks account for PUBLIC and inherited/SET ROLE access, column grants, ownership,
privileged role attributes, and callable user SECURITY DEFINER routines. All
eight tools require the full documented runtime grants, including append-only
note/audit writes and read-only migration metadata. These are startup snapshots,
not continuous enforcement or protection from a hostile database administrator.
There is still no RLS, HTTP transport, or new authentication mode. See the
[database security policy](database.md#m8-d-connection-and-readiness-policy).

M8-B documents and verifies direct Node execution of the compiled composition
root: `node --env-file=.env apps/mcp-server/dist/main.js` from the repository root.
MCP clients use absolute paths for Node, the required env file, and the compiled
entry point, so launch does not depend on their working directory. There is no
npm wrapper or automatic discovery of other `.env` files. Node rejects a missing
explicit env file before startup; application configuration failures are logged
safely to stderr. Existing process environment values override file values.
PostgreSQL stdio regressions execute the README command and the absolute-path
variant, initialize MCP, discover all eight tools, and validate every stdout line
as protocol traffic. Bootstrap regressions cover safe configuration failures.

The domain package defines portable records, status values, and the pure
`EvaluationPolicyV1`; the application package defines explicit ports and
authorized use cases. Infrastructure implements the ports with tenant predicates
in Drizzle queries. The database package owns schema, migrations, and pool
lifecycle. Core packages do not depend on persistence or transport. The shared
package remains metadata-only.

Missing and cross-tenant lookups return null; knowledge listings return empty arrays. Repository errors expose safe
categories without raw SQL causes. Project creation is one atomic INSERT with a
composite client ownership foreign key. It is an internal persistence operation.
Milestone 7-A adds authorized, audited project-note creation in the application
and infrastructure layers. Milestone 7-B exposes that command through MCP without
changing its transaction or idempotency semantics.

Real PostgreSQL tests apply migrations to fresh databases and use a restricted
runtime login for repository queries, separate from migration/fixture credentials.
Trusted tenant context and permission authorization protect application access.
There is no RLS policy or claim of protection against arbitrary SQL using
compromised credentials.

See [database conventions](database.md) for concrete schema choices, migration
commands, test isolation, and tooling compatibility. The remaining sections
describe the target V1 architecture.

Milestone 2 adds read-only project knowledge adapters. Each SQL statement includes
tenant scope, filters, a deterministic order, and a required 1–100 limit. No new
transaction abstraction or use case is needed for these single-statement reads.
Composite foreign keys protect project-child ownership and note author membership.
Membership existence is database enforced; active membership and read permissions
are resolved through trusted context. The note uniqueness constraint is
storage groundwork used by the Milestone 7-A retry/audit workflow.

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

Milestone 1 enforces project/client ownership with a composite foreign key:
`projects(tenant_id, client_id)` references `clients(tenant_id, id)`. The supporting
composite unique constraint is justified by this invariant. A null client is
allowed, while the separate project tenant foreign key remains mandatory.
Milestone 2 follows the same strategy for evidence, blockers, and notes:
`(tenant_id, project_id)` references the new `projects(tenant_id, id)` unique key.
Notes additionally reference the author user and their tenant membership. These
constraints apply to direct SQL as well as future application writes.

## 9. Authentication

The production authentication/deployment profile is not specified yet. V1 does
not require a remote HTTP service or an identity provider merely to support stdio.

The architecture should depend on an authentication abstraction that produces an authenticated principal.

Do not build a custom password/authentication system merely to unblock MCP development.

For local development, a clearly isolated development authentication adapter may be used if necessary, but it must not be confused with a production security model.

The implemented local stdio profile trusts the MCP host, launcher, OS account,
installed code, and operator-controlled environment/configuration files. One
process acts for one configured tenant/user pair. Those IDs are operator
assertions, not independent authentication; a compromised launcher can change
the environment and select another active principal. The
membership adapter rechecks active tenant, user, and membership on each call and
derives permissions from the stored role. Tool arguments cannot establish that
identity. Protect local configuration and database credentials using OS access
controls, restricted runtime grants, and a trusted host; there is no RLS defense
against arbitrary SQL using compromised credentials.

The MCP client owns subprocess startup and shutdown. Closing stdin, SIGINT,
SIGTERM, or a fatal database pool/client error uses the bounded lifecycle described in
section 19; a terminal operator can use Ctrl+C. Disconnect does not guarantee
cancellation or rollback of an in-flight mutation. Protect env files with OS account/file permissions and keep
administrator/migration credentials separate from the restricted runtime role.

M8-B documents this boundary without approving local authentication for production.
Only `MCP_AUTH_MODE=local` exists, and `NODE_ENV=production` still rejects it.
Running the launcher successfully does not prove production security. Do not
expose the fixed-principal process as a remote multi-user service. Such a service
requires an independently approved transport/authentication design; no HTTP,
OAuth, identity provider, or production-mode exception is added in this slice.
Local stdio needs neither an HTTP listener nor OAuth. Completing M8-B does not
complete Milestone 8 or remove its remaining production-readiness blockers.

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
attempt note insertion using the unique key
resolve duplicates through committed-note lookup and payload comparison
insert audit record for new notes
commit
```

If any step fails, roll back the complete operation.

### Implemented M7-A boundary

`CreateProjectNote` authorizes `project_notes:create` before validating its strict
four-field input. It obtains tenant, author, and request ID only from trusted
context. A dedicated `ProjectNoteCreationRepository` port represents the one
atomic command; there is no generic transaction manager or separate non-atomic
audit repository.

`PostgresProjectNoteCreationRepository` owns an explicit READ COMMITTED
transaction. It verifies the tenant-scoped project, inserts with the existing
tenant/author/key conflict target, and audits new creations before committing.
A losing insert waits for the winning transaction and then reads its committed
note in a separate statement. The domain comparison checks exact project,
category, and content equality. Matching retries return the original note;
conflicting retries fail without writes. Storage failures, including commit
failures, become safe internal errors. There are no automatic transaction retries.

The existing project and author-membership foreign keys protect insertion against
concurrent administrative deletion. Such a deletion can abort a creation safely;
the command does not grant UPDATE privileges merely to acquire explicit row
locks. Trusted context is resolved before the command, as in existing use cases;
this slice does not introduce a new identity or revocation mechanism.

The additive audit migration preserves historical notes and adds a composite
note key to enforce audit tenant/resource/actor integrity. Runtime privileges are
SELECT on required existing resources plus INSERT on notes and audits, with no
unrelated writes or audit reads. The seven existing read registrations retain
their schemas, handlers, and annotations.

### Implemented M7-B interface

`create_project_note` uses explicit high-level `McpServer.registerTool()` with
the existing strict application input schema and a strict success schema.
It is marked readOnly=false, destructive=false, idempotent=true, openWorld=false.
The composition root constructs `CreateProjectNote` with the existing
`PostgresProjectNoteCreationRepository` and shared authorization, using the same
database connection infrastructure. There is one write path and no handler SQL.

The shared invocation wrapper generates the request ID, resolves trusted context,
validates success output, and returns matching JSON content and structuredContent
with `meta.requestId`. The original creation audit contains that invocation ID;
an identical retry has fresh response metadata but adds no audit. Application
failures keep the safe error envelope without success structuredContent. SDK
schema rejection occurs before context resolution or application execution.

Invocation logs record request/tool/actor/tenant/duration/status/error category;
they exclude note content, keys, and full request/response bodies. Stdio mutation
tests use a restricted role with note/audit INSERT and verify real commits,
retries, conflicts, authorization, rollback, concurrent sessions, and protocol-only
stdout. Both stdio suites use the full restricted eight-tool runtime grants;
authorization still determines which principals may invoke the mutation.

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

### Milestone 4 implementation

`SearchProjectEvidence` is implemented as an application use case over an
explicit `EvidenceRepository.search` port. It authorizes `projects:read` before
decoding cursors or accessing the repository. Trusted request context supplies
tenant scope; search input has no tenant selector.

The PostgreSQL adapter uses a stored weighted English `tsvector`, a GIN index,
`websearch_to_tsquery`, and deterministic `ts_rank_cd DESC, evidence_id ASC`
ordering. Project IDs, evidence types, and exact case-folded skill memberships
are SQL predicates. The signed cursor is bound to the tenant, normalized search
fingerprint, canonical PostgreSQL rank, and evidence ID.

Milestone 4-B exposes this use case as `search_project_evidence` through the same
strict `McpServer.registerTool()` and shared invocation boundary as the other read
tools. SDK-invalid input is rejected before context or repository access. Valid
calls receive a request ID, trusted context, authorization, safe result/error
mapping, and structured invocation logging. The composition root reuses the
existing evidence repository, authorization policy, cursor codec, and logger.

### Milestone 5 opportunity listing

`ListOpportunities` is an application capability over an explicit
`OpportunityRepository.listPage` port. It authorizes `opportunities:read` before
input parsing, cursor decoding, or repository access. Owner, member, and viewer
roles receive this read permission. Trusted context supplies tenant scope; the
input cannot choose a tenant.

The PostgreSQL adapter combines tenant scope with optional status, exact canonical
source, and literal case-insensitive text predicates. Results use
`coalesce(published_at, created_at) DESC, id DESC` keyset ordering. The signed
cursor carries that timestamp and UUID and is bound to a SHA-256 fingerprint of
the tenant and every supported normalized filter.

Milestone 5-B exposes the use case as `list_opportunities` through an explicit
`McpServer.registerTool()` call. The strict transport schema contains only status,
source, query, limit, and cursor; trusted identity and tenant scope still come
from the context provider. The composition root reuses the existing opportunity
repository, authorization policy, cursor codec, safe invocation boundary, and
structured logger.

## 15. Opportunity Evaluation Architecture

Milestone 6-A implements opportunity evaluation as an application/domain
operation. Milestone 6-B exposes it through the read-only `evaluate_opportunity`
MCP tool using explicit `McpServer.registerTool()` registration. Its strict input
contains only `opportunityId`; the strict success schema preserves nullable
dimensions, structured finding codes, ten evidence records, and version `v1`.
Finding-code and recommendation schemas are exhaustively checked against the
existing domain unions at compile time so the transport contract cannot drift.
The composition root uses existing opportunity/profile/evidence repositories,
authorization, and the unchanged default policy. The shared invocation boundary
adds request IDs, validates output, logs safe metadata, and maps application
failures to safe errors with no success `structuredContent`. SDK-invalid input
still fails before trusted-context resolution or application execution.

It may use:

```text
DeveloperProfile
Opportunity
ProjectEvidence
EvaluationPolicyV1
```

`EvaluateOpportunity` requires `opportunities:evaluate`, which is granted to
owner and member roles and withheld from viewers. It validates only an
`opportunityId`; tenant and identity always come from trusted context. The
application loads the opportunity through `getById({ tenantId, opportunityId })`,
then the profile, then at most 10 tenant-scoped evidence search results. Foreign and
unknown opportunity IDs are indistinguishable `NOT_FOUND` results.

The pure policy owns these deterministic signals:

```text
skill match
project-type match
nullable budget compatibility
evidence strength
excluded-project penalties
risk flags
```

The policy owns fixed v1 weights, recommendation thresholds, overrides,
structured findings, evidence relevance, and:

```text
evaluationVersion = "v1"
```

Normalization is NFKC, trimmed, whitespace-collapsed, and lowercase. The
application builds a quoted `OR` query from normalized required then preferred
skills, falling back to project type and then opportunity title. It reuses the
existing PostgreSQL full-text search port with trusted tenant scope and a limit
of 10. Search rank controls retrieval order only; the policy scores experience
coverage from the returned structured evidence skill arrays.

The query builder enforces the existing 1000-character search contract with
required-first complete skill phrases and bounded fallback text. It passes query
truncation and page-continuation information into the pure policy. The result
flags `evidence_retrieval_incomplete` and suppresses claims of absent evidence
when retrieval is partial; scoring weights and recommendation overrides remain
unchanged. See the domain model for the exact bounded-query strategy.

The overall weights are skills 45, project type 20, budget 15, and evidence 20.
Null dimensions are removed from numerator and denominator. Because profile rate
currency is not modeled, the v1 budget score is always null. Thresholds and only
the three specified recommendation overrides live in the versioned policy.

Evaluation is read-only and not persisted. No evaluation table, transaction,
mutation, audit row, LLM call, embedding, or vector query is involved.

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

The process-owned `apps/mcp-server/src/lifecycle.ts` controller handles SIGINT,
SIGTERM, transport closure/stdin EOF, fatal database pool/client errors, and partial
startup failures. It caches one shutdown promise before invoking cleanup hooks;
reentrant transport-close callbacks and repeated signals share that path. A fatal
trigger upgrades an ongoing graceful shutdown to a nonzero exit.
The composition root retains the wire independently of the SDK handle, so it can
close a partially started transport if `serveStdio()` throws before returning.
Normal SDK closure is observed to avoid unnecessary duplicate wire cleanup.

On the first trigger, stdin is paused and the shared MCP invocation boundary
refuses new admission before context resolution or protected repository work.
Admitted callbacks are counted until execution, output validation, and invocation
logging finish; release is guaranteed on success and application errors. Shutdown
does not inject cancellation into use cases or retry them. SDK schema/protocol
failures remain outside this application tracking boundary.

Callbacks have a 10-second grace period. After draining or grace expiry, transport
and database cleanup start independently, so rejection or a hung cleanup cannot
prevent the other attempt. The process then closes stdin and flushes stdout before
normal termination. A single referenced 15-second timer bounds the entire path,
including output backpressure, and forces exit 1 on expiry. Draining/cleanup/output
failures also exit 1; clean signals/EOF exit 0. Timers are cleared on completion.
Safe lifecycle logs use only reason, phase, counts, and exit status on stderr.
Existing connection acquisition and PostgreSQL statement timeouts are unchanged.
The grace matches the existing 10-second statement timeout; the remaining total
budget allows cleanup/output without promising completion of multi-query work.
A diagnostic sink failure also exits nonzero without skipping cleanup or writing
fallback diagnostics to stdout. Late cleanup rejections remain observed after the
deadline; no further cleanup phases run after termination has been requested.

The SDK closes its wire immediately on EOF or output failure and aborts its
protocol requests. Application/database work already admitted may continue until
it settles or process termination intervenes. An invocation success log describes
execution and output validation, not response delivery. A committed note/audit is
never undone by disconnect or response validation failure. An interrupted open
transaction rolls back when its PostgreSQL connection closes, but a lost response
or a connection failure near COMMIT leaves the client uncertain. Explicit retries
must reuse the exact payload and original idempotency key under the same trusted
tenant/user; they return the committed note or create it if no commit exists.
No automatic mutation retry or response-delivery guarantee is introduced.

An active-query failure uses existing safe application error mapping. The database
adapter retains a client error listener while Drizzle holds a checked-out client,
preventing an unhandled EventEmitter error from printing raw diagnostics. Fatal
checked-out client errors and idle-pool errors both start shutdown; it can precede
error-response delivery. Normal SQL errors do not trigger that fatal connection
path. There is no automatic restart; an explicit retry may need a fresh stdio process.
Unit tests use fake timers to cover deadlines, concurrent triggers, failed/stuck
cleanup, and release behavior. Real PostgreSQL tests terminate isolated idle and
active backends, verify rollback/no automatic retry, and hold an audit-table lock
across EOF to prove an unseen commit is recovered without a duplicate note/audit.
Another subprocess holds an admitted invocation and a real checked-out PostgreSQL
client, proving the total deadline terminates a stalled drain/pool and releases
the connection. A Node 24 module-hook test exercises failure after starting the
wire but before returning the SDK handle. Test timeouts force-kill and observe
child exit to prevent orphan processes on failed assertions.
POSIX signal delivery is tested on POSIX; compiled-entry-point process events
cover handler routing on Windows as well. Uncatchable termination cannot run
cleanup, and timer deadlines require an available Node event loop.

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
