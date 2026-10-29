# BelovedDev MCP: engineering reliable tools for AI clients

## Portfolio summary

**Problem.** An AI assistant can summarize freelance work, but it needs reliable
project context and a constrained way to record decisions. Free-form model output
cannot enforce tenant access, score opportunities consistently, or make duplicate
writes safe.

**Solution.** A local stdio MCP server with eight typed tools over PostgreSQL.
Seven tools read structured developer/project/opportunity data. The single write
creates a project note and its audit in one transaction, with an explicit retry
key. A versioned domain policy evaluates fit without calling an LLM.

**My role.** Backend/MCP engineering: defining boundaries and tool contracts,
tenant-scoped persistence, deterministic rules, transactional writes, tests, and
operational workflows. This describes the repository's engineering scope; it does
not claim sole authorship, a client engagement, or production incident ownership.

**Evidence.** Strict TypeScript/Zod contracts, real PostgreSQL constraint and
concurrency tests, SDK contract tests, process-level stdio tests, and bounded
migration/recovery workflows. Exact verification scope is recorded below.

**Limits.** This is an implemented portfolio system, not a production-approved
remote service. Local identity trusts the operator. Image/dependency security
maintenance remains separate draft work. No revenue, time-saving metric, adoption
figure or customer outcome is claimed.

## Architecture

```text
AI client -> MCP interface -> application use cases
                            -> deterministic domain rules
                            -> repository ports -> PostgreSQL adapters -> PostgreSQL 18
```

[Six architecture diagrams](architecture.md) cover the system, request lifecycle,
authorization, note/audit transaction, idempotent retries and migration/recovery.
MCP selects an application capability; it does not become the domain model.
[main.ts](../apps/mcp-server/src/main.ts) explicitly wires dependencies, without a
DI framework. Domain/application code does not import MCP or Drizzle. Repository
ports describe specific operations rather than generic CRUD.

This keeps pure fit rules independently testable and leaves future interfaces
possible without implementing a speculative HTTP API. The trade-off is explicit
DTO mapping and several small packages that need coordinated builds. Keeping
shared metadata-only avoids creating abstractions before they have consumers.

## Engineering challenges and key implementations

### Model-controlled input and typed boundaries

Every [registered tool](../packages/mcp/src/server.ts) has strict input and
success-output schemas. SDK protocol/argument rejection happens before the
application callback. Valid invocations receive a generated request ID, trusted
context, permission checks, result validation and safe errors. The model cannot
supply a tenant, identity or scoring policy.

TypeScript checks internal contracts; Zod validates runtime boundaries;
PostgreSQL constraints defend stored invariants. These layers address different
failure sources rather than assuming generated input or a static type is safe.
Output validation is valuable but occurs after committed side effects: it cannot
undo a note when a response fails. The [tool reference](mcp-tool-contracts.md)
includes eight examples generated through actual use cases with synthetic data.

### Tenant isolation and least privileges

[Repository SQL](../packages/infrastructure/src/postgres) requires trusted tenant
scope, including joins and list/search filters. Missing and foreign lookups are
indistinguishable. Composite foreign keys prevent cross-tenant project/client
and project-child relationships. The application authorizes permissions before
protected resource work; active membership and role are revalidated per call.

A separate runtime database login has narrow reads and append-only note/audit
writes. Startup rejects incompatible schema/history and dangerous effective
grants before request handling. Verified TLS is mandatory for remote database
endpoints. The important trade-off is explicit: there is no RLS, and stolen
runtime credentials can bypass application tenant isolation. Local configured
identity is not independent authentication. [Security limitations](security.md)
are part of the design account, not omitted from the portfolio presentation.

### Search and signed pagination

Evidence retrieval uses PostgreSQL English full-text search, a stored weighted
vector, GIN indexing and deterministic rank/UUID ordering. Structured filters
remain SQL predicates. Opportunity text matching is a different, literal substring
capability; it is not mislabeled full-text search.

