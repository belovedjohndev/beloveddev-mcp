# M9-C2B2A: durable replay protection specification

Status: proposed design for source review. This document does not implement a store, create a migration, authorize a model request, or establish live readiness.

## Scope and inspected baseline

The inspected worktree is `BelovedDev-MCP-M9`, branch `feat/m9-c2b2a-durable-replay`. HEAD and the locally available `origin/main` both resolve to `fbfcd67a5b3a49a4507a53a92922ee9fe4d1ebdb`, which includes the M9-C2B1V merge. The worktree was clean before this document. No remote-ref refresh is asserted.

This proposal concerns the offline evaluation control plane. Preserve all eight MCP contracts, the seven-tool read-only gateway, application authorization/transactions, synthetic-fixture provenance, request serialization, model restrictions, token/cost ceilings and historical reports. No automatic retries or invocation resumption are introduced. Existing `CI`/`GITHUB_ACTIONS` live-execution rejection remains mandatory; an environment switch never grants authority. This first pass changes only this specification.

Inspected sources include `provider-live-approval.ts`, `provider-wire-contract.ts`, `openai-provider.ts`, `openai-network-transport.ts`, `provider-budget.ts`, `agent-evaluation.ts`, `evaluation-fixture.ts`, `approved-test-cluster.ts`, provider readiness/fixture tests and reporting, database schema/migration/connection/readiness policies, project-note transaction/concurrency tests, and the normal two-worker integration configuration. Unqualified provider/evaluation filenames below are under `packages/mcp/test/`.

## Current replay and identity controls

