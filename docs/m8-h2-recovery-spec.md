# M8-H2: PostgreSQL logical backup and isolated recovery

## Preconditions and problem

Branch feat/m8-h-recovery is clean at 43729c1. Linux CI run 39255829003 passed
both verify and container-smoke. The separate original M8-G worktree is read-only
to this task. H1 serializes migrations but does not establish recoverability.

## Scope and inspected behavior

Preserve all eleven application tables, the Drizzle ledger, committed SQL, M8-D
schema signature/effective grants, and existing application/MCP contracts.
pg_dump custom format provides a consistent logical snapshot; pg_restore uses
strict single-transaction execution. Cluster-global roles/configuration are not
part of a single-database dump. Restoration executes trusted archive SQL.

## Design and invariants

Require explicit DATABASE_BACKUP_URL and DATABASE_RESTORE_ADMIN_URL, independently
parsed through M8-D URL/TLS policy, with dedicated optional CA PEM variables.
Native PostgreSQL 18 pg_dump/pg_restore are required; reject other client majors.
DATABASE_RECOVERY_PG_BIN optionally selects an absolute trusted binary directory.
Never put passwords/URLs in argv or logs. Use a minimal subprocess environment,
explicit libpq fields, private temporary passfile/CA, verified TLS (including
hostname), TLS 1.2 minimum, finite server limits, and shell=false execution.

Backup holds the H1 shared advisory lock and exports a read-only repeatable-read
snapshot. Verify the reviewed schema and full ledger, compute deterministic
streamed per-table row counts/SHA-256 digests, and dump that exact snapshot.
Reserve a new private artifact directory exclusively; never overwrite one.
Validate archive magic, TOC schemas/tables/table-data/ledger, and traverse the
entire archive through pg_restore before publishing completion metadata with
archive SHA-256, byte size, table digests, schema/ledger expectations, and timing.
Partial directories are never valid completed backups and are removed best effort.

Restore accepts no destination database name. Generate a fresh database and
runtime role, record their catalog identities, and verify identity before writes
or cleanup. Restore without source ownership/ACL/tablespaces, in one transaction,
then verify every table digest, schema signature, and ledger. Provision exactly
the existing documented M8-D runtime grants, run unchanged readiness, and expose
the isolated target only inside a bounded callback. Always retire owned targets;
never replace production or drop a supplied database. No automatic retries.

Default operation bound is five minutes (positive integer override up to one
hour), connect five seconds, SQL two minutes, lock waits five seconds, subprocess
termination grace five seconds. Abort/deadline destroys subprocesses and closes
database sessions. Failures use safe categories and never claim rollback without
verified final state. Forced termination may require ownership-checked manual
cleanup. Archive checksums/listing alone do not prove successful restoration.

## Intended files and architecture

```text
packages/database/src/recovery-policy.ts       explicit configuration
packages/database/src/recovery-process.ts      bounded native utilities/passfiles
packages/database/src/recovery.ts              backup, validation, owned restore
packages/database/test/recovery-policy.test.ts deterministic policy tests
packages/mcp/test/recovery.integration.test.ts  PostgreSQL/MCP recovery drills
packages/database/package.json                administrative export
scripts/recovery.ts                           backup/validate/drill CLI
package.json, package-lock.json, .env.example, .gitignore commands/config/artifact exclusion
.github/workflows/ci.yml                       PostgreSQL 18 client availability
README.md, docs/database.md, docs/architecture.md, docs/implementation-plan.md
docs/recovery.md                              operator runbook/owner decisions
```

MCP remains an interface to existing application use cases. Administrative
recovery stays outside runtime startup. No schema migrations, new tables/tools,
authorization/authentication changes, M8-G imports, or production replacement.

## Tests and acceptance

Real PostgreSQL 18 source/target databases and standard client utilities. Seed
all tables with two tenants and an actual audited note mutation. Restore twice;
compare every row deterministically, complete ledger/schema, constraints/indexes,
full-text search, restricted readiness, MCP reads/tenant isolation, and exact note
retry without duplicate audit. Exercise corrupt/truncated archives, missing
migration data, path/existing-artifact refusal, wrong credentials, unsupported
client major, process failure, state-coordinated interruption/deadline, excessive
grants/readiness rejection, and cleanup after failed restoration. Preserve and
inspect the existing volume and original source. Measure drill durations without
claiming RPO/RTO guarantees. Document schedule/retention/storage/encryption/off-site
copies/authorization/verification cadence/responsibility as owner decisions.

Run format, verify, verify:all, db:check, test:container, new recovery integration
tests, migration generation without drift, and git diff --check. No commit/push;
stop after H2 and report actual results and limitations for source review.
