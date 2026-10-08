# BelovedDev MCP V1 — MCP Tool Contracts

## 1. Contract Standard

Every MCP tool must define:

```text
name
purpose
input
output
required permission
tenant scope
side-effect classification
failure behavior
audit behavior
```

MCP schemas are transport contracts.

Business rules remain in application/domain code.

## 2. Standard Response Metadata

Successful responses should include:

```text
meta
  requestId
```

Paginated responses should additionally include:

```text
nextCursor?
```

Use cursor pagination rather than offset pagination.

## 3. Standard Failure Categories

Initial safe errors:

```text
UNAUTHENTICATED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
CONFLICT
RATE_LIMITED
INTERNAL_ERROR
```

Possible error payload:

```text
error
  code
  message
  requestId
  details?
```

`details` is reserved for safe structured information such as field-validation errors.

Never expose raw database errors or stack traces.

---

# 4. `get_profile`

## Purpose

Return the authoritative developer profile for the authenticated tenant.

## Input

```json
{}
```

No tenant or user identifier is accepted.

## Output

```text
profile
  id
  displayName
  headline
  summary
  location
  yearsExperience
  hourlyRate
  availability
  skills
  serviceAreas
  preferredProjectTypes
  excludedProjectTypes
  portfolioUrl
  githubUrl

meta
  requestId
```

## Required Permission

```text
profile:read
```

## Tenant Scope

Trusted request context.

## Side Effects

None.

## Failure Behavior

- unauthenticated → `UNAUTHENTICATED`
- missing required profile → `NOT_FOUND`
- unexpected infrastructure failure → `INTERNAL_ERROR`

## Audit

No durable mutation audit.

Structured request log only.

---

# 5. `list_projects`

## Purpose

List projects available to the authenticated tenant.

## Input

```text
status?
clientId?
query?
limit?
cursor?
```

Suggested limits:

```text
default limit = 20
maximum limit = 100
```

## Output

```text
projects[]
  id
  name
  slug
  summary
  status
  client?
    id
    name
  stack
  startedAt?
  completedAt?

nextCursor?

meta
  requestId
```

## Required Permission

```text
projects:read
```

## Tenant Scope

All queries use trusted tenant context.

## Side Effects

None.

## Failure Behavior

- invalid status/filter → `VALIDATION_ERROR`
- malformed cursor → `VALIDATION_ERROR`
- infrastructure failure → `INTERNAL_ERROR`

If `clientId` belongs to another tenant, the query must not reveal that fact. Returning an empty result is acceptable for a list filter.

## Audit

Structured request log only.

---

# 6. `get_project`

## Purpose

Retrieve useful full context for one project.

## Input

```text
projectId
```

## Output

```text
project
  id
  name
  slug
  summary
  problemStatement
  outcome
  status
  stack
  repositoryUrl?
  productionUrl?
  portfolioUrl?
  startedAt?
  completedAt?

client?
  id
  name

evidenceSummary[]
  id
  type
  title
  summary

openBlockers[]
  id
  title
  description
  severity
  blockedSince

recentNotes[]
  id
  category
  content
  createdAt

meta
  requestId
```

The V1 response need not return every historical evidence item or every note.

## Required Permission

```text
projects:read
```

## Tenant Scope

Trusted request context.

## Side Effects

None.

## Failure Behavior

- missing project → `NOT_FOUND`
- project owned by another tenant → `NOT_FOUND`
- infrastructure failure → `INTERNAL_ERROR`

Do not distinguish between nonexistent and cross-tenant resources.

## Audit

Structured request log only.

---

# 7. `search_project_evidence`

## Purpose

Find project evidence supporting a skill, capability, business requirement, implementation pattern, or job opportunity.

## Input

```text
query
projectIds?
evidenceTypes?
skills?
limit?
cursor?
```

Suggested constraints:

```text
query: 1..1000 characters
default limit: 20
maximum limit: 100
```

## Output

```text
results[]
  evidenceId
  projectId
  projectName
  type
  title
  summary
  skills
  capabilities
  businessOutcomes
  relevanceScore

nextCursor?

meta
  requestId
```

