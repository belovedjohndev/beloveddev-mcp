# M8-H1: safe administrative migrations

## Problem and scope

The existing migration CLI uses runtime DATABASE_URL, a pool, and runtime's
10-second statement timeout. Independent executors can race. This slice adds
administrative connection policy, database serialization, bounded execution,
safe diagnostics, real PostgreSQL 18 tests, and operator recovery guidance.
Backup/restore is M8-H2; M8-H and Milestone 8 remain incomplete.

## Existing behavior inspected

Drizzle ORM 0.45.3 node-postgres/migrator reads the committed SQL bytes and hashes.
PgDialect.migrate creates drizzle and its ledger outside the transaction, reads
the latest ledger timestamp, then executes all pending SQL and ledger inserts in
one transaction. NodePgSession.transaction acquires another client when supplied
a Pool, but reuses a supplied Client. Rollback failure can mask the original error.
The five committed migrations use transactional DDL. No SQL or hashes change.

## Proposed design and invariants

- Require DATABASE_MIGRATION_URL and optional DATABASE_MIGRATION_TLS_CA; never
  fall back to runtime/test configuration. Reuse the strict M8-D URL/TLS validator
  inside a dedicated administrative policy. Explicit pg fields prevent ambient
  endpoint, credentials, SSL, and session-option overrides.
- Own one pg Client and its socket, without a pool. Verify PostgreSQL 18 and the
  explicit database/session user. Hold the deterministic two-int session advisory
  lock (0x42444556, 1), naturally scoped by PostgreSQL to the connected database.
  Feed that exact Client to Drizzle for preflight, DDL, ledger, and postflight.
- Validate an exact committed ledger prefix before running Drizzle; require the
  full ledger afterward. Reject drift, gaps, changed hashes, and future history.
  Do not repair history or automatically retry. M8-D remains the final runtime
  schema/privilege/readiness authority.
- Bound connect at 5 seconds, advisory acquisition at 10 seconds, other lock waits
  at 5 seconds, individual SQL at 120 seconds, and operation at 300 seconds.
  Administrative-only positive integer millisecond overrides cap at one hour.
  PostgreSQL enforces lock/statement/transaction timeouts. An absolute monotonic
  application deadline includes connect and execution; expiry/interruption/loss
  destroys the owned socket. Cleanup has a further fixed 5-second ceiling.
- SIGINT/SIGTERM abort execution with nonzero status. Safe structured logs contain
  event, category, elapsed time, and outcome=unconfirmed on failure, never raw
  exceptions, SQL, URLs, CA contents, parameters, or credentials.

## Affected structure

```text
packages/database/src/migration-policy.ts       new administrative policy
packages/database/src/migrate.ts                dedicated executor
packages/database/test/migration-policy.test.ts new configuration tests
packages/database/test/migrate.integration.test.ts new PostgreSQL/process tests
packages/test-support/src/test-database.ts      use administrative executor
packages/database/test/schema.integration.test.ts adapt repeated execution
scripts/migrate.ts                             administrative process entrypoint
.env.example, .github/workflows/ci.yml          explicit administrative configuration
README.md, docs/database.md, docs/architecture.md, docs/implementation-plan.md
```

No business rules, grants, authentication, tenant APIs, runtime policy, schema
tables, migration SQL, MCP contracts, or release-image changes are intended.

## Failure behavior

Configuration, connection, lock contention, SQL/lock timeout, ledger mismatch,
interruption, operation deadline, and cleanup failures have static categories.
Destroy the session on failure; release the advisory lock explicitly on success
and by session termination on failure. Observe outstanding promise rejection.
Never report rollback merely because the client disconnected: commit response
loss is uncertain. Ledger scaffolding may remain after failed first execution.
An operator must inspect ledger/schema/activity and run M8-D readiness before
deciding whether a manual retry is safe. Administrative credentials are trusted
and powerful; advisory locks cannot constrain arbitrary out-of-band SQL.

## Tests and acceptance criteria

Use explicit TEST_DATABASE_URL, PostgreSQL 18, generated disposable names, and
creation-owned cleanup; never delete a supplied database or persistent volume.
Exercise the actual CLI, simultaneous independent processes, lock barriers via
pg_locks/pg_stat_activity, repeated execution/hash preservation, SQL failure,
statement and lock timeout, absolute deadline, interruption, backend termination,
ledger rejection, readiness rejection/recovery, and session cleanup. Test-owned
DDL event hooks in disposable databases inject failures without changing SQL.
Verify migration TLS
against a disposable TLS PostgreSQL fixture. No timing-only synchronization.

Acceptance requires npm run format, npm run verify, npm run verify:all,
npm run db:check, migration generation without drift, and git diff --check.
Record actual counts/failures and verify original M8-G worktree and existing
volume preservation. No commit/push and no M8-H2 implementation.
