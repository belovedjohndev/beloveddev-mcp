# PostgreSQL 18 backup and recovery operations

M8-H2 provides operator-invoked logical backups and verified, temporary restore
drills. It never replaces an existing database. M8-D readiness remains mandatory;
M8-H1 migration behavior, runtime permissions, tenant authorization, audited
mutations, and all eight MCP contracts are unchanged. Milestone 8 is not declared
complete or production-ready by this work.

## Prerequisites and trusted inputs

Use Node/npm versions from the repository and **PostgreSQL 18** `pg_dump` and
`pg_restore`. Both client major versions and server major 18 are checked. An
absolute `DATABASE_RECOVERY_PG_BIN` directory selects trusted native executables;
otherwise a protected PATH is used. No shell, Docker command wrapper, or installer
is invoked by the recovery executable. Linux CI installs PostgreSQL 18 clients
from the official signed PostgreSQL apt repository. Windows can use the official
[EDB binary archive](https://www.enterprisedb.com/download-postgresql-binaries)
without running its server installer; install only through your reviewed process.

Keep these in a separate protected recovery env file, never the MCP launcher:

| Variable                       | Purpose                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `DATABASE_BACKUP_URL`          | Explicit source administrator/backup URL                               |
| `DATABASE_BACKUP_TLS_CA`       | Optional source private CA PEM, 1–65,536 characters                    |
| `DATABASE_RESTORE_ADMIN_URL`   | Explicit control database on the approved recovery/test cluster        |
| `DATABASE_RESTORE_TLS_CA`      | Optional target private CA PEM                                         |
| `DATABASE_RECOVERY_PG_BIN`     | Optional absolute PostgreSQL 18 client directory                       |
| `DATABASE_RECOVERY_TIMEOUT_MS` | Positive decimal integer milliseconds, default 300000, maximum 3600000 |

There is **no fallback** to DATABASE_URL, TEST_DATABASE_URL, migration URLs, or
runtime CA configuration. Source and target administrators can differ. Native
Node env-file loading preserves already exported variables: remove stale
DATABASE_BACKUP/RESTORE/RECOVERY values before selecting a protected file.

The source login needs CONNECT, metadata/data/sequence reads for the complete
application and ledger, and permission to export a snapshot. It must see every
tenant; a partial-visibility backup is unacceptable. Use a trusted owner/admin
for this V1 workflow. The restore login needs CONNECT to the control database,
CREATE DATABASE, CREATE ROLE, and ownership of generated targets. Do not grant
these rights to runtime users. Protect database administration, OS accounts,
client executables, artifacts, and configuration as trusted infrastructure.

Both endpoints use the M8-D strict URL parser. Remote connections require
`sslmode=verify-full`, certificate-chain/hostname verification, and TLS 1.2+.
Only explicit loopback permits plaintext; a forwarder can lead to remote systems
and must use verified TLS. URL endpoint/role/TLS overrides and ambiguous SSL
modes fail closed. Private CA contents are written to temporary mode-0600 files.
Without a private CA, Node uses its trust store and libpq uses its system trust
store; administrators must provision appropriate trust roots for both.

Subprocesses receive an allowlisted OS environment plus explicit libpq endpoint,
identity, TLS, encoding, and session settings. Ambient PG* service/password/SSL
settings cannot choose the endpoint or weaken verification. Passwords use an
invocation-private passfile, never URLs/passwords in argv or PGPASSWORD. Temporary
passfile/CA files are removed on normal success/failure. Forced process/host loss
can leave private files requiring inspection. OS administrators can still read
process memory and protected files; this is not protection from a hostile host.

## Backup creation

Prepare an existing protected parent directory **outside the repository**. On
Linux use owner-only permissions (0700 parent/directories, 0600 files). On Windows
use an NTFS ACL restricted to the operator/service account and approved recovery
administrators; POSIX mode bits do not establish Windows ACL protection. The OS
temporary directory must have equivalent account isolation because it temporarily
holds credentials. Use encrypted storage and encrypt copies before transfer to
approved remote/off-site storage. Custom-format compression is not encryption.

Build once, then invoke the Node entrypoint directly. Examples contain no live
credentials; the protected env file must contain owner-provided values. Choose
a previously unused artifact name. Its parent must already exist.

```powershell
npm run build
node --env-file="C:/Protected/BelovedDev/recovery.env" scripts/recovery.ts backup "C:/Protected/BelovedDev/backups/unique.pgbackup"
node --env-file="C:/Protected/BelovedDev/recovery.env" scripts/recovery.ts validate "C:/Protected/BelovedDev/backups/unique.pgbackup"
node --env-file="C:/Protected/BelovedDev/recovery.env" scripts/recovery.ts drill "C:/Protected/BelovedDev/backups/unique.pgbackup"
```

```sh
npm run build
umask 077
node --env-file=/protected/recovery.env scripts/recovery.ts backup /protected/backups/unique.pgbackup
node --env-file=/protected/recovery.env scripts/recovery.ts validate /protected/backups/unique.pgbackup
node --env-file=/protected/recovery.env scripts/recovery.ts drill /protected/backups/unique.pgbackup
```

`npm run db:recovery -- backup /absolute/unique.pgbackup` is an alternative when
explicit variables are injected; it builds and reads optional repository `.env`.
The direct Node entrypoint leaves stdout empty and writes safe JSON diagnostics
to stderr. The npm wrapper additionally prints build/lifecycle output.

The source connection verifies database/user identity, PostgreSQL 18, the reviewed
catalog signature, and every committed migration hash/timestamp. It acquires the
H1 database advisory lock in **shared** mode, preventing cooperating H1 migrations
while allowing concurrent backups. It begins REPEATABLE READ READ ONLY, exports
its snapshot, and computes counts/SHA-256 for every column of every row, ordered
by primary ID, in bounded cursor batches. Timestamps are canonicalized in UTC.
`pg_dump --format=custom --snapshot=... --no-owner --no-acl --no-tablespaces`
exports that exact snapshot, including all user schemas, eleven application
tables, data, constraints, indexes, generated search data, and Drizzle metadata.
The operation never writes source business data, changes grants, or migrates.
Snapshot reads can retain dead tuples and locks; plan capacity and avoid long
backup windows on busy sources. Arbitrary administrator DDL bypasses H1's lock.

The artifact is an exclusively reserved private directory:

```text
unique.pgbackup/
  archive.dump       PostgreSQL custom-format archive
  manifest.json      strict versioned completion/integrity metadata
```

An existing directory/file is refused without modification. Dump bytes initially
go to archive.partial; its contents are fsynced and validated. The archive is
renamed inside the private directory; manifest.partial is written/fsynced and
renamed to manifest.json last. Incomplete directories are never accepted as valid
backups and are removed best effort on handled failure. Filesystem rename/link,
permission, durability, and power-loss guarantees depend on the storage platform;
directory metadata durability is not a cross-platform guarantee. Protect artifact
immutability and copy both files together. Backups and their contents must never
enter Git, Docker build contexts, public logs, or CI artifact uploads.

## Validation and what it proves

Validation checks a strict versioned manifest, regular artifact files, PGDMP
magic, file size, SHA-256, and PostgreSQL 18 archive listing. Every application
TABLE and TABLE DATA entry and the drizzle schema/ledger must be represented.
PostgreSQL 18 omits a separate public SCHEMA entry for the initdb-created schema;
its required public TABLE entries identify that schema. A full pg_restore-to-SQL
traversal/decompression is discarded without executing SQL, detecting damaged
data blocks/truncated tails that a TOC-only check misses. All utility exit codes
and stderr warnings are checked. No raw utility stderr is printed.

The manifest records completion status, archive digest/bytes, timestamp,
backup-validation duration, reviewed schema digest, and per-table counts/digests.
It contains no row content, passwords, or URLs. A checksum is not an authenticity
signature: an attacker able to replace both archive and manifest can forge them.
Only restore trusted backups from protected storage with trusted provenance.
Retain the matching application build and exact committed migration artifacts:
the verifier deliberately rejects a different reviewed schema/ledger version.
Restore with that matching release, then plan any separately reviewed H1 upgrade.
Restoration executes archive SQL with administrative authority. Listing, checksum,
and decompression success **do not prove recoverability**; run a restore drill.

## Isolated restoration and runtime permissions

`drill` always creates a fresh `beloveddev_restore_<random UUID hex>` database
from template0 and a generated `_rt` runtime role. No target database name is
accepted. The control endpoint is not overwritten or dropped. Identity/version,
fresh emptiness, generated-name format, database owner, and recorded catalog OIDs
are checked before restore/retirement. Native pg_restore uses --exit-on-error,
--single-transaction, --no-owner, --no-acl, and --no-tablespaces; it never uses
--clean, --create, or --disable-triggers. Object ownership belongs to the restore
administrator. Source cluster-global roles, passwords, tablespaces, server
configuration, extensions outside the reviewed schema, and WAL/PITR history are
not reconstructed by this workflow. Separate approved cluster provisioning is
required for those concerns.

After restore, the executor verifies the reviewed catalog signature, complete
committed ledger, and every table's exact count/digest. PostgreSQL restores and
enforces foreign keys, checks, unique constraints, and indexes. It provisions the
same explicit grants already documented in [database.md](database.md#migrations):
no dangerous role attributes/inherited memberships, no schema/database creation
or TEMPORARY for PUBLIC, narrow table/column reads, append-only note/audit writes,
and SELECT-only migration metadata. It never grants runtime migration rights.
The unchanged read-only M8-D probe runs with that generated restricted role.

The public programmatic `withRestoredDatabase` API makes the target available only
inside an operation-bounded callback, with private administrator/runtime clients
and runtime URL. The CLI uses this to verify and immediately retire the target;
it never prints temporary credentials or leaves a promoted database running.
A reviewed operator callback can initialize the existing MCP client using the
temporary runtime URL and approved actor/tenant, inspect IDs/audit relationships,
and retry a known note. Never print the URL or full rows to diagnostics. Runtime
readiness is checked again after the callback so unsafe grant changes fail.

The automated PostgreSQL drill seeds two tenants and all eleven application
tables, creates an audited note through actual MCP/application execution, restores
twice into separate targets, compares every row, exercises constraints and full
text/Gin search, calls representative MCP reads, verifies cross-tenant refusal,
and retries the identical note key/payload/actor/tenant. The note ID/content and
audit linkage remain unchanged and no duplicate note/audit is written.

## Deadlines, diagnostics, and incident procedure

Each operation has a default five-minute deadline (maximum override one hour),
five-second connection setup, two-minute administrative SQL, and five-second
lock waits. Recovery-owned administrator connections set
`idle_in_transaction_session_timeout` to `DATABASE_RECOVERY_TIMEOUT_MS + 30000`:
330,000 ms for the default 300,000 ms deadline, or 3,630,000 ms for the maximum
3,600,000 ms deadline. The exported snapshot holder stays idle in its read-only
transaction during pg_dump; its idle timeout must outlast the entire operation,
otherwise PostgreSQL could kill it and release the shared migration lock early.
The 30-second margin covers the five-second native termination/session-close
grace with scheduling headroom. It does not extend the operation deadline: abort
still destroys the owned socket immediately and terminates the native utility.
The shared lock is session-scoped and remains held after transaction rollback
until the connection closes. No recovery path overrides this connection setting;
MCP runtime pool timeouts remain unchanged. Real PostgreSQL regression tests
inspect the server setting on the actual snapshot-holder PID at both supported
deadline endpoints while native pg_dump is blocked at a catalog lock barrier;
they also verify its active snapshot and shared migration lock prevent an
exclusive migration lock, then complete the dump after releasing the barrier.
These tests verify settings and coordination without waiting five minutes or an
hour; JavaScript event-loop/OS stalls and external session termination remain
outside the deadline/cleanup timing guarantee.

Native utilities have a five-second connection timeout; pg_dump's
lock-wait limit is five seconds. Native utilities may set their own server session
timeouts; the operation deadline therefore kills the owned utility, observes its
exit, and closes the owned connections. Server disconnect detection is requested
at one-second intervals where supported, but delayed detection is possible.
No automatic retry occurs. SIGINT/SIGTERM abort; forced Windows termination and
SIGKILL cannot execute cleanup handlers.

Native process termination/session close has a five-second grace. Cleanup of a
created target uses a fresh connection with an independent 15-second budget;
closing owned pools/connections also has bounded grace. Cleanup may extend beyond
the operation budget. Callback queries lose their checked-out sessions on abort;
late rejections remain observed. Arbitrary synchronous callback CPU work cannot
be preempted by JavaScript timers. Do not run untrusted callbacks or utilities.

Failure is nonzero with database.recovery_failed, outcome=unconfirmed, safe
category, and duration. Categories cover configuration, unsupported client,
process/connection, artifact/existing path, schema/ledger/data, restore/readiness,
interruption/deadline, and cleanup. No raw SQL/error, archive content, passwords,
URLs, or internal paths are logged. PostgreSQL administrator logs may contain
statements and must be separately protected. A failure/deadline/disconnect does
not establish rollback, nor does a successful pg_restore exit establish complete
recovery without subsequent validation/readiness.

1. Preserve safe diagnostics and protect the supplied artifact. Do not retry an
   uncertain production action or overwrite an existing artifact.
2. For an archive failure, validate a protected copy. Check metadata, size/digest,
   tool versions, storage errors and completed transfer. A matching checksum with
   failed decompression/restore still means unusable/unverified backup.
3. For target failure, inspect only this invocation's generated resources on the
   approved recovery cluster. Verify name, owner, recorded OID and provenance;
   never mass-drop a prefix or delete an arbitrary supplied database/role.
   Successful/handled-failure paths attempt retirement and verify identity before
   DROP DATABASE WITH (FORCE)/DROP ROLE. Failed cleanup is a failure, not success.
4. Force-killed processes, host loss, or lost CREATE acknowledgement before OID
   capture can leave resources requiring manual ownership investigation. Do not
   infer ownership solely from a similar name; verify against the operator's
   protected incident evidence. Remove only confirmed invocation-owned resources
   with reviewed administrator action. Never remove the development volume.
5. Investigate schema/ledger mismatch against the exact deployed SQL bytes and
   reviewed artifact. Do not regenerate applied migrations, edit ledger rows,
   weaken readiness/grants, or automatically stamp/repair history. Consult the
   [H1 incident procedure](database.md#failure-diagnosis-and-manual-recovery).
6. Once the failure is understood, create a new artifact or new isolated drill.
   A manual verified drill never authorizes automatic production cutover. Any
   replacement/cutover requires separate owner authorization, maintenance/traffic
   planning, final snapshot/validation, client reconfiguration, and rollback plan.

For an uncertain note operation, inspect existing note/audit identity through
approved application/MCP access. Retry with the **same trusted tenant and author,
original idempotency key, project/category and exact content**. The existing unique
constraint/application comparison returns the committed note with created=false,
without another audit; a changed payload conflicts. Never invent a replacement
key merely because the original response was lost. A backup cannot recover writes
committed after its snapshot without an additional recovery system.

## Recovery objectives and owner decisions

No RPO/RTO guarantee, schedule, retention SLA, storage destination, or unattended
backup service has been approved or implemented. Drill timings measure this
machine's tiny synthetic V1 dataset and do not establish production capacity.
backupDurationMs covers snapshot/dump/archive validation and hashing before final
publication; restoreDurationMs covers archive validation, restore, complete data
verification and restricted readiness, excluding callback and retirement. Total
CLI drill duration also includes cleanup. Record timings alongside dataset size,
client/server versions and infrastructure during each operational drill.

| Required decision     | Current status / responsible owner decision                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| RPO                   | Unset; owner must approve maximum acceptable committed-data loss and snapshot cadence                            |
| RTO                   | Unset; owner must approve maximum outage and measure full provisioning, restore, validation and cutover          |
| Schedule              | Unset; choose operator/external scheduler, failure alerts, and proof of successful completion                    |
| Retention             | Unset; choose generations, expiration, legal requirements, deletion authority and storage capacity               |
| Storage               | Unset; approve encrypted restricted storage outside this repository and test transfer integrity                  |
| Encryption/access     | Unset; approve encryption at rest/in transit, key custody, administrator/OS access, and secret rotation          |
| Off-site copies       | Required before relying on this for disaster recovery; owner must select an independent failure domain           |
| Restore authorization | Named service/data owner approval for production recovery/cutover; this CLI cannot replace production            |
| Verification cadence  | Unset; approve routine full restore drills and drills after schema/infrastructure/client changes                 |
| Responsibility        | Assign a backup operator, monitoring/on-call owner, restore executor, data validator and incident decision maker |

Logical backups do not provide continuous WAL archiving/PITR, cluster-global
recovery, automatic failover, encrypted artifact management, unattended scheduling,
retention enforcement, cross-region storage, or production replacement automation.
Those deployment capabilities require explicit follow-up decisions. M8-G remains
separate; M8-H2 does not establish overall Milestone 8 readiness.

References: [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html), and
[libpq TLS policy](https://www.postgresql.org/docs/18/libpq-ssl.html).
