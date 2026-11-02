# M9-C2B2B1: evaluator replay ledger foundation

This slice implements offline persistence only. The approved [design](m9-c2b2a-durable-replay-spec.md) remains the threat-model reference. No provider, transport, signing, model, token, MCP or application code is connected to this store. A successful store write returns no LiveGrant, turn capability or network permit. The live pipeline still uses its previous process-local controls and remains blocked pending separate integration and review.

## Storage and privileges

Use a dedicated persistent PostgreSQL 18 control database, separate from application and disposable synthetic data databases. All workers must share its authoritative writable primary. Tables are `evaluation_replay.invocations`, `identifiers` and `turns`; the independent migration ledger is `evaluation_replay_migrations.__drizzle_migrations`. Existing application migration bytes and readiness/privilege policies are unchanged.

Invocations bind approval/execution IDs, immutable approval/plan/key/fixture/scenario digests, the exact configured model/profile and signed budget bounds. The identifier primary key preserves the shared approval/invocation namespace, including one row when those IDs are equal. Turns have composite owner references, unique turn/permit/reservation IDs, immutable digests, forward-only stages and permanent retirement/consumption timestamps. Deferred coverage guards require complete identifier claims and matching turn counts at commit. Delete/truncate guards and runtime privileges prevent purging tombstones. No payload, prompt, response, credential or signature is stored.

Provision the database and runtime role through an operator-controlled process. The migrator never creates a database, installs an identity marker or runs at application startup. Before migration, the operator installs a comment of exactly `beloveddev.evaluation-replay:<UUID>` on that control database and records its OID and PostgreSQL system identifier out of band. Do not mark an arbitrary or application database as an evaluation ledger.

Administrative configuration is explicit and has no application/fixture fallback:

```text
EVALUATION_REPLAY_MIGRATION_URL
EVALUATION_REPLAY_MIGRATION_TLS_CA       # optional custom CA, required transport verification remains
EVALUATION_REPLAY_SYSTEM_IDENTIFIER
EVALUATION_REPLAY_DATABASE_OID
EVALUATION_REPLAY_MARKER
```

Keep the protected `.env.evaluation-replay-admin` used by the administrative command separate from the MCP launcher configuration and outside model inputs and reports. Never put its administrator credentials in the runtime `.env`. The command requires that file; a missing file is an error. It never prints its contents. Run from the repository root:

```sh
npm run eval:replay:generate
npm run eval:replay:check
npm run eval:replay:migrate
```

Generation uses only `evaluation-replay-schema.ts` and its separate output directory. Initial DDL includes reviewed custom trigger guards beyond Drizzle's table snapshot. Future guard changes need explicit SQL migrations and a reviewed catalog fingerprint. Regeneration of the checked-in schema must produce no changes. No command rewrites the application migration stream.

Separate migrator ownership from runtime. Example grants below use operator-created identifiers `evaluation_control` and `evaluation_replay_runtime`; adapt only through trusted provisioning. No password is supplied here:

```sql
REVOKE ALL ON DATABASE evaluation_control FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE evaluation_control TO evaluation_replay_runtime;
GRANT USAGE ON SCHEMA evaluation_replay, evaluation_replay_migrations TO evaluation_replay_runtime;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA evaluation_replay TO evaluation_replay_runtime;
GRANT SELECT ON evaluation_replay_migrations.__drizzle_migrations TO evaluation_replay_runtime;
GRANT UPDATE (status, started_at, closed_at, outcome, last_turn_number)
  ON evaluation_replay.invocations TO evaluation_replay_runtime;
GRANT UPDATE (stage, claimed_at, prepared_at, consumed_at, retired_at,
  permit_id, reservation_id, raw_body_digest, output_cap)
  ON evaluation_replay.turns TO evaluation_replay_runtime;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  evaluation_replay.guard_write(), evaluation_replay.check_coverage()
  TO evaluation_replay_runtime;
```

Runtime must be a non-owner login without privileged attributes, role memberships, grant options, schema creation, temporary-object rights, unexpected routines, table-wide UPDATE, DELETE or TRUNCATE. Effective PUBLIC, inherited, column, sequence and system-catalog privileges are checked. The narrowly granted `pg_control_system()` metadata read enables direct system-identifier verification without broad monitoring roles or a SECURITY DEFINER function. Application runtime credentials get no ledger access; evaluator credentials get no application-table rights.

