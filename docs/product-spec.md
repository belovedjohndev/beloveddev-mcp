# BelovedDev MCP V1 — Product Specification

## 1. Status

**Version:** V1 proposed specification  
**Product:** BelovedDev MCP  
**Primary interface:** Model Context Protocol  
**Primary data store:** PostgreSQL

## 2. Product Statement

BelovedDev MCP is a private operational knowledge service that gives AI clients and agents reliable access to developer profile information, project history, portfolio evidence, blockers, and freelance opportunities.

It exists to make project and opportunity decisions grounded in authoritative data instead of model memory or hallucinated context.

The system should support questions such as:

- What projects have I built?
- Which projects demonstrate experience relevant to this opportunity?
- What is the current status of a project?
- What blockers remain unresolved?
- Which opportunities deserve attention?
- What skills match or do not match an opportunity?
- What portfolio evidence supports a proposal?
- Add this finding or decision to the project notes.

## 3. Product Goals

V1 must provide:

1. developer profile retrieval;
2. project listing and retrieval;
3. structured portfolio-evidence search;
4. unresolved blocker retrieval;
5. opportunity listing;
6. deterministic opportunity-fit evaluation;
7. controlled project-note creation.

## 4. V1 MCP Surface

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

## 5. Non-Goals

V1 does not include:

- Gmail integration
- Google Calendar integration
- GitHub synchronization
- Upwork synchronization
- automatic proposal submission
- email sending
- calendar mutation
- billing or invoicing
- background workers
- autonomous client communication
- multi-agent orchestration
- embeddings
- vector databases
- persisted opportunity evaluation history
- general-purpose project mutations
- proposal-generation business logic inside the MCP server

These may be added after the V1 domain and security model are proven.

## 6. Product Principles

### 6.1 MCP is an interface

MCP tool handlers translate between the protocol and application use cases.

They must not become the location for business rules, SQL, scoring logic, or authorization shortcuts.

### 6.2 Deterministic code controls correctness

Deterministic code owns:

- authentication context
- authorization
- tenant scope
- validation
- transactions
- idempotency
- data integrity
- scoring rules
- failure behavior
- audit behavior

AI may handle qualitative judgment and explanation after receiving reliable tool results.

### 6.3 Read-only first

Read-only tools are preferred until the application's security and tenancy boundaries are verified.

`create_project_note` is the only planned V1 mutation.

### 6.4 Tenant-safe from the beginning

Although the first deployment may initially serve one user, V1 must be structurally safe for multiple tenants.

## 7. Primary Actor

The primary actor is an authenticated human user whose AI client communicates with BelovedDev MCP.

Trusted application context should include:

```text
userId
tenantId
membershipId
role
permissions
requestId
```

The model must never provide these values as proof of authorization.

## 8. Main Product Workflows

### 8.1 Retrieve developer capability context

```text
AI Client
→ get_profile
→ authoritative developer profile
```

Use cases:

- proposal preparation
- opportunity evaluation
- capability summaries
- identifying preferred and excluded project types

### 8.2 Retrieve project context

```text
AI Client
→ list_projects
→ get_project
```

Use cases:

- continue work on an existing project
- understand status and stack
- find relevant project history
- review blockers and recent context

### 8.3 Search portfolio evidence

```text
AI Client
→ search_project_evidence
```

Use cases:

- identify evidence for proposals
- answer experience questions
- find similar prior implementations
- support job-fit decisions

Evidence must represent what a project proves, not merely that a project exists.

### 8.4 Evaluate an opportunity

```text
AI Client
→ evaluate_opportunity
→ deterministic evaluation result
→ model explanation/judgment
```

The application should calculate factual and rule-based indicators.

The model may explain whether the opportunity appears worth pursuing.

### 8.5 Record a project note

```text
AI Client
→ create_project_note
→ authorization
→ transaction
→ note
→ audit record
```

The operation must be idempotent.

## 9. Success Criteria

V1 is successful when:

1. an MCP client can retrieve real project/profile data from PostgreSQL;
2. all tenant-owned data is protected by explicit tenant scoping;
3. project evidence can be searched effectively without embeddings;
4. opportunities can be evaluated using deterministic versioned rules;
5. duplicate project-note requests do not create duplicate records;
6. mutations are durably audited;
7. MCP tool contracts are tested;
8. application and repository layers can be tested independently;
9. cross-tenant isolation has explicit regression coverage;
10. production failure behavior does not leak sensitive implementation details.

## 10. Quality Requirements

### Security

- trusted authentication context
- membership validation
- permission checks
- tenant isolation
- safe errors
- no secret logging
- no model-controlled authorization

### Reliability

- deterministic behavior
- transaction safety
- duplicate-call safety
- explicit failure categories
- graceful shutdown
- database connection management
- sensible request limits

### Maintainability

- domain logic independent from MCP transport
- repository interfaces separated from PostgreSQL implementations
- migrations for schema changes
- documentation aligned with implementation
- no premature abstractions

### Observability

Each request should carry or receive a request ID.

Structured logs should include:

```text
requestId
toolName
actorUserId
tenantId
durationMs
resultStatus
errorCategory
```

## 11. Future Product Directions

Possible post-V1 capabilities:

```text
GitHub integration
Gmail integration
Google Calendar integration
Upwork integration
tasks and follow-ups
proposal support
project status updates
client CRM features
integration credentials
background synchronization
agent evals
OpenTelemetry
semantic search
```

These should be introduced one use case at a time rather than pre-built into V1.