| Source / control                                                       | Protection and limitation                                                                                                                                       | Durable responsibility                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider-live-approval.ts`: `issuedApprovals`                         | One process-local set contains both approval IDs and invocation IDs. Signature, fixture and freshness checks precede insertion. A new process has an empty set. | Atomically consume both identifiers in one persistent global namespace before returning a grant.                                                                |
| Same file: grants WeakMap, `executionStarted`, `revoked`               | Opaque provenance, exact fixture/budget ownership, one execution and local revocation; lost at process exit.                                                    | Persist admission, exclusive ownership, start and closure; retain opaque-object and local checks.                                                               |
| `agent-evaluation.ts`: private lease / turns WeakMap                   | Runner-only turns bind exact adapter, model, invocation, fixture, request, transcript and tools. Stages: issued, claimed, prepared, dispatched, completed.      | Persist turn identity and forward-only claim/prepare/consume transitions. A row never mints a replacement lease.                                                |
| `provider-live-approval.ts`: permits WeakMap / `used`                  | Exact grant, turn, reservation and raw-body digest; once-only locally. No persistent permit ID exists.                                                          | Internal permit ID, atomically consumed with exact bindings before native HTTPS dispatch.                                                                       |
| `provider-budget.ts`: reservations WeakMap / settlement closure        | Once-only claim/settlement; calls, worst-case tokens and cost permanently reserved. Unknown usage halts execution. Counters are local.                          | Retain local checks; bind one reservation ID to one persisted turn/permit and enforce admitted call ceiling. Never rebuild a budget for an admitted invocation. |
| `evaluation-fixture.ts`: fixture WeakMap / claimed / closed            | Trusted setup only, one canonical scenario claim, immutable snapshot check. Cleanup drops its disposable database.                                              | Retain provenance; bind admission to manifest/scenario set. Replay records must live outside the disposable database.                                           |
| Provider/transport active, failed, closing state and transport WeakMap | Concrete transport identity, bounded single-flight operation, terminal failures and memoized cleanup.                                                           | Retain; guard pending asynchronous durable checks before awaiting storage.                                                                                      |
| Approved test-cluster / compatible-estimator object provenance         | Trusted infrastructure/tokenizer identity, not reusable execution authority.                                                                                    | Keep local. No durable nonce needed for a cluster marker, estimator or cleanup promise.                                                                         |

The existing shared set rejects cross-role collisions: an approval ID cannot later be another invocation's ID. Equal approval/invocation IDs within the same initial admission are allowed. Preserve both behaviors; two separate unique indexes alone would lose the cross-role protection.

Existing signatures bind canonical schema-parsed approval bytes, invocation, model, pricing/budgets, owner fingerprint, manifest, scenario-set digest and the exact one-scenario inventory. `syntheticDataOnly=true` is not provenance. Opaque-fixture/snapshot verification remains mandatory. A fresh fixture has different generated database/resource identities; restart cannot legitimately recreate an old approved fixture.

Current digest encodings differ: the runner hashes `JSON.stringify(serializedBodyString)`; the HTTP permit hashes raw UTF-8 bytes of that string. Preserve both explicitly. Do not silently change approval signing bytes, request serialization or either digest algorithm.

## Threat model and trust boundary

Prevent a valid signed approval from admitting more than one execution across workers/restarts. Prevent identifier reuse, duplicate turn claims, reused permits and different request bytes under an existing permit. Include concurrent submissions, termination, uncertain commit outcomes, stale objects, expired signatures and unavailable storage.

Trusted: operator, OS account, launcher, externally trusted owner public key, fixture issuer, evaluator code, PostgreSQL administrator and durable storage. Untrusted: model output, MCP arguments, signed-document transport, scheduling and network outcomes. A signature authenticates approved bindings, not unused status.

Opaque objects constrain supported harness callers; they do not sandbox malicious code in the same process. Arbitrary SQL access, administrator/OS compromise, signing-key theft, ledger replacement and stale restores remain separate risks. Hashes and brands do not solve those threats.

## Storage and migration boundary

Use a persistent PostgreSQL 18 evaluator-control database separate from synthetic fixtures and the application database. Schema: `evaluation_replay`. All evaluator workers share one approved ledger identity on the same writable primary. Per-worker databases, read replicas, silently recreated empty ledgers and in-memory fallback are forbidden.

Do not append to `packages/database/migrations/`. The production migrator verifies an exact ordered ledger; readiness fingerprints application tables; runtime privilege checks reject unrelated grants. Adding evaluator tables there would require unrelated production changes. Preserve all eleven existing SQL/journal/snapshot artifacts byte for byte.

Proposed additions, not created now:

```text
packages/database/
  evaluation-replay.drizzle.config.ts
  evaluation-replay-migrations/
    0000_durable_replay.sql
    meta/
      0000_snapshot.json
      _journal.json
  src/
    evaluation-replay.ts
    evaluation-replay-postgres.ts
    evaluation-replay-schema.ts
    evaluation-replay-migrate.ts
scripts/
  migrate-evaluation-replay.ts