Runtime construction requires an explicit URL/CA and trusted identity object; it does not read an enabling environment flag. Remote connections reuse the existing verify-full TLS/hostname policy. Startup and every operation reject an unknown cluster/OID/marker, wrong user/database, incomplete or changed migration ledger/catalog, excessive/missing privileges, read-only/recovery sessions, or `fsync`, `full_page_writes`, `synchronous_commit` settings other than `on`.

## Transactions and failure behavior

Operations are admit, start, issue, claim, prepare, consume, retire and close. Each owns one physical PostgreSQL session and a READ COMMITTED transaction. Parent locks precede turn locks. Unique insertion and conditional updates require exact affected-row counts. Admission inserts both parent and identifier keys atomically; replay is rejection, not successful idempotent reuse. No operation returns success before acknowledged synchronous commit and resource cleanup. No retries or resume/takeover exist.

Admission metadata is supplied by trusted future orchestration. The store validates its strict shape, current model/profile, lifetime, token/call bounds and all immutable bindings, but does not itself verify an owner signature or synthetic fixture provenance. Those existing checks must remain mandatory when this store is integrated later. Approval/plan digests are exact caller-provided bindings; the store does not reconstruct or reserialize signed bytes. Both current runner-body and raw-body digest forms remain distinct.

Each store allows at most two concurrent physical sessions and fails excess work closed; it does not maintain an idle pool or unbounded wait queue. This refines the proposed two-connection pool into bounded owned sessions, simplifying cleanup without changing distributed authority. Caller deadlines are absolute monotonic times. Connect/work/transaction are capped at five seconds, lock wait at one second, and cleanup at five seconds; remaining caller time can only shorten those bounds. Administrative migrations have a separate 30-second overall ceiling. Abort/error destroys only owned sockets, rolling back incomplete work.

Every transition rechecks actual database wall time after locking and before commit. Expired approvals and stale pricing cannot regain authority through retention or retry. Retire/close remain possible after expiry for cleanup. Recorded event times use the greatest of current time and preceding lifecycle times to preserve causal ordering when a wall clock steps backward. This never replaces the independent real-clock freshness check. A focused test run measured a 256,810-microsecond backward issue/claim step on the local host; the uncorrected timestamp CHECK rejected that operation safely. Host/database clock discipline remains an operational requirement.

Lost COMMIT acknowledgement is `COMMIT_UNKNOWN`, never authorization success. A committed row can remain even when the caller failed. The real fault test withholds the PostgreSQL `COMMIT` completion packet, independently observes the row and rejects replay through a fresh connection. Definite rollback leaves no partial parent/identifier/counter change. This is at-most-once committed permission, not exactly-once external delivery or billing; no provider request is made by these tests.

Store close aborts owned in-flight sessions, attempts bounded cleanup and is memoized. Test fixtures independently attempt store/pool/database/role cleanup, even when an assertion or earlier cleanup fails, preserving both failures. Only generated names with recorded database/role/owner OIDs and the expected marker may be retired. No existing database, container or volume is reused or removed.

## Verification and remaining limits

Focused coverage includes schema integrity, shared-namespace collisions/equality, SQL rollback, two-connection and two-Node-process races, restart after committed admission, exact turn/permit progression, body/owner mismatch, expiry under a held lock, database unavailability, transaction timeout, invalid identity/marker/catalog/ledger/privileges, SQL tampering, retention, migration interruption and independent cleanup.

Run the normal verification/evaluation commands plus `eval:replay:check` and a no-drift evaluator generation check. Preserve and compare all eleven original migration artifact hashes. No live provider tests are authorized. A passing offline foundation does not remove the existing live-readiness blocker.

Tombstones have indefinite retention; no operational purge API exists. Ordinary restart preserves committed claims, but lost storage, same-identity stale physical restores, split brain, missing acknowledged WAL, compromised operators/keys and clock failures require external controls and fencing. No failover or durable approval integration is supplied here. The unchanged 13,013-versus-4,096 preflight mismatch, active-model approval, budgets/pricing, account controls, live compatibility and M8-G release blockers remain separate work.

## Source-review verification record (2026-11-02)

The actual M9 checkout retains 118 pre-existing tracked CRLF files. A read-only Prettier API comparison confirmed that all 118 failures disappear with LF conversion alone; there are zero other baseline formatting failures. Those files were not rewritten. A private detached LF checkout of the same base, with every uncommitted file overlaid and workspace dependencies linked within that checkout, provided reproducible verification without modifying sibling worktrees or migration bytes.