## Required Permission

```text
projects:read
```

## Tenant Scope

Trusted request context.

Any project IDs supplied as filters must still be constrained by the authenticated tenant.

## Side Effects

None.

## Search Behavior

V1 search uses:

```text
PostgreSQL full-text search
+
structured filters
```

No embeddings in V1.

`relevanceScore` is a search ranking value, not an LLM-generated judgment.

## Failure Behavior

- empty/invalid query → `VALIDATION_ERROR`
- malformed cursor → `VALIDATION_ERROR`
- infrastructure/search failure → `INTERNAL_ERROR`

## Audit

Structured request log only.

---

# 8. `get_blockers`

## Purpose

Retrieve unresolved project blockers.

## Input

```text
projectId?
severity?
limit?
cursor?
```

Default behavior:

```text
status = open
```

Suggested:

```text
default limit = 20
maximum limit = 100
```

## Output

```text
blockers[]
  id
  projectId
  projectName
  title
  description
  severity
  blockedSince

nextCursor?

meta
  requestId
```

## Required Permission

```text
projects:read
```

## Tenant Scope

Trusted request context.

## Side Effects

None.

## Failure Behavior

- invalid severity → `VALIDATION_ERROR`
- project filter outside tenant → return no matching records or `NOT_FOUND` if implemented as a resource-scoped query; behavior must be deterministic and tested
- infrastructure failure → `INTERNAL_ERROR`

## Audit

Structured request log only.

---

# 9. `list_opportunities`

This is the planned Milestone 5-B interface. Milestone 5-A implements the
database, repository, and application capability only; the MCP tool is not yet
registered.

## Purpose

List stored freelance or job opportunities.

## Input

```text
status?
source?  exact canonical lowercase slug
query?   literal case-insensitive substring across title, client name,
         description, and project type
limit?
cursor?
```

Suggested limits:

```text
default limit = 20
maximum limit = 100
```

## Output

```text
opportunities[]
  id
  source
  title
  clientName?
  projectType?
  budgetType?
  amountMin?
  amountMax?
  currency?
  requiredSkills
  preferredSkills
  status
  sourceUrl?
  publishedAt?

nextCursor?

meta
  requestId
```

Results order by `coalesce(publishedAt, createdAt) DESC`, then opportunity UUID
descending. The signed cursor carries the ordering timestamp and UUID and is
bound to trusted tenant scope plus normalized status, source, and query filters.

## Required Permission

```text
opportunities:read
```

## Tenant Scope

Trusted request context.

## Side Effects

None.

## Failure Behavior

- invalid filter → `VALIDATION_ERROR`
- malformed cursor → `VALIDATION_ERROR`
- infrastructure failure → `INTERNAL_ERROR`

## Audit

Structured request log only.

---

# 10. `evaluate_opportunity`

## Purpose

Evaluate one stored opportunity against the authenticated tenant's developer profile and available project evidence.

## Input

```text
opportunityId
```

Do not accept an arbitrary developer profile from MCP input in V1.

## Output

```text
opportunity
  id
  title
  source

fit
  overallScore
  recommendation

scores
  skills
  projectType
  budget
  experienceEvidence

matchedSkills[]
missingSkills[]

strengths[]
concerns[]
riskFlags[]

relevantEvidence[]
  projectId
  projectName
  evidenceId
  title
  summary
  relevanceScore

evaluationVersion

meta
  requestId
```

## Recommendation Values

```text
strong_match
good_match
review
weak_match
skip
```

## Required Permission

```text
opportunities:evaluate
```

## Tenant Scope

Trusted request context.

The target opportunity, profile, and evidence must all belong to the authenticated tenant.

## Side Effects

None.

## Evaluation Rules

The deterministic application/domain layer may consider:

```text
required skill match
preferred skill match
excluded project types
preferred project types
budget compatibility
relevant portfolio evidence
missing evidence
risk flags
```

The exact weights and thresholds must be versioned and unit-tested when implemented.

Initial version:

```text
evaluationVersion = "v1"
```