```

The typed store operations belong in `evaluation-replay.ts`; the PostgreSQL adapter owns transactions and connection resources. Evaluation orchestration depends on this narrow boundary without introducing replay concepts into application/domain use cases. Reuse installed PostgreSQL/Drizzle/Zod dependencies and connection-policy mechanics; no new package or general capability framework.

Migrations are explicit administrative operations, never startup behavior. Use a separate evaluator migration URL/CA, without application, fixture or runtime credential fallback. Pin the directory. Follow the current migrator's dedicated-session, bounded advisory-lock, atomic-DDL, exact ledger hash/order, interruption and cleanup guarantees. Use an independent `evaluation_replay_migrations` ledger schema; proposed advisory lock `[0x42444556, 2]`.

Provisioning records trusted cluster system identifier, database OID and operator-installed ledger marker outside model/approval input. Runtime checks these, exact schema/migration version and effective privileges. Missing/mismatched identity is failure, never permission to initialize another store. Integration tests provision only isolated, explicitly owned control databases.

Use logged tables on durable storage. Require `fsync=on`, `full_page_writes=on` and `synchronous_commit=on`; force synchronous commit in claims and verify settings. An acknowledged commit is the authorization boundary. PostgreSQL explains the asynchronous-commit trade-off in its [WAL guidance](https://www.postgresql.org/docs/18/wal-async-commit.html). This does not guarantee survival of lost storage, stale recovery or failover missing acknowledged WAL.

## Proposed schema and constraints

Use UUIDs, `timestamptz`, checked lowercase 64-character SHA-256 hex digests, bounded text, integer token/call counts and bigint micro-USD values. Store no signed documents, signatures, keys, prompts, tool payloads, model responses or URLs. This global authorization ledger is not tenant business data; MCP exposes no ledger operation or model-selected tenant/key access.

### `evaluation_replay.invocations`

| Columns                                                                                                                  | Constraints / meaning                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocation_id`, `approval_id`, `execution_id`                                                                           | Invocation UUID primary key; unique approval and unique internally generated execution UUID. Unique `(invocation_id, execution_id)` for child ownership references.               |
| `approval_digest`, `owner_key_fingerprint`                                                                               | Required digest checks. Approval digest hashes unchanged `approvalSigningBytes()` output.                                                                                         |
| `fixture_manifest_digest`, `scenario_set_digest`, `scenario_id`                                                          | Exact approved binding. Scenario ID restricted to existing canonical inventory; one scenario per approval. Reconstruct exact singleton inventory `[scenario_id]`; never widen it. |
| `model`, `compatibility_profile`, `plan_digest`                                                                          | Required bounded literals matching configured snapshot/profile; validated-plan digest with versioned encoding. No model substitution.                                             |
| `issued_at`, `expires_at`, `pricing_verified_at`, `admitted_at`                                                          | Required; expiry after issue by at most 15 minutes; pricing not after issue; database-time admission before expiry. Transitions recheck freshness.                                |
| `max_calls`, `max_input_tokens_per_call`, `max_output_tokens_per_call`, `max_total_tokens`, `max_planned_cost_micro_usd` | Positive and within current schema limits. Retain signed worst-case plan arithmetic and existing scenario limits. No budget increase or refund.                                   |
| `status`, `started_at`, `closed_at`, `outcome`, `last_turn_number`                                                       | Status `admitted`, `running`, `closed`; allowlisted outcome only at closure; consistent timestamps. Last turn starts at zero, never decreases or exceeds call ceiling.            |

### `evaluation_replay.identifiers`

`identifier uuid PRIMARY KEY`, `invocation_id uuid NOT NULL REFERENCES invocations(invocation_id) ON DELETE RESTRICT`. In the admission transaction, insert the sorted deduplicated set of approval/invocation IDs. Both keys must belong to this invocation. Equality within one admission needs one key row; an existing key rejects a new admission even if its role differs. These rows and the invocation are permanent replay tombstones.

### `evaluation_replay.turns`