| Check                                                        | Result                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Actual checkout `npm run format:check`                       | Exit 1: 118 existing CRLF-only failures.                                                                                                  |
| Actual checkout `npm run verify`, `npm run verify:all`       | Exit 1 at the same formatting gate. No gate was disabled.                                                                                 |
| Isolated LF `npm run format:check`                           | Passed.                                                                                                                                   |
| Isolated LF `npm run verify`                                 | Passed: 732 tests, including 18 new offline replay tests.                                                                                 |
| Isolated LF `npm run verify:all`                             | Exit 1: unit tests 732 passed; PostgreSQL tests 494 passed, one failed, three platform skips. All 30 new replay integration tests passed. |
| `npm run db:check` and application Drizzle generation        | Passed; no schema changes, all eleven original artifact hashes unchanged.                                                                 |
| `npm run eval:replay:check`, `npm run eval:replay:generate`  | Passed; separate evaluator stream has no generation drift.                                                                                |
| Actual checkout `npm run eval`                               | Passed: four deterministic workflow scenarios, including one-note/one-audit idempotency.                                                  |
| Actual checkout `npm run eval:agent`                         | Passed: six offline scenarios.                                                                                                            |
| Actual checkout `npm run eval:provider:test`                 | Passed: 156 offline controls. Live execution false; overall readiness still blocked.                                                      |
| Administrative CLI without evaluator configuration           | Exit 1, zero stdout, one structured `evaluation_replay.migration_failed` stderr event with category `VALIDATION`; no database connection. |
| `git diff --check` and direct new-artifact whitespace checks | Passed.                                                                                                                                   |

The retained full-run failure is `packages/mcp/test/stdio.integration.test.ts`: `shuts down with a safe nonzero exit when PostgreSQL kills an idle pool connection`. It hit the unchanged eight-second MCP response deadline. The unchanged test passed in an isolated diagnostic comparison (one selected test; 32 filtered out), with readiness at approximately 3,801 ms, maximum child event-loop lag 2,935 ms, the expected idle-error/stopping/stopped events and process exit 1. The full-run timeout's exact cause is unresolved; the isolated pass does not replace that failed gate or establish a concurrency/resource cause. No production lifecycle change, assertion reduction, deadline increase, scheduling change or automatic retry was introduced.

Development runs also caught and corrected missing initial schema creation, backward-clock timestamp ordering, a self-targeting test relay and strict SQL-result/cause typing. The final focused uncertain-COMMIT and concurrency/restart tests passed. A deterministic backward-clock regression also passed in the full suite. No failed full run has been relabeled successful.

PostgreSQL 18.6 native client tools were verified. All testing used one uniquely labeled task-owned PostgreSQL 18 tmpfs container. After evaluation, zero disposable databases, test roles or other client sessions remained. Only that exact ID/label-verified container was removed. All 30 original containers and 51 original volumes remain present; no volume deletion was performed. Historical evaluation reports were retained; existing reporters add uniquely named safe files.

## Exact change inventory for B1

Modified:

```text
.gitattributes
.prettierignore
README.md
docs/implementation-plan.md
package.json
packages/database/package.json
```

Added:

```text
docs/m9-c2b2b1-replay-ledger-foundation.md
packages/database/evaluation-replay.drizzle.config.ts
packages/database/evaluation-replay-migrations/0000_durable_replay.sql
packages/database/evaluation-replay-migrations/meta/0000_snapshot.json
packages/database/evaluation-replay-migrations/meta/_journal.json
packages/database/src/evaluation-replay.ts
packages/database/src/evaluation-replay-schema.ts
packages/database/src/evaluation-replay-policy.ts
packages/database/src/evaluation-replay-migrate.ts
packages/database/src/evaluation-replay-postgres.ts
packages/database/test/evaluation-replay.test.ts
packages/database/test/evaluation-replay.integration.test.ts
packages/database/test/evaluation-replay-process.integration.test.ts
packages/database/test/evaluation-replay-fixture.ts
packages/database/test/evaluation-replay-commit-proxy.ts
packages/database/test/fixtures/evaluation-replay-worker.ts
scripts/migrate-evaluation-replay.ts
```

The pre-existing untracked `docs/m9-c2b2a-durable-replay-spec.md` is preserved. No provider/transport/signing/wire, token/model, tool-contract, domain/application, original migration, lockfile, CI or M8-G implementation file changed. No live provider request, billable operation, commit or push occurred. Source review is required before integration; the complete verification gate is not green while the retained stdio failure remains unresolved.
