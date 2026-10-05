# BelovedDev MCP V1 — Domain Model

## Milestones 1 and 2 concrete storage decisions

Implemented tables: tenants, users, tenant_memberships, developer_profiles,
clients, projects, project_evidence, project_blockers, and project_notes.
Opportunity and audit entities below remain proposed.

Tenant, user, and membership statuses are active/inactive; clients are
active/archived. Email uniqueness is global and case-insensitive, without any
authentication or account-linking behavior. Project/client ownership is enforced
by a composite foreign key. Profile rates use exact decimal strings and may be
null when unpublished; profile links are nullable when absent. Currency semantics
are not yet modeled. Availability is a JSON object, and the collection fields are
arrays of strings checked by PostgreSQL.

See [database conventions](database.md) for nullability, indexes, migration
workflow, and the distinction between scoped repository access and future
authenticated tenant context.

Milestone 2 stores all specified knowledge fields. Evidence title, summary, and
details; blocker title and description; and note content and idempotency key must
contain a non-whitespace character. Evidence collections are JSONB string arrays
defaulting to empty arrays. Evidence type, blocker severity/status, and note
category are PostgreSQL enums matching the values below.

Every knowledge row has a non-null tenant and project. Composite foreign keys
reference `projects(tenant_id, id)`, preventing cross-tenant inserts, updates, and
parent ownership changes. Deletion is restricted.

An open blocker has no resolution timestamp; a resolved blocker requires one.
Resolution cannot precede `blocked_since`. Blockers default to open with
`blocked_since = now()`; severity must be supplied. No resolution use case exists.

Notes reference both the global author user and
`tenant_memberships(tenant_id, user_id)`. Membership existence is a persistent
database invariant. Membership status and permissions are future application
checks: making a membership inactive preserves historical notes, and does not
make direct SQL an authorized mutation. Referenced memberships cannot be deleted.
The unique key is exactly `(tenant_id, author_user_id, idempotency_key)`, across
projects. Duplicate-result handling and transactional auditing remain Milestone 7.
Milestone 2 exposes read-only knowledge repositories, with no note mutation API
or database trigger claiming append-only enforcement.

## 1. Domain Boundary

V1 covers four primary domains:

```text
Identity / Tenancy
Professional Profile
Projects / Portfolio Knowledge
Freelance Opportunities
```

Audit logging is a cross-cutting operational concern.

## 2. Tenant

A tenant is the primary data ownership and authorization boundary.

### Fields

```text
Tenant
- id
- name
- slug
- status
- createdAt
- updatedAt
```

### Invariants

- `slug` is globally unique.
- tenant-owned entities must reference a tenant.
- inactive tenants must not receive normal application access.

## 3. User

Represents an authenticated human identity.

### Fields

```text
User
- id
- email
- displayName
- status
- createdAt
- updatedAt
```

Authentication mechanics may be provided by an external identity system later.

## 4. TenantMembership

Represents the relationship between a user and a tenant.

### Fields

```text
TenantMembership
- id
- tenantId
- userId
- role
- status
- createdAt
```

### Initial Roles

```text
owner
member
viewer
```

### Invariants

```text
UNIQUE(tenant_id, user_id)
```

Roles should map to permissions rather than being checked throughout the codebase.

## 5. DeveloperProfile

Represents the professional profile used for capability retrieval and opportunity evaluation.

### Fields

```text
DeveloperProfile
- id
- tenantId
- displayName
- headline
- summary
- location
- yearsExperience
- hourlyRate
- availability
- skills
- serviceAreas
- preferredProjectTypes
- excludedProjectTypes
- portfolioUrl
- githubUrl
- createdAt
- updatedAt
```

### V1 Storage Guidance

The following may be represented as structured JSONB in V1:

```text
skills
serviceAreas
preferredProjectTypes
excludedProjectTypes
availability
```

Do not normalize these into many supporting tables until querying requirements justify it.

### Invariant

One developer profile per tenant in V1:

```text
UNIQUE(tenant_id)
```

## 6. Client

Represents a customer or organization associated with one or more projects.

### Fields

```text
Client
- id
- tenantId
- name
- status
- notes
- createdAt
- updatedAt
```

V1 does not attempt to implement a full CRM.

## 7. Project

Represents a development project.

### Fields

```text
Project
- id
- tenantId
- clientId?
- name
- slug
- summary
- problemStatement
- outcome
- status
- startedAt?
- completedAt?
- stack
- repositoryUrl?
- productionUrl?
- portfolioUrl?
- createdAt
- updatedAt
```

### Status

```text
planned
active
paused
completed
archived
```

Use a PostgreSQL check constraint or equivalent database-level enforcement.

### Invariants

```text
UNIQUE(tenant_id, slug)
```

If `clientId` is provided, the referenced client must belong to the same tenant.

## 8. ProjectEvidence

Project evidence describes what a project proves.

This is more useful for agents than relying only on project titles or descriptions.

### Fields

```text
ProjectEvidence
- id
- tenantId
- projectId
- type
- title
- summary
- details
- skills
- capabilities
- businessOutcomes
- createdAt
- updatedAt
```

### Evidence Types

Initial values:

```text
feature
architecture
integration
business_outcome
performance
security
reliability
automation
client_result
```