| Columns                                                                                      | Constraints / meaning                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocation_id`, `execution_id`, `turn_number`, `turn_id`                                    | Primary key `(invocation_id, turn_number)`; unique internal turn UUID; composite ownership foreign key, delete restricted. Positive consecutive number under parent lock.                                        |
| `request_digest`, `transcript_digest`, `tool_digest`, `runner_body_digest`, `digest_version` | Immutable, non-null exact frozen bindings using current algorithms and fixed encoding version.                                                                                                                   |
| `stage`, `issued_at`, `claimed_at`, `prepared_at`, `consumed_at`, `retired_at`               | Stage `issued`, `claimed`, `prepared`, `consumed`, with forward-only transitions/timestamp consistency. Independent retirement prevents further dispatch, even before consumption, and never erases consumption. |
| `permit_id`, `reservation_id`, `raw_body_digest`, `output_cap`                               | Null before preparation, populated together once at preparation; unique internal permit/reservation UUIDs. Exact body and approved/request output cap. Immutable after preparation.                              |

One permit per turn makes a separate permit table unnecessary. Consumption records permission to attempt exact dispatch, not proof of provider receipt, response delivery or billing. Completion must not erase that distinction.

Constraints enforce identity uniqueness, foreign keys, bounds and row-local state consistency. Column grants and narrow transition triggers prevent binding edits, clearing consumption/retirement, reopening closure and backward stages. Cross-row sequence/budget/freshness checks occur under parent locks, not SQL CHECK constraints. An expiry index may support inspection; never use expiration-dependent uniqueness.

## Atomic operations and transaction semantics

All authorization-changing operations use one physical connection and explicit READ COMMITTED transactions. Lock invocation first, then turn. Verify exclusive execution ID, immutable bindings, active status, retirement and freshness as applicable. No HTTP or credential resolution inside transactions. Cancellation, SQL errors, wrong row counts, timeout and unknown commit acknowledgements fail closed.

1. **Admit:** retain strict parse, Ed25519 verification, trusted key, pricing/model/budget, opaque-fixture binding and local freshness checks first. Insert invocation and sorted identifier keys atomically with uniqueness arbitration. Require every expected insertion; even identical conflicts reject. Recheck expiry before commit. Return a new opaque grant only after acknowledged commit; never return an old grant on conflict.
2. **Start:** atomically change `admitted` to `running`, with previously null start time and exact owner/fixture/scenario. Require one row and acknowledged commit before synthetic scenario claim or lease creation. Persisted identifiers cannot reconstruct a lease in a new process.
3. **Issue and claim turn:** private runner locks parent, checks prior turn retirement, consecutive number and `min(signed maxCalls, existing maxTurns)`, then inserts immutable digests. Return opaque turn after commit. Provider claim conditionally changes `issued -> claimed` for the exact model/request/transcript/catalog and owner; commit before credential access.
4. **Prepare:** retain local worst-case budget reservation and reservation-object claim. Bind internal reservation/permit IDs, both body hashes and output cap in `claimed -> prepared`. Return permit only after commit and renewed local grant check. Storage failure halts the invocation; do not refund or replace reserved budget.
5. **Consume before dispatch:** native transport retains endpoint/header/body/provenance checks. Atomically change matching `prepared` turn to `consumed`, matching permit, reservation, owner and both body bindings. Require exactly one row and acknowledged synchronous commit before native HTTPS request creation/sending. Recheck local revocation, abort and expiry after awaiting storage. Newly invalid state burns permission without sending; no alternate dispatch or retry.
6. **Retire and close:** retire attempted turns regardless of outcome. Disable lease before independent bounded model/transport, gateway and fixture cleanup. Persist terminal outcome after those attempts while the store is available, then close store resources independently. Always revoke locally in `finally`, including failed persistence or cleanup. Failure never reverses committed admission/consumption; report it and exit nonzero.

Use conditional writes with `RETURNING` and uniqueness arbitration, not check-then-insert. `ON CONFLICT DO NOTHING` is acceptable only if missing returned rows mean rejection. Follow PostgreSQL [INSERT semantics](https://www.postgresql.org/docs/18/sql-insert.html) and [READ COMMITTED concurrency behavior](https://www.postgresql.org/docs/18/transaction-iso.html). Unlike project-note idempotency, replay conflicts must not return prior authorization as success.

Use `clock_timestamp()` after locking and before authorizing commit, not transaction-start `now()`: lock wait must not freeze freshness. Retain local wall-clock, monotonic lifetime, pricing-age and configured shutdown checks. See PostgreSQL's [time functions](https://www.postgresql.org/docs/18/functions-datetime.html). Commit and network delivery cannot be one atomic event; check expiry/revocation again immediately before dispatch.

Proposed limits: pool maximum two connections per worker; connect, acquire, statement, transaction and cleanup each at most 5,000 ms; lock wait at most 1,000 ms. These are ceilings, not additional allowances: each operation also uses the remaining existing scenario/model deadline and approval lifetime. Cancel safely and release/destroy owned connections. No timeout increase, unbounded queue, reconnect-and-retry or extra live turn. Boundary values and cancellation need offline tests before acceptance.

Current gate functions are synchronous. Await every new durable gate before credentials/network work. Reserve local pending/single-flight state before the first await, otherwise two calls could pass the transport active-map check. Claim local capability state before I/O and make failed/uncertain attempts terminal; an await failure must not reopen a stage. Preserve concrete transport brands and strict schemas.

## Lifecycle, restart and failure semantics

Approval consumption occurs at admission, not successful provider response. One owner may run its one approved scenario through bounded turns while fresh. It cannot transfer ownership, resume an abandoned invocation, replace its budget or export authority. Execution IDs are ownership/correlation bindings, not bearer credentials replacing opaque capabilities.

After restart require a newly approved invocation, approval ID and trusted fixture. Never adopt abandoned `admitted` or `running` rows. No stale-worker lease releases identifiers. This trades automatic recovery for single-use safety.

| Event                                                  | Required behavior                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate nonce, invocation ID or cross-role collision | Reject admission, roll back new rows, no grant; never alter original winner.                                                                                                                              |
| Concurrent identical approvals                         | At most one committed winner; others reject without credential access/dispatch.                                                                                                                           |
| Wrong invocation/model/plan/fixture/scenario           | Reject before admission when found there; later mismatch stops owner. Never substitute broader prompts or clients.                                                                                        |
| Replayed turn/permit                                   | Failed provenance or zero-row conditional transition rejects without dispatch, including restart.                                                                                                         |
| Different bytes with existing permit                   | Exact raw-body and runner-body checks reject; no replacement permit.                                                                                                                                      |
| Expired, future-issued, malformed, invalid signature   | Preserve safe rejection; no grant. Expiry and cleanup cannot restore validity.                                                                                                                            |
| Unavailable store, wrong identity/schema/privileges    | Fail before grant/credentials or halt before next dispatch. No in-memory fallback.                                                                                                                        |
| Lock/statement/transaction timeout or cancellation     | Abort and stop owner; no retry, refund, inferred success or uncertain dispatch.                                                                                                                           |
| Definite rollback                                      | No new transition accepted. Prior committed admission remains consumed; local failed capability retires. Initial admission rolled back before grant has no durable consumption and no network permission. |
| Lost COMMIT acknowledgement                            | Treat unknown as failure; no grant/permit/dispatch from that attempt. Row may have committed. Do not retry into success.                                                                                  |
| Kill before admission commit                           | Incomplete transaction rolls back; no grant/external work authorized. Another contender may admit an approval that was never committed.                                                                   |
| Kill after admission/consumption commit                | Records survive ordinary restart. Admission stays burned; permit cannot be resent even if no bytes were delivered.                                                                                        |
| Response loss/timeout after dispatch                   | Delivery/billing may be unknown. Preserve unknown-usage halt, consumed reservation and no retry.                                                                                                          |
| Cleanup or closure-write failure                       | Independently attempt remaining cleanup, revoke locally, retain records, report failed run. Never reopen authority.                                                                                       |

Guarantee: at most one committed admission for either identifier and one committed permission to attempt dispatch per turn/permit through the supported harness. Not exactly-once HTTP delivery. An initial attempt that never committed cannot be remembered durably by that rolled-back transaction; do not claim otherwise or silently treat another attempt's acceptance as its success.

## Expiration, retention, key rotation and recovery

Expiry stops execution without releasing uniqueness. Retain invocation, identifier and turn records indefinitely in this slice, including failed/expired/unknown entries. No runtime DELETE/TRUNCATE, purge command or periodic deletion. Test that cleanup retains both expired and unexpired tombstones. Later retention requires owner review and permanent identifier tombstones; deleting expired approvals would permit ID reuse in a newly signed document.

Keep signing keys external; store public-key fingerprint only. Rotation must not partition/reset replay identifiers. A new key cannot reuse an old nonce. No multi-key acceptance window, trust-epoch reset or signature-format change here. Emergency key withdrawal requires stopping/fencing active workers as well as replacing trusted configuration: existing grants do not continuously reload it.

Empty replacement, stale backup/PITR, lost acknowledged WAL and split-brain writers can defeat history. Before cutover/recovery, stop workers and block admission until an operator establishes continuity or invalidates affected approvals and fences old owners/keys. Cluster/OID/marker checks detect accidental replacement, not every same-identity restore. Recovery with data-loss RPO remains an owner decision, not an automatically safe feature.

## Privileges, audit and reporting

Separate control-database ownership/migration credentials from runtime. Runtime is not superuser, owner or privileged-role member and has no CREATE, DELETE, TRUNCATE, role-management or application-table access. Grant only CONNECT, schema USAGE, SELECT/INSERT and necessary UPDATE columns on these tables, plus SELECT on evaluator migration ledger. Revoke PUBLIC creation/unrelated access; check inherited/effective privileges. Application runtime receives no control-table access; do not change its grants or RLS policy.

Reuse verified TLS policy for remote storage, without URL overrides, disabled certificate checks or credential fallback. Trusted operator configuration selects storage. Store no payloads/secrets. Digests are correlation metadata, still restricted. Immutable bindings, monotonic timestamps and terminal outcome are the minimum control audit; do not use tenant project-note audit tables. Failed duplicate reports contain allowlisted classifications, not original winner data. No new event service is necessary; malicious administrators remain outside the guarantee.

Keep offline control status, token preflight and live readiness separate. A future report version may add allowlisted replay status (`passed`, `failed`, `unverified`) and availability/uncertainty counts; passing does not authorize live execution. Preserve historical files/schema interpretation. Public reports contain counts/status only; IDs/digests needed for audit remain in the private ledger. No SQL messages, URLs, environment dictionaries or provider secrets. Unknown commit/cleanup failure means failed run/nonzero exit.

Configured model/profile/shutdown restrictions and 4,096-token ceiling remain unchanged. The documented 13,013-versus-4,096 mismatch stays blocked. Active-model selection, budgets/pricing/provisioning, live compatibility and separate owner permission remain prerequisites. This specification does not remove `durable_atomic_replay_store` from readiness blockers.

## Regression and integration test plan

Offline unit tests can inject a deterministic store to prove orchestration ordering and safe mapping; they cannot establish database atomicity/persistence. Intercept credentials and native HTTP; unexpected provider egress fails the test. Use real PostgreSQL, uniquely named disposable control databases on the explicitly trusted test cluster, and retain each ledger across child-worker lifetimes. Only identity-checked test-owned resources may be dropped during cleanup.

The existing `createTestDatabase` always applies application migrations. Do not change that behavior or use it as the control schema migrator. A narrowly scoped evaluator-control test fixture must use the separate stream, following existing identity-checked create/drop ownership patterns and reusing independent cleanup helpers. It must not grant authority to arbitrary caller-selected databases or touch original resources.

| Test                                       | Independent observation                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sequential/concurrent admission            | Exactly one committed admission, correct identifier rows, zero grant/credential/dispatch for losers. Include cross-role collisions and equality within one initial admission.                                            |
| Two independent Node processes             | Barrier-start against one ledger; exactly one winner in persisted SQL state, bounded safe exit classifications. No shared JS set or mocked SQL establishes the result.                                                   |
| Restart/termination                        | Admit in A, exit/kill after acknowledged commit, reject in fresh B. Cover admitted-but-unstarted and consumed-before-dispatch states; new fixture cannot bypass identifiers.                                             |
| Turn/permit replay                         | Independent connections race the same transition: one updated row, at most one mocked dispatch. Reject stale/retired stages, wrong owners, second permits and closed invocations.                                        |
| Permit/body mismatch                       | Alter exact bytes, output cap, transcript/catalog or model; no native request. Exercise both body hashes and digest-version rejection.                                                                                   |
| Invocation/model/fixture/scenario mismatch | Tampered approval fails before store write; wrong later binding fails before credentials/network. Keep existing signature and opaque-fixture regressions.                                                                |
| Rollback                                   | Inject errors between invocation/key inserts and transition/commit; independent connection sees no partial state. Committed admission stays burned and failed local capability cannot continue.                          |
| Unknown commit acknowledgement             | Fault an owned proxy/session after server-side commit but before acknowledgement. Client fails closed; independent observer confirms consumption and fresh worker rejects. A mock promise alone cannot prove durability. |
| Unavailability/timeouts                    | Closed endpoint, killed owned backend, held row lock and transaction timeout fail within existing outer deadlines; no retry/dispatch; cleanup still attempted.                                                           |
| Expiry/lock wait                           | Invalid signature, future issue, expiry, pricing age and model lifetime remain rejected. Hold lock across expiry; database wall time rejects after release.                                                              |
| Async race/revocation                      | Same-transport calls during awaited consumption: local pending guard plus SQL admit at most one. Abort/revoke during await prevents later dispatch.                                                                      |
| Cleanup/retention                          | Independent model/gateway/fixture/store cleanup despite failures; grant always revoked; no expired/unexpired tombstone deletion. Preserve assertion and cleanup errors together.                                         |
| Migrations/identity/privileges             | New control stream fresh/repeat apply, exact ledger, missing constraint/tampering, wrong database and insufficient/excessive runtime privileges. No application/control cross-access.                                    |
| Budget/reports                             | No reservation refund/fresh-budget resumption; call/token/cost limits unchanged. Safe reports distinguish offline success, blocked live readiness and uncertain consumption.                                             |
| Rotation/recovery                          | New trusted key cannot reuse old IDs; wrong ledger identity fails closed. Same-identity stale restore remains an operator fencing requirement, not falsely claimed detection.                                            |

Use phase barriers and SQL observations, not timing sleeps or constructor spies. Diagnostics contain allowlisted phases, counts, timings, sanitized categories and exit codes. Bound child cleanup. Never archive `.env`, credential-bearing `postgres.json`, copied checkouts or connection URLs.

Retain normal integration `maxWorkers: 2`, existing deadlines and zero retries; preserve concurrency within race tests. No blanket serialization or speculative deadline increase. Future implementation verification: focused replay/fault tests, then `npm run format:check`, `npm run verify`, `npm run db:check`, `npm run verify:all`, `npm run eval`, `npm run eval:agent`, `npm run eval:provider:test`, and `git diff --check`. Also check the separate migration stream and all eleven original hashes. All testing remains offline with zero live provider requests.

## Exact anticipated implementation files

Only this document is changed now. This is the proposed later file set for review, not permission to implement:

| Files                                                                                                                                                        | Responsibility                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `docs/m9-c2b2a-durable-replay-spec.md`                                                                                                                       | Reviewed choices and later verification evidence.                                                                    |
| `packages/database/src/evaluation-replay.ts`                                                                                                                 | Typed bounded store operations and safe outcomes; no business rules.                                                 |
| `packages/database/src/evaluation-replay-postgres.ts`                                                                                                        | Identity/TLS/privilege-checked adapter, atomic transitions, deadlines and cleanup; reuse internal connection policy. |
| `packages/database/src/evaluation-replay-schema.ts`                                                                                                          | Separate Drizzle schema/constraints for three tables.                                                                |
| `packages/database/src/evaluation-replay-migrate.ts`                                                                                                         | Fixed separate directory and administrative migration policy/ledger.                                                 |
| `packages/database/evaluation-replay.drizzle.config.ts`                                                                                                      | Separate schema/output paths.                                                                                        |
| `packages/database/evaluation-replay-migrations/0000_durable_replay.sql`                                                                                     | Initial evaluator-only DDL/transition guards; original SQL untouched.                                                |
| `packages/database/evaluation-replay-migrations/meta/0000_snapshot.json`, `packages/database/evaluation-replay-migrations/meta/_journal.json`                | New stream metadata; validate generated output before review.                                                        |
| `packages/database/package.json`                                                                                                                             | Explicit evaluator store/migrator exports, preserving existing exports.                                              |
| `scripts/migrate-evaluation-replay.ts`, `package.json`                                                                                                       | Explicit administrative entry and separate generate/check/apply scripts; no live launcher.                           |
| `packages/mcp/test/provider-live-approval.ts`                                                                                                                | Await durable gates; retain signatures, provenance, revocation and safe rejection.                                   |
| `packages/mcp/test/agent-evaluation.ts`                                                                                                                      | Runner-only durable turn/ownership/retirement; exact binding and independent cleanup.                                |
| `packages/mcp/test/openai-provider.ts`, `packages/mcp/test/openai-network-transport.ts`                                                                      | Await gates before credentials/dispatch; pending-state guard and no retries.                                         |
| `packages/mcp/test/provider-live-readiness.test.ts`, `packages/mcp/test/openai-provider.test.ts`, `packages/mcp/test/provider-fixture.integration.test.ts`   | Preserve existing assertions; async gate, binding, revocation and cleanup regressions.                               |
| `packages/mcp/test/provider-replay.test.ts`, `packages/mcp/test/provider-replay.integration.test.ts`, `packages/mcp/test/fixtures/provider-replay-worker.ts` | Offline ordering tests, real concurrency/restart/fault coverage and controlled non-network worker.                   |
| `packages/database/test/evaluation-replay.integration.test.ts`, `packages/database/test/evaluation-replay-fixture.ts`                                        | Schema/migration/privilege/transaction tests and shared identity-checked control-database test fixture.              |
| `packages/mcp/test/provider-evaluation-report.ts`, `vitest.provider-evaluation.config.ts`                                                                    | Versioned safe control status and focused test inclusion; overall live remains blocked.                              |
| `README.md`, `docs/implementation-plan.md`                                                                                                                   | Provisioning and completed offline scope, after implementation passes.                                               |

No change anticipated to `provider-wire-contract.ts`, `provider-budget.ts`, `evaluation-fixture.ts`, original migrations/readiness, authentication, MCP registration/schemas, domain logic, normal integration scheduling, Docker resources or M8-G scanner policy. Reuse existing APIs. Justify any additional file before expanding implementation scope. No new npm library is proposed; update lockfile only if a reviewed manifest change actually requires it.

## First-pass verification

Only this specification was added. Targeted Prettier check and `git diff --check` passed; the new untracked document was also checked directly for whitespace errors. SHA-256 comparison before/after confirmed all eleven original migration artifacts unchanged. HEAD remained unchanged and Git reported no tracked-file modifications.

Application, PostgreSQL and container suites were not run for this documentation-only pass. The tests above are acceptance requirements for the later implementation, not claimed passing replay controls. No migration generation/apply, database provisioning, Docker operation, live provider request, commit or push was performed.

## Decisions requiring review and remaining risks

Approve before implementation:

1. Persistent separate evaluator-control database, owner/runtime roles, trusted identity configuration and migration stream.
2. Admission consuming both IDs permanently, shared cross-role namespace, no resume/takeover and no automatic retries.
3. Indefinite retention; any later deletion, trust-epoch reset, restore or failover needs a reviewed continuity/fencing policy.
4. Proposed bounded database operations within existing deadlines, safe failure/report categories and fault-injection mechanism.

Remaining risks: administrator/OS/key compromise, lost or rolled-back ledger, split brain, clock disagreement, revoke/expiry versus network races, unknown delivery/usage and operational provisioning. A consumed permit proves neither billing nor absence of billing. Database transactions cannot atomically commit external delivery. Implement and test this design before removing the durability blocker; it does not resolve model approval, the preserved token mismatch, owner limits, live compatibility or existing release-security blockers.

Stop after this specification. No migration, replay-store implementation, live API call, paid operation, commit or push is authorized by this document.