[HMAC-signed keyset cursors](../packages/infrastructure/src/signed-cursor.ts)
bind tenant, capability, normalized supported filters and exact ordering position.
Evidence cursors retain PostgreSQL rank text and timestamp cursors retain
microseconds. This avoids offsets and client-forged positions. It does not encrypt
cursor contents or provide a consistent snapshot while records change. Key
rotation invalidates old cursors; cursor expiry/key rotation infrastructure is
not implemented.

### Deterministic opportunity evaluation

[EvaluationPolicyV1](../packages/domain/src/evaluation-policy-v1.ts) normalizes
skills/project types and produces scores, findings, risks and a versioned
recommendation. Exclusion takes precedence over preference. Budget remains null
because the profile model lacks currency; inventing currency comparability would
make a deterministic result misleading.

The [application orchestrator](../packages/application/src/use-cases/evaluate-opportunity.ts)
retrieves at most ten evidence results with a bounded 1000-character search query,
prioritizing required skills over preferred ones. Truncated/omitted terms or a
continuation flag mark evidence_retrieval_incomplete. Partial retrieval is not
proof that no supporting evidence exists. The trade-off is a transparent,
repeatable heuristic, not semantic similarity or independent professional
judgment. No evaluation is persisted, and no LLM/embedding service is called.

### An idempotent, audited agent-facing mutation

[CreateProjectNote](../packages/application/src/use-cases/create-project-note.ts)
authorizes the caller and forwards trusted scope into a single transaction port.
The [PostgreSQL adapter](../packages/infrastructure/src/postgres/project-note-creation-repository.ts)
checks the project, inserts with a tenant/author/key unique constraint, and inserts
the audit before commit. Concurrent losers wait on the unique index, then read
the committed winner in a separate READ COMMITTED statement. Exact matching
project/category/content returns the original result; changed payload conflicts.

This avoids update privileges and a non-atomic audit service. A retry adds no
second audit and keeps the original note timestamp; its response has a new
invocation ID. Operational logs and audit metadata exclude note content and keys.
The trade-off is a client responsibility: retain the original key and exact
payload. Exactly-once delivery is not claimed. A connection failure near COMMIT,
output-schema failure or disconnect can leave a committed result unseen.

### Migration serialization and verified restoration

The [migration executor](../packages/database/src/migrate.ts) uses dedicated
administrator configuration and one physical PostgreSQL session holding a
session advisory lock through exact ledger preflight, Drizzle execution and
postflight. Timeouts and cleanup are bounded; historical SQL is not regenerated
or repaired automatically. The cooperative lock prevents competing reviewed
executors, not arbitrary administrator DDL. Startup never migrates.

[Recovery](../packages/database/src/recovery.ts) uses PostgreSQL 18 tools and an
exported snapshot to bind a custom dump to complete table digests and reviewed
schema/ledger. It validates the full archive, then drills restoration only into
generated disposable targets, comparing data, schema, ledger and runtime
readiness. Identity checks constrain target retirement. No existing production
database is replaced. CLI drills do not themselves run every MCP tool; tests
use the bounded verification callback for application checks.

A concrete lesson came from the archive regression: listing a dump TOC is not
full payload verification, while removing a small trailing suffix need not damage
required data. Full traversal plus a real restored-data comparison provides
stronger evidence. A checksum in mutable metadata still is not authenticity;
protected artifacts, encryption, scheduling and recovery objectives remain
operator responsibilities. See the [recovery runbook](recovery.md).

### Bounded stdio lifecycle and packaging

The direct Node launcher preserves protocol-only stdout and sends JSON logs to
stderr. Eight application slots, response time/size bounds and no queue limit
admitted work. A timeout does not cancel a write; capacity remains held until
execution settles. One idempotent shutdown path stops admission, drains for up to
ten seconds, attempts transport/pool cleanup independently and bounds total
shutdown to fifteen seconds. EOF, signals and fatal database errors share that
path. Uncatchable termination and a blocked event loop limit graceful guarantees.

The [multi-stage image](../Dockerfile) uses locked production workspace installs,
compiled artifacts, original migrations and direct Node execution as nonroot.
The [supported container launch](local-stdio-container.md) requires a read-only
root, capability dropping, no-new-privileges and runtime-only secrets. Packaging
preserves verified PostgreSQL TLS and readiness; it does not make environment
identity independently authenticated or an image vulnerability-free.