### Example

```text
Project:
HVAC Estimate Widget

Evidence:
Implemented tenant-configurable estimator flow with ZIP eligibility,
lead capture, configurable packages, transactional persistence,
and email notifications.

Skills:
TypeScript
React
PostgreSQL

Capabilities:
multi-tenancy
business rules
lead handling
custom calculator
API integration
```

### Search Role

Evidence is the primary searchable portfolio unit for `search_project_evidence`.

## 9. ProjectNote

Represents append-only contextual project notes.

### Fields

```text
ProjectNote
- id
- tenantId
- projectId
- authorUserId
- category
- content
- idempotencyKey
- createdAt
```

### Categories

```text
general
decision
requirement
client_feedback
technical
follow_up
research
```

### V1 Behavior

Notes are append-only through MCP.

V1 exposes no MCP update or delete note tool.

### Idempotency Invariant

```text
UNIQUE(
  tenant_id,
  author_user_id,
  idempotency_key
)
```

This protects against duplicate agent or transport retries.

## 10. ProjectBlocker

Represents an unresolved or resolved issue that prevents or materially delays project progress.

### Fields

```text
ProjectBlocker
- id
- tenantId
- projectId
- title
- description
- severity
- status
- blockedSince
- resolvedAt?
- createdAt
- updatedAt
```

### Severity

```text
low
medium
high
critical
```

### Status

```text
open
resolved
```

### V1 Query Behavior

`get_blockers` defaults to open blockers.

Resolved blocker history is not the main V1 retrieval path.

## 11. Opportunity

Represents a freelance/job opportunity stored in the system.

### Fields

```text
Opportunity
- id
- tenantId
- source
- externalId?
- title
- clientName?
- description
- projectType?
- budgetType?
- budgetMin?
- budgetMax?
- hourlyMin?
- hourlyMax?
- currency?
- requiredSkills
- preferredSkills
- status
- sourceUrl?
- publishedAt?
- createdAt
- updatedAt
```

### Status

```text
new
reviewing
shortlisted
applied
rejected
won
lost
archived
```

### External Identity

For externally sourced records:

```text
UNIQUE(tenant_id, source, external_id)
```

where `external_id IS NOT NULL`.

## 12. OpportunityEvaluationResult

V1 treats evaluation as a derived application result rather than a persisted aggregate.

### Fields

```text
OpportunityEvaluationResult
- opportunity
- fit
  - overallScore
  - recommendation
- scores
  - skills
  - projectType
  - budget
  - experienceEvidence
- matchedSkills
- missingSkills
- strengths
- concerns
- riskFlags
- relevantEvidence
- evaluationVersion
```

### Recommendation

```text
strong_match
good_match
review
weak_match
skip
```

### Design Decision

Do not persist evaluations in V1.

Reasons:

- scoring rules are expected to evolve;
- persistence would require profile/evidence snapshots;
- historical interpretation would require algorithm versioning;
- V1 gains little from evaluation history.

Every evaluation must still include an `evaluationVersion`.

## 13. AuditLog

Represents an immutable audit record for a state-changing operation.

### Fields

```text
AuditLog
- id
- tenantId
- actorUserId
- action
- resourceType
- resourceId
- requestId
- metadata
- createdAt
```

### Example

```text
action = project_note.created
resourceType = project_note
```

Avoid storing unnecessary sensitive request contents.

## 14. Domain Relationships

```text
Tenant
 ├── DeveloperProfile
 ├── TenantMembership ── User
 ├── Client
 │    └── Project
 │         ├── ProjectEvidence
 │         ├── ProjectNote
 │         └── ProjectBlocker
 ├── Opportunity
 └── AuditLog
```

A project may exist without a client.

## 15. Initial Database Tables

V1 tables:

```text
tenants
users
tenant_memberships
developer_profiles
clients
projects
project_evidence
project_notes
project_blockers
opportunities
audit_logs
```

Do not initially add:

```text
tasks
opportunity_evaluations
integrations
messages
emails
credentials
agent_runs
```

## 16. Indexing Strategy

Tenant ID should normally lead tenant-scoped indexes.

Initial indexes should support real access paths such as:

```text
projects(tenant_id, status)

project_evidence(tenant_id, project_id)

project_notes(tenant_id, project_id, created_at)

project_blockers(tenant_id, status)

project_blockers(tenant_id, project_id, status)

opportunities(tenant_id, status)
```

Project evidence should also receive a PostgreSQL GIN full-text search index.

The indexed document may combine:

```text
title
summary
details
skills
capabilities
businessOutcomes
```

The exact generated/search-vector implementation should be chosen during the database milestone after inspecting PostgreSQL and Drizzle ergonomics.

## 17. Domain Rules Summary

1. Tenant scope comes from trusted context.
2. Tenant-owned resources may never be accessed across tenants.
3. Projects and child records must belong to the same tenant.
4. MCP tool input must not select tenant identity.
5. Project notes are append-only in V1.
6. Project-note creation is idempotent.
7. Opportunity evaluation is deterministic and versioned.
8. Opportunity evaluation is not persisted in V1.
9. Database constraints should enforce stable invariants.
10. Domain behavior must not depend on MCP-specific concepts.
