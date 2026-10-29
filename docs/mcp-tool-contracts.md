# MCP tool reference

Implemented at main baseline 2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7.
[Registrations](../packages/mcp/src/server.ts), [success schemas](../packages/mcp/src/schemas.ts),
[read inputs](../packages/application/src/read-inputs.ts) and
[note input](../packages/application/src/write-inputs.ts) are authoritative.
This document describes all eight tools; no remote authentication, external
integration or additional mutation is implied.

## Shared contract

Initialize the SDK connection before calling tools. Each request example below
is the params object for tools/call (also accepted by the SDK client's callTool).
Each response example is the success DTO carried in structuredContent. The actual
MCP result also contains a text content item with JSON.stringify of that same DTO.
The SDK handles the surrounding JSON-RPC request ID/framing; meta.requestId is a
separate, application-generated UUID.

All example records, IDs, content, prices and scores are synthetic. Examples were
generated through the actual application use cases with in-memory repositories,
then validated against the actual strict success schemas. They are independent
illustrations, not a seeded database or a real-client transcript. The repeated
request UUID is an illustrative placeholder; real invocations generate fresh IDs.
The illustrative search rank is schema-valid retrieval metadata, not a measured
PostgreSQL rank or benchmark. No database transaction is proven by these examples.

Every input object is strict. Unknown fields, including tenantId, userId, role,
permissions and requestId, are SDK-rejected before context or use-case execution.
Tenant, actor, membership, permissions and application request ID come from the
trusted server boundary. No tool may select a principal. Local identity still
trusts the operator/launcher; see [security](security.md).

### Permissions and side effects

| Tools                                                             | Permission             | Roles                 | Durable writes          |
| ----------------------------------------------------------------- | ---------------------- | --------------------- | ----------------------- |
| get_profile                                                       | profile:read           | owner, member, viewer | None                    |
| list_projects, get_project, search_project_evidence, get_blockers | projects:read          | owner, member, viewer | None                    |
| list_opportunities                                                | opportunities:read     | owner, member, viewer | None                    |
| evaluate_opportunity                                              | opportunities:evaluate | owner, member         | None                    |
| create_project_note                                               | project_notes:create   | owner, member         | Note and creation audit |

All read tools advertise readOnlyHint=true, destructiveHint=false,
idempotentHint=true, openWorldHint=false. The note tool changes only
readOnlyHint to false. Annotations guide clients; actual authorization,
constraints and transactions enforce behavior. Read tools create operational
invocation logs but no durable mutation audit.

### Pagination and values

List/search limits are integers 1-100, default 20. Optional cursor strings have
length 1-4096; omit rather than send null. Use an actual returned nextCursor with
the same filters; it is omitted on the last page. Page size can change because
limit is not part of cursor binding. Cursors are signed and tenant/capability/
filter-bound, not encrypted or expiring credentials. Concurrent data changes can
change later pages; no multi-page snapshot is promised.

UUID inputs use the actual Zod UUID schema. Dates are ISO datetime strings;
nullable output fields are present with null, not silently omitted. Monetary
opportunity outputs are exact two-decimal strings or null. Profile hourlyRate
also remains a string/null and has no modeled currency.

Allowed values:

- Project status: planned, active, paused, completed, archived.
- Opportunity status: new, reviewing, shortlisted, applied, rejected, won, lost, archived.
- Evidence type: feature, architecture, integration, business_outcome, performance,
  security, reliability, automation, client_result.
- Blocker severity: low, medium, high, critical. get_blockers always reads open blockers.
- Note category: general, decision, requirement, client_feedback, technical, follow_up, research.
- Opportunity budgetType: fixed, hourly, or null in output.

### Failures and bounds

Malformed protocol, unknown-tool and argument-schema failures belong to the SDK.
They do not require a BelovedDev envelope, invocation record or application
request ID. They cannot execute a use case through the registered callback.

After SDK validation, shared admission/context/use-case failures return
isError=true and one JSON text content item. Error results omit structuredContent,
because the output schema advertises success. For example, the decoded text of
an application permission failure is:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "The required permission is missing.",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

Common application codes are UNAUTHENTICATED, FORBIDDEN, VALIDATION_ERROR,
NOT_FOUND, CONFLICT, RATE_LIMITED and INTERNAL_ERROR. Active principal resolution
can itself access the membership repository; permission denial precedes protected
resource queries. Missing and foreign resource lookups are indistinguishable.
Cursor integrity/filter disagreement is application VALIDATION_ERROR, not an
SDK schema failure. Driver/unknown failures become safe INTERNAL_ERROR; raw SQL,
credentials, paths and stack traces are not returned.

Eight executing application slots, no queue, a 30-second response deadline and a
1 MiB serialized success result apply to every tool. Saturation returns
RATE_LIMITED; deadline, oversize and output-schema failures return INTERNAL_ERROR.
Shutdown refuses new admission. These limits do not cancel ongoing SQL or prove
rollback. Main logs invocation success and failure at info; higher log levels may
hide them. See [request/lifecycle architecture](architecture.md).

## get_profile

Read the current tenant's developer profile. Requires profile:read; read-only.
Tenant scope is taken exclusively from trusted context.

Input: an empty object, with no accepted properties.

Output: profile with id, displayName, headline, summary, location,
yearsExperience, hourlyRate, availability, skills, serviceAreas,
preferredProjectTypes, excludedProjectTypes, portfolioUrl and githubUrl; plus
meta.requestId. availability is a JSON-valued record, not a promised schedule
schema. URLs and rate are nullable. Missing profile returns NOT_FOUND;
unauthenticated/forbidden/internal failures follow the shared contract.

### Example invocation

<!-- example:get_profile:request -->

```json
{
  "name": "get_profile",
  "arguments": {}
}
```

### Example response DTO

<!-- example:get_profile:response -->

```json
{
  "profile": {
    "id": "22222222-2222-4222-8222-222222222222",
    "displayName": "Example Developer",
    "headline": "TypeScript backend developer",
    "summary": "Synthetic profile for documentation.",
    "location": "Example City",
    "yearsExperience": 5,
    "hourlyRate": null,
    "availability": {},
    "skills": ["TypeScript", "PostgreSQL"],
    "serviceAreas": ["Backend development"],
    "preferredProjectTypes": ["backend"],
    "excludedProjectTypes": [],
    "portfolioUrl": null,
    "githubUrl": null
  },
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## list_projects

List a tenant-scoped page of projects. Requires projects:read; read-only.

| Input           | Constraint                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| status?         | One project status                                                                |
| clientId?       | UUID filter, still tenant-scoped                                                  |
| query?          | Trimmed nonempty string, max 200; literal case-insensitive name/summary substring |
| limit?, cursor? | Shared pagination constraints                                                     |

Output: projects with id, name, slug, summary, status, stack, startedAt,
completedAt and client (id/name or null), optional nextCursor and meta.requestId.
Order is project UUID ASC. The cursor binds tenant, status, clientId and trimmed
query; query case is preserved in cursor semantics even though matching is
case-insensitive. Unknown/foreign client filters return an empty page rather
than disclose ownership. Invalid cursors return VALIDATION_ERROR; other failures
use the shared contract.

### Example invocation

<!-- example:list_projects:request -->

```json
{
  "name": "list_projects",
  "arguments": {
    "status": "active",
    "limit": 20
  }
}
```

### Example response DTO

<!-- example:list_projects:response -->

```json
{
  "projects": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Sample Project",
      "slug": "sample-project",
      "summary": "Synthetic project context.",
      "status": "active",
      "stack": ["TypeScript", "PostgreSQL"],
      "startedAt": null,
      "completedAt": null,
      "client": null
    }
  ],
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## get_project