## Persistence

Do not persist evaluation results in V1.

## Failure Behavior

- opportunity missing → `NOT_FOUND`
- cross-tenant opportunity → `NOT_FOUND`
- developer profile missing → `NOT_FOUND` or a specific safe application error mapped consistently
- malformed opportunity data that violates evaluation assumptions → safe `INTERNAL_ERROR` plus diagnostic logging, unless it is a user-correctable validation condition
- infrastructure failure → `INTERNAL_ERROR`

## Audit

Structured request log only.

---

# 11. `create_project_note`

## Purpose

Append a contextual note to a project.

This is the only planned V1 MCP mutation.

## Input

```text
projectId
category
content
idempotencyKey
```

Suggested constraints:

```text
content:
1..10,000 characters

idempotencyKey:
8..128 characters
```

Allowed categories:

```text
general
decision
requirement
client_feedback
technical
follow_up
research
```

## Output

```text
note
  id
  projectId
  category
  content
  createdAt

created

meta
  requestId
```

`created` indicates:

```text
true  = a new note was created
false = an existing idempotent result was returned
```

## Required Permission

```text
project_notes:create
```

## Tenant Scope

Trusted request context.

The project must belong to the authenticated tenant.

## Side Effects

Creates:

```text
ProjectNote
AuditLog
```

## Transaction

The logical operation must be atomic:

```text
verify project belongs to tenant
        ↓
check existing idempotency key
        ↓
insert note
        ↓
insert audit record
        ↓
commit
```

If any step fails:

```text
rollback
```

## Idempotency

Database uniqueness:

```text
UNIQUE(
  tenant_id,
  author_user_id,
  idempotency_key
)
```

A safe retry with the same idempotency key returns the previous result.

An idempotency-key collision representing a semantically different operation should produce `CONFLICT` rather than silently changing the previous operation.

The exact comparison fields for detecting a conflicting reuse should be defined during implementation and covered by tests.

## Failure Behavior

- unauthenticated → `UNAUTHENTICATED`
- missing permission → `FORBIDDEN`
- invalid category/content/key → `VALIDATION_ERROR`
- project missing or cross-tenant → `NOT_FOUND`
- conflicting idempotency reuse → `CONFLICT`
- database failure → rollback + `INTERNAL_ERROR`

## Audit

Required.

Suggested audit record:

```text
action = project_note.created
resourceType = project_note
resourceId = <note id>
requestId = <request id>
```

Metadata should contain only safe, useful fields.

---

# 12. Contract Stability

Once an MCP tool is released, avoid silent incompatible contract changes.

When changing:

- field semantics
- required inputs
- output structure
- scoring behavior
- pagination semantics

update:

```text
documentation
contract tests
evaluation version where applicable
```

Prefer additive evolution where practical.

## MCP SDK and application error boundary

The five implemented read tools use the official MCP SDK v2
`McpServer.registerTool()` API with strict Zod input and success-output schemas.

Invalid protocol requests, unknown tools, and invalid tool argument schemas are
SDK/protocol-layer failures. The SDK rejects them before the registered callback:
no BelovedDev use case, trusted-context lookup, or resource repository runs.
These failures follow SDK response semantics; they do not require a BelovedDev
application error envelope, application request ID, or invocation log.

After SDK validation, the shared callback generates an application request ID,
resolves trusted context, executes the use case, validates its success output,
and records a structured invocation log. Unauthenticated, forbidden, not-found,
application validation (including cursor integrity), and infrastructure failures
produce a safe application error as JSON text with `isError: true`.
Error results omit `structuredContent` because the advertised output schema
describes success. Success returns matching JSON text and `structuredContent`
with `meta.requestId`. Neither input schemas nor permissions are relaxed to
route SDK failures through application code.

`search_project_evidence` follows this same boundary. Its MCP input exposes only
the user query, project/evidence-type/skill filters, page limit, and opaque cursor.
Tenant identity, PostgreSQL query controls, relevance positions, fingerprint, and
search vector remain internal. Its success schema mirrors the application result;
the tool is read-only and requires `projects:read`.