## Verification

Baseline evidence is tied to main commit
[2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7](https://github.com/belovedjohndev/beloveddev-mcp/commit/2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7).
[Linux CI run 40309126177](https://github.com/belovedjohndev/beloveddev-mcp/actions/runs/40309126177)
completed successfully on 2026-10-26. Its logs and job metadata were checked on
2026-10-28; these are reused baseline results, not new M9 PostgreSQL executions:

| Baseline check                                       | Recorded result                       | Scope                                                                                                 |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| verify:all unit/application/contract/bootstrap phase | 459 tests passed in 20 files          | Includes formatting, lint, production/test types and build                                            |
| Real PostgreSQL phase                                | 444 tests passed in 18 files on Linux | Actual constraints, scoped reads, writes/audit, concurrency, stdio, readiness, migration and recovery |
| Migration generation                                 | No schema changes; drift step passed  | Exact committed migration artifact baseline                                                           |
| Separate container-smoke job                         | Passed                                | Source-only packaged local-stdio build and runtime checks                                             |

The [CI definition](../.github/workflows/ci.yml) verifies these paths; it does not
include the unmerged M8-G scanner jobs. Repository test sources show the intended
coverage without implying exhaustive security assurance:

- [Application tests](../packages/application/test) and [domain tests](../packages/domain/test).
- [Repository integration](../packages/infrastructure/test) and [SDK contracts](../packages/mcp/test/server.test.ts).
- [Real PostgreSQL stdio](../packages/mcp/test/stdio.integration.test.ts), including note retries and disconnects.
- [Migration integration](../packages/database/test/migrate.integration.test.ts) and [recovery integration](../packages/mcp/test/recovery.integration.test.ts).
- [Deterministic lifecycle tests](../apps/mcp-server/test/lifecycle.test.ts) and [container smoke implementation](../scripts/container-smoke.ts).

<!-- m9-verification -->

Original M9-A verification on 2026-10-28 used Node v24.12.0/npm 11.6.2 on Windows:

| Newly executed M9-A check                  | Result / qualification                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct M9 worktree format:check and verify | Exit 1 at formatting: core.autocrlf=true materialized 129 untouched baseline files as CRLF while policy requires LF. No application source was reformatted to hide the result.            |
| Isolated Git-LF snapshot format:check      | Exit 0 with the unchanged Prettier policy                                                                                                                                                 |
| Isolated Git-LF snapshot verify            | Exit 0: formatting, lint, typecheck/build and 459 tests in 20 files; no stderr                                                                                                            |
| Documentation examples                     | All 16 request/response objects checked against actual strict schemas; eight example results generated through real application use cases with synthetic in-memory repositories           |
| SDK example contract check                 | Eight tools discovered/called; read/write annotations and dual success representations matched; tenant-selector inputs rejected before execution; safe application error envelope checked |
| Documentation references                   | 119 local links/anchors and five external URLs checked, script names and exact launcher validated                                                                                         |
| Diagrams                                   | Six architecture diagrams plus README overview reviewed against source; rendered Mermaid output was not tested                                                                            |

The isolated snapshot uses the exact baseline Git blobs plus the six edited
documents. Every one of its 156 other tracked files was checked against its Git
blob ID; migration SQL/metadata bytes remain unchanged. Per-command Git archive
configuration disables Windows checkout conversion only in that scratch copy.
The original/M8-G/M8-H worktrees and M9 application files are preserved. Final
formatting/diff/source-preservation checks accompany the review report. These
historical LF-snapshot passes did not establish that a normal Windows Git checkout
would pass. The final source-review repair below addresses that checkout defect;
the original failure and snapshot results remain recorded rather than relabeled.
No M9 PostgreSQL/container rerun or fresh image scan is claimed.

### Final Windows checkout portability repair

The narrowly scoped .gitattributes rules now request text eol=lf for the supported
source/document formats and named root configuration/build inputs. The final
/packages/database/migrations/** -text rule remains unchanged and overrides text
conversion for every original SQL, journal and snapshot artifact. No application
code, migration bytes, Prettier configuration or system/global Git settings change.

A fresh isolated Windows Git checkout with core.autocrlf=true tests the proposed
attributes and all six M9 documents together. It is a real Git index/checkout,
not the earlier LF archive or a manual source-normalization pass. No commit is
created. Existing worktrees are not refreshed or overwritten. See the
[checkout instructions](../README.md#windows-checkout-line-endings).

<!-- m9-portability-verification -->

**Final fixed-checkout result (2026-10-28): passed** on Windows with Git
2.52.0.windows.1, Node v24.12.0 and npm 11.6.2.

| Newly executed portability check             | Result                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Windows Git settings                  | core.autocrlf=true; no core.eol override and no disabled system-wide conversion                                                                              |
| Fresh checkout LF policy                     | All 148 policy-covered source/document/configuration files contain LF, not CRLF                                                                              |
| Original migration artifacts                 | All 11 SQL/journal/snapshot SHA-256 hashes match original baseline 2e56b7a exactly in both M9 and the fresh checkout                                         |
| npm ci                                       | Exit 0 using the unchanged lockfile                                                                                                                          |
| npm run format:check                         | Exit 0 in the fresh Git checkout with the original Prettier LF policy                                                                                        |
| npm run verify                               | Exit 0: formatting, lint, strict types/build and 459 tests in 20 files                                                                                       |
| Checkout/source integrity after verification | All 162 tracked checkout files retain their initial hashes; no unstaged changes; only the six M9 documents and attributes policy are staged against baseline |
| git diff --check                             | Exit 0 in M9; the temporary checkout's staged diff check also passes                                                                                         |

The original worktrees, their existing changes, all migration bytes and the other
four M9 document files are preserved. Only .gitattributes, README checkout guidance
and this verification section change in the portability repair. The temporary
repository uses an index/tree for the uncommitted review candidate; HEAD remains
the original baseline and no commit is created. The final verification prose is
recorded after the suite, with scoped documentation formatting/diff checks.

No schema or executable behavior changes, migration generation, PostgreSQL or
container rerun, M8-G import, Docker-resource deletion, commit or push occurs.
Existing dirty checkouts are intentionally not rewritten: use a fresh checkout
of the reviewed revision containing the policy, as the README explains. The
attributes fix checkout portability; it does not resolve the separate security
or production-readiness limitations below.

A fresh baseline dependency audit on 2026-10-28 reports two High package findings;
passing functional CI does not resolve them. Unresolved release-image findings
are documented in separate draft PR #2. No production deployment, live user test,
performance/load benchmark, restore SLA, zero-vulnerability result or business
impact measurement is claimed. See [security](security.md).

## Lessons learned

- A tool schema is only one boundary: trusted identity, authorization, SQL scope
  and database constraints each protect a different invariant.
- An error response is not evidence a mutation did not commit. Retry design must
  include audit identity and transport uncertainty from the beginning.
- Deterministic scoring should expose missing signals and retrieval limits rather
  than manufacture confidence from incomplete evidence.
- Administrative migration/recovery access must stay separate from runtime
  credentials; a cleanup failure or unknown commit outcome remains a failure.
- Functional runtime success and a clean security release gate are independent
  claims. Smaller images and absent symbols alone cannot clear native findings.
- Evidence needs a commit, platform and execution scope. Historical CI cannot be
  presented as a fresh verification of different source or artifacts.

## Limitations and future work

Resolve security maintenance through [draft PR #2](https://github.com/belovedjohndev/beloveddev-mcp/pull/2)
and review the final supported artifact before promotion. Define the intended
local deployment/trust model and operational responsibilities. Remote transport
and independent authentication need a requirement and separate design; HTTP/OAuth
are not prerequisites invented for this portfolio milestone.

Further decisions include transport/input resource limits, secrets/update
ownership, monitoring, protected off-site backups and approved RPO/RTO/cutover.
No RLS, HA/PITR, onboarding/import UI, job-site synchronization, proposal submission,
calendar/email integration, vector search, background worker or additional write
tool is implemented. Those exclusions keep the engineering account reviewable.
The [implementation plan](implementation-plan.md) tracks scope without declaring
Milestone 8 complete.