Read bounded context for one project. Requires projects:read; read-only.

Input: required projectId UUID, with no other fields.

Output: project summary plus problemStatement, outcome, repositoryUrl,
productionUrl and portfolioUrl; root client (id/name or null); evidenceSummary
(id/type/title/summary, at most 20); openBlockers
(id/title/description/severity/blockedSince, at most 20); recentNotes
(id/category/content/createdAt, at most 10); and meta.requestId.
Nullable project dates/URLs are present as null when absent. This is a bounded
context view, not complete history or an atomic snapshot across all reads.
Missing and cross-tenant project IDs both return NOT_FOUND; child queries retain
tenant scope. Other failures use the shared contract.

### Example invocation

<!-- example:get_project:request -->

```json
{
  "name": "get_project",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111"
  }
}
```

### Example response DTO

<!-- example:get_project:response -->

```json
{
  "project": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Sample Project",
    "slug": "sample-project",
    "summary": "Synthetic project context.",
    "status": "active",
    "stack": ["TypeScript", "PostgreSQL"],
    "startedAt": null,
    "completedAt": null,
    "problemStatement": "Keep project decisions discoverable.",
    "outcome": "A documented transaction boundary.",
    "repositoryUrl": null,
    "productionUrl": null,
    "portfolioUrl": null
  },
  "client": null,
  "evidenceSummary": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "type": "reliability",
      "title": "Atomic note and audit",
      "summary": "Synthetic evidence of a transaction boundary."
    }
  ],
  "openBlockers": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "title": "Confirm rollout window",
      "description": "Synthetic open blocker.",
      "severity": "medium",
      "blockedSince": "2026-01-10T10:00:00.000Z"
    }
  ],
  "recentNotes": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "category": "decision",
      "content": "Keep the note and audit in one transaction.",
      "createdAt": "2026-01-10T10:00:00.000Z"
    }
  ],
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## search_project_evidence

Retrieve supporting evidence from the current tenant using PostgreSQL full-text
search. Requires projects:read; read-only. No LLM, embeddings or external calls.

| Input           | Constraint                                                                         |
| --------------- | ---------------------------------------------------------------------------------- |
| query           | Required trimmed nonempty string, max 1000; parsed by English websearch_to_tsquery |
| projectIds?     | Nonempty UUID array, max 100                                                       |
| evidenceTypes?  | Nonempty allowed-type array, max 9                                                 |
| skills?         | Nonempty array, max 50; each trimmed nonempty string max 100                       |
| limit?, cursor? | Shared pagination constraints                                                      |

Each supplied array has any-member semantics within that filter; different
filters combine with AND. Project/type lists are deduplicated and sorted;
skills are lowercased, deduplicated and sorted. Skill membership matching is
exact/case-insensitive, not fuzzy. The trimmed query is fingerprinted without
case folding. Foreign project filters cannot retrieve foreign evidence.

Output: results with evidenceId, projectId, projectName, type, title, summary,
skills, capabilities, businessOutcomes and relevanceScore; optional nextCursor;
meta.requestId. Order is ts_rank_cd DESC, evidence UUID ASC. The signed cursor
binds tenant and normalized search/filter fingerprint and preserves PostgreSQL's
rank text internally. Ranking is retrieval metadata, not fit scoring. Empty
matches return results=[]. Invalid/tampered/filter-incompatible cursors return
VALIDATION_ERROR; other failures use the shared contract.

### Example invocation

<!-- example:search_project_evidence:request -->

```json
{
  "name": "search_project_evidence",
  "arguments": {
    "query": "transaction",
    "skills": ["PostgreSQL"],
    "limit": 20
  }
}
```

### Example response DTO

<!-- example:search_project_evidence:response -->

```json
{
  "results": [
    {
      "evidenceId": "44444444-4444-4444-8444-444444444444",
      "projectId": "11111111-1111-4111-8111-111111111111",
      "projectName": "Sample Project",
      "type": "reliability",
      "title": "Atomic note and audit",
      "summary": "Synthetic evidence of a transaction boundary.",
      "skills": ["TypeScript", "PostgreSQL"],
      "capabilities": ["Transactions"],
      "businessOutcomes": [],
      "relevanceScore": 0.5
    }
  ],
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## get_blockers

Read a page of open blockers. Requires projects:read; read-only.

Input: optional projectId UUID, optional severity from the blocker enum, and
shared limit/cursor. No status argument is accepted; resolved blockers are excluded.

Output: blockers with id, projectId, projectName, title, description, severity
and blockedSince; optional nextCursor; meta.requestId. Order is blockedSince ASC,
UUID ASC. The cursor binds tenant, projectId and severity and preserves timestamp
microseconds. Unknown/foreign project filters return an empty page. Invalid
cursors return VALIDATION_ERROR; other failures use the shared contract.

### Example invocation

<!-- example:get_blockers:request -->

```json
{
  "name": "get_blockers",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "severity": "medium",
    "limit": 20
  }
}
```

### Example response DTO

<!-- example:get_blockers:response -->

```json
{
  "blockers": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "title": "Confirm rollout window",
      "description": "Synthetic open blocker.",
      "severity": "medium",
      "blockedSince": "2026-01-10T10:00:00.000Z",
      "projectId": "11111111-1111-4111-8111-111111111111",
      "projectName": "Sample Project"
    }
  ],
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## list_opportunities

List stored opportunities for the current tenant. Requires opportunities:read;
read-only. It does not import or synchronize job-site data.

| Input           | Constraint                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| status?         | One opportunity status                                                                                                                  |
| source?         | Trimmed/lowercased slug, max 100, pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$; exact match                                                       |
| query?          | Trimmed/lowercased nonempty string, max 200; literal case-insensitive substring across title, client name, description and project type |
| limit?, cursor? | Shared pagination constraints                                                                                                           |

No separate skill, project-type, client-name or budget filter is implemented.
LIKE metacharacters in the query are escaped, not interpreted as patterns.

Output: opportunities with id, source, title, clientName, projectType,
budgetType, amountMin, amountMax, currency, requiredSkills, preferredSkills,
status, sourceUrl and publishedAt; optional nextCursor; meta.requestId. Full
opportunity description/externalId are not returned. Optional stored values are
nullable output fields. Order is coalesce(publishedAt, createdAt) DESC, UUID DESC.
The cursor binds tenant and normalized status/source/query semantics. Empty
matches return opportunities=[]. Invalid/incompatible cursors return
VALIDATION_ERROR; other failures use the shared contract.

### Example invocation

<!-- example:list_opportunities:request -->

```json
{
  "name": "list_opportunities",
  "arguments": {
    "status": "reviewing",
    "source": "manual",
    "limit": 20
  }
}
```

### Example response DTO

<!-- example:list_opportunities:response -->

```json
{
  "opportunities": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "source": "manual",
      "title": "TypeScript backend project",
      "clientName": null,
      "projectType": "backend",
      "budgetType": "fixed",
      "amountMin": "1000.00",
      "amountMax": "2000.00",
      "currency": "USD",
      "requiredSkills": ["TypeScript"],
      "preferredSkills": ["PostgreSQL"],
      "status": "reviewing",
      "sourceUrl": null,
      "publishedAt": null
    }
  ],
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## evaluate_opportunity

