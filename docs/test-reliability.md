# M8-H2 parallel test reliability

## Diagnosis and reproduction

The pre-repair default four-worker PostgreSQL run reproduced 428 passing tests,
four failures, and three Windows POSIX-signal skips across 17 files. No worker
override or concurrent container build was used. The exact failures were:

| Suite     | Test                                                                                              | Error                                       |
| --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| migration | migrates an empty database and preserves hashes and IDs on repeated CLI execution                 | Test timed out in 20000ms                   |
| migration | handles SIGTERM through the actual CLI signal handler with nonzero safe diagnostics               | Test timed out in 20000ms                   |
| stdio     | rolls back a disconnected active write and only retries on a new explicit tool call               | Timed out waiting for MCP response (8000ms) |
| stdio     | drains an admitted write after EOF, preserves its unseen commit, and recovers by idempotent retry | Timed out waiting for MCP response (8000ms) |

Read-only sampling recorded `DROP DATABASE` waiting in `CheckpointDone` for up
to 8,822 ms, `CheckpointStart` for 4,293 ms, and `ProcSignalBarrier` for 6,068 ms.
The monitoring window recorded 49 requested checkpoints and 60,443 ms of checkpoint
sync time. The host had four logical CPUs and approximately 1.07 GiB free RAM
during reproduction. PostgreSQL had no container restart or recorded OOM kill.
The independent monitoring process observed up to 621 ms of scheduling lag.

These are shared-cluster durable I/O and host/process scheduling constraints.
Database creation, repeated cold CLI starts, migration validation and retirement
all counted against the same 20-second test budget. The eight-second stdio
response limit also includes cold process/readiness work. This evidence does not
demonstrate an application advisory-lock, transaction or authorization defect.
Earlier generic cleanup errors discarded the failing stage and SQLSTATE; their
exact historical cause cannot be reconstructed from the retained catalogs.

## Repairs and unchanged guarantees

The default integration budget is **two parallel workers**. This reserves host
capacity for PostgreSQL, native dump/restore processes and child MCP/CLI servers.
It does not serialize individual concurrency tests: their separate sessions,
overlapping writes and independent migration processes still run concurrently.
The normal unit-test worker policy is unchanged. Do not run a cold container
build concurrently with a reliability measurement of this shared test cluster.

Vitest's existing test/hook limits and the stdio RPC limits were not increased.
Production migration, recovery and MCP runtime deadlines were not changed.
Migration serialization, snapshot coordination, the recovery idle
timeout (`deadline + 30000`), native termination, socket destruction and runtime
database policy remain unchanged. No retry was added.

Migration tests execute their assertions inside `beforeMigrate`, before fixture
creation returns. Vitest timing out the test does not cancel that asynchronous
setup. Per-file lifecycle hooks now settle unfinished fixture setups after the
test's subprocess cleanup, and retire late-created fixtures before completion.
This settlement has a 45-second bound within the existing 60-second hook budget.
The file teardown also closes fully initialized fixtures left unretired by their
caller. Both registries contain only this module's live invocation-owned handles;
they never discover resources by catalog prefix. A failed/unconfirmed setup stays
visible and cannot authorize deletion of an unknown identity.

Two recovery tests previously depended on reaching a blocked utility within three
seconds or a callback within seven seconds of the whole operation starting. They
now inject an expired deadline signal **after** reaching the intended state.
These phase tests use the production default operation budget and a supplied
expired-deadline signal instead of the short artificial startup-inclusive budgets.
A separate real backup test verifies the actual overall timer can expire during
startup and removes its partial artifact. This separates deadline behavior from
an unsupported assumption about provisioning speed.

`createTestDatabase` now records database/role OIDs and the database owner, and
checks them before retiring this invocation's generated resources. A matching
prefix alone never authorizes deletion. Missing/unconfirmed identity fails
closed. Checked-out clients belonging to its pools are destroyed during teardown,
so `pool.end()` cannot indefinitely await an unreleased test checkout. Pool close
has a five-second bound; administrative queries retain their existing ten-second
server statement timeout. Failed cleanup remains a failed test.

Repeated/concurrent `close()` calls share one promise, including a failed result;
they never repeat destructive SQL. Every independent cleanup step is attempted.
Errors retain safe stage/SQLSTATE information, including through nested recovery
teardown. Setup plus cleanup failure preserves both errors. Artifact and TLS
cleanup no longer depend on successful database retirement. Catalog-barrier
connections are released even when rollback fails.

Regression coverage includes independent/nested cleanup failures and safe
diagnostics; real idle/active leaked checkouts; concurrent/repeated retirement;
partial setup failure; continued database/role retirement after pool-close failure;
late successful/failed setup settlement; and refusal to delete a same-name
replacement role with a different OID. The
replacement-role regression removes only its own separately recorded test roles.

## Residual resource audit and manual approval

The initial three retained databases have the same names, OIDs and owner as the
previous run. The pre-repair reproduction left one additional database/role.
Read-only catalog inspection after the repaired focused suites found:

| Database                                         | Database OID | Owner      | Runtime role OID |
| ------------------------------------------------ | -----------: | ---------- | ---------------: |
| beloveddev_test_87773c7b22324718b62aa666fa70ce92 |       546670 | beloveddev |           546671 |
| beloveddev_test_250e177997734f7d98a8477c6902ed78 |       552886 | beloveddev |           552887 |
| beloveddev_test_f1f8855f9b914f65a1a644b4e8b7db44 |       562724 | beloveddev |           absent |
| beloveddev_test_81a34cd4a61b4f1fb27cfd887f486097 |       600599 | beloveddev |           600603 |

Existing role names are the corresponding database name plus `_runtime`. All four
databases and three roles had zero sessions. The roles had zero memberships and
catalog dependencies only on their matching database (13, 13 and 16 ACL references,
respectively). Their identities and names are consistent with known generated
test resources, but catalogs alone cannot establish full historical provenance.

**No retained database or role was removed.** Manual cleanup requires explicit
owner approval identifying the exact rows above. Immediately before any approved
action, recheck names, OIDs, database owners, sessions, role memberships and
cross-database dependencies; stop on a mismatch. Retire only individually approved
identities and verify the result. Never enumerate a prefix and drop its matches,
remove development data, remove a Docker volume, or touch M8-G.

## Verification

`npm run verify` passed 459 tests across 20 files. `npm run verify:all` passed
the same 459 unit tests and 440 PostgreSQL integration tests across 18 files,
with three Windows-specific POSIX signal cases skipped. `VITEST_MAX_WORKERS`
was unset; the integration run used the repository's two-worker parallel default.
The PostgreSQL run took 341.64 seconds. The original four-worker run took 288.67
seconds with four failures and eight fewer integration cases, so these timings
are not an equivalent-workload performance comparison.

The new coverage consists of four cleanup orchestration unit cases, seven real
fixture lifecycle cases, and one actual overall-timer startup case. The existing
snapshot/default/maximum and migration-concurrency tests also passed. Migration
generation reported no drift; hashes of all 11 migration artifacts were unchanged.

The post-verification read-only audit matched the four database and three role
identities above exactly: no new residuals from the repaired full run, no active
sessions on those resources, and no recovery/migration administrative sessions.
`npm run test:container` passed separately, including a reproducible cold rebuild,
Node 24.22.0, 11 migration files, eight tools, EOF/SIGINT/SIGTERM, six safe startup
rejections and no application listeners. The release image digest remained
`sha256:2f339e5ecbe26766705998efc52eb70d5b5d2e8552cc030134d64f640b7216d5`.