Evaluate one stored opportunity against the current tenant's stored profile and
at most ten retrieved evidence results. Requires opportunities:evaluate;
owner/member only. Read-only: no persisted evaluation or mutation audit.

Input: required opportunityId UUID. No profile, tenant, scoring weights or policy
override can be supplied.

Output: opportunity (id/title/source); fit (overallScore/recommendation); scores
(skills/projectType/budget/experienceEvidence); matchedSkills; missingSkills;
strengths/concerns/riskFlags (code/message); relevantEvidence
(projectId/projectName/evidenceId/title/summary/relevanceScore); evaluationVersion;
meta.requestId. Scores are integer 0-100 or null where unavailable; budget is
always null under this model. Recommendations are strong_match, good_match,
review, weak_match or skip. Version is v1.

Matching uses NFKC, trimming, collapsed whitespace and lowercase. Versioned
weights are skills 45, project type 20, budget 15 and evidence 20; null dimensions
leave both numerator and denominator. Required/preferred skill coverage uses
80/20 when both exist. Base recommendation thresholds are 85/70/55/40, with
exclusion/required-coverage overrides. Exclusion wins over preference. Budget
cannot be compared because profile currency is not modeled.

Evidence queries contain bounded quoted OR phrases, prioritize complete required
skills over preferred skills and remain within 1000 UTF-16 units. Omitted/shortened
terms or another result page produce evidence_retrieval_incomplete. Incomplete
retrieval is not proof no other evidence exists; no_portfolio_evidence is withheld
in that case. Findings describe retrieved coverage, not a full portfolio audit.
The example score below is the actual v1 policy result for the synthetic profile,
opportunity and evidence described by the surrounding examples.

Missing/cross-tenant opportunity or missing profile returns NOT_FOUND. Viewers
receive FORBIDDEN before protected opportunity/profile/evidence queries. Other
failures follow the shared contract. [Policy source](../packages/domain/src/evaluation-policy-v1.ts)
and [orchestration](../packages/application/src/use-cases/evaluate-opportunity.ts)
define the exact findings and overrides.

### Example invocation

<!-- example:evaluate_opportunity:request -->

```json
{
  "name": "evaluate_opportunity",
  "arguments": {
    "opportunityId": "33333333-3333-4333-8333-333333333333"
  }
}
```

### Example response DTO

<!-- example:evaluate_opportunity:response -->

```json
{
  "opportunity": {
    "id": "33333333-3333-4333-8333-333333333333",
    "title": "TypeScript backend project",
    "source": "manual"
  },
  "fit": {
    "overallScore": 100,
    "recommendation": "strong_match"
  },
  "scores": {
    "skills": 100,
    "projectType": 100,
    "budget": null,
    "experienceEvidence": 100
  },
  "matchedSkills": ["typescript", "postgresql"],
  "missingSkills": [],
  "strengths": [
    {
      "code": "all_required_skills_matched",
      "message": "All required skills are present in the developer profile."
    },
    {
      "code": "preferred_project_type",
      "message": "The opportunity matches a preferred project type."
    },
    {
      "code": "strong_portfolio_evidence",
      "message": "Portfolio evidence demonstrates at least 80% of the requested skill coverage."
    }
  ],
  "concerns": [
    {
      "code": "budget_not_comparable",
      "message": "Budget compatibility cannot be scored because the profile rate has no currency."
    }
  ],
  "riskFlags": [],
  "relevantEvidence": [
    {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "projectName": "Sample Project",
      "evidenceId": "44444444-4444-4444-8444-444444444444",
      "title": "Atomic note and audit",
      "summary": "Synthetic evidence of a transaction boundary.",
      "relevanceScore": 0.5
    }
  ],
  "evaluationVersion": "v1",
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## create_project_note

Append one contextual note and creation audit. Requires project_notes:create;
owner/member only. It is the sole V1 mutation and makes no external calls.

| Input          | Constraint                                          |
| -------------- | --------------------------------------------------- |
| projectId      | Required UUID belonging to trusted tenant           |
| category       | Required note category                              |
| content        | Required nonblank string, 1-10000 UTF-16 units      |
| idempotencyKey | Required nonblank opaque string, 8-128 UTF-16 units |

Content and key must be well-formed Unicode without NUL. Both are preserved
exactly: no trimming, case folding or normalization. Tenant, actor and request
ID are never accepted from arguments. Archived owned projects remain eligible.

Output: note (id/projectId/category/content/createdAt), created boolean and
meta.requestId. Tenant, author and idempotency key are not exposed. created=true
means a new note/audit committed; created=false returns the original committed
note without another audit.

A READ COMMITTED transaction verifies the tenant-scoped project, attempts INSERT
with UNIQUE(tenant_id, author_user_id, idempotency_key), and audits only new
notes. A competing insert waits; a separate lookup observes the winner and
compares canonical project ID plus exact category/content. Matching retry returns
original ID/time. Another owned project/category/content with the same scoped
key returns CONFLICT. Missing/foreign project returns NOT_FOUND before key lookup.
Request IDs are not part of equality; each retry receives a new invocation ID,
while the original audit keeps its original request ID.

An audit failure rolls back the new note with it. Audit metadata is exactly
projectId/category, with no content or key. Connection loss near COMMIT is an
uncertain outcome. Output validation, response-size limits, timeouts or client
disconnect can also fail after commit. No automatic transaction/tool retry occurs.
Retry only explicitly under the same tenant/author with the identical payload and
original key. A new key can duplicate a previously committed note. Authorization
is checked again on every retry. See the [transaction and retry diagrams](architecture.md#note-creation-and-audit-transaction).

Schema-invalid arguments are SDK errors; application authorization, NOT_FOUND,
CONFLICT, cursor-independent validation and infrastructure errors follow the
shared envelope. Successful output schema validation is not a delivery guarantee.

### Example invocation

<!-- example:create_project_note:request -->

```json
{
  "name": "create_project_note",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "category": "decision",
    "content": "Keep the note and audit in one transaction.",
    "idempotencyKey": "portfolio-example-note-001"
  }
}
```

### Example response DTO

<!-- example:create_project_note:response -->

```json
{
  "note": {
    "id": "66666666-6666-4666-8666-666666666666",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "category": "decision",
    "content": "Keep the note and audit in one transaction.",
    "createdAt": "2026-01-10T10:00:00.000Z"
  },
  "created": true,
  "meta": {
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

## Contract evolution

Examples do not authorize changes to these contracts. Review strict schemas,
application rules, SQL constraints and tests together when changing field
semantics, filters or scoring; version deterministic policy changes explicitly.
See [case-study verification](case-study.md#verification),
[security disclosure](security.md), and [domain specification](domain-model.md).
