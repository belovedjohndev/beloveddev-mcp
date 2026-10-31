# M9-C2B1T: evaluation cleanup and integration diagnosis

This slice preserves the S execution lease, runner-issued turns, body permits,
fixture authorization, model, token ceiling and read-only gateway. No live provider
requests or stdio lifecycle changes are part of this slice. A reproduced migration
error-classification defect is repaired without changing transaction behavior.

## Cleanup correction

The existing independent cleanup helper now accepts synchronous teardown steps.
withTestResourceCleanup preserves an original assertion by identity, attempts every
owned cleanup stage, and reports both assertion and cleanup failures when both
occur. Evaluation hooks snapshot ownership before teardown and independently close
transports, clients, fixtures, servers and pools, revoke grants, and restore global
state. Expected injected sticky fixture failures must be explicitly asserted before
ownership is relinquished; unexpected failures are never swallowed. Raw stdio child
processes have a fallback ownership registry. Migration process cleanup no longer
discards rejected closure promises.

## Diagnostic boundary

BELOVEDDEV_TEST_DIAGNOSTICS=1 enables test-only timing observations. It does not
change test deadlines, production source, or integration scheduling. The normal gate
remains two workers with its existing assertions and limits. An opt-in Node 24
preload sends bounded IPC observations for bootstrap, first event-loop turn, event-
loop lag, TCP connect, and stdout-write timing. It never reads or changes stdout
payloads and never prints diagnostics on the MCP process streams. Parent observations
record spawn, request/response, existing structured readiness, watchdog, and cleanup
phases. Test-parent diagnostic output contains only whitelisted phase names and
finite timings. Invalid IPC fields, arbitrary stderr, environment values and payloads
are excluded. Records are capped and explicitly report truncation.

TCP completion is not proof of PostgreSQL authentication. Bootstrap-to-readiness
also includes module loading, authentication and schema/privilege checks; without
more evidence those components remain unseparated. Missing observations are not
proof that a process never started. Parent/child scheduling lag and IPC delivery lag
are recorded separately. Instrumentation is opt-in and its possible perturbation
must be distinguished from ordinary full-suite validation. No concurrency root cause
or scheduling change is assumed in advance.

## Reproduced migration classification defect

An instrumented full-suite run reached the existing operation-timeout assertion but
reported CONNECTION instead of OPERATION_TIMEOUT. A separate real-PostgreSQL
reproduction without the timing preload observed server SQLSTATE 25P04 while the
adapter reported CONNECTION. A deterministic regression then held this test
database's advisory lock and supplied a 200 ms PostgreSQL transaction_timeout to
only the migration client, leaving its 12-second application deadline unchanged.
Before the fix it reported SQL_FAILURE; after the fix it reports OPERATION_TIMEOUT
and verifies that sessions are released and a subsequent migration succeeds.

PostgreSQL transaction_timeout terminates the session; 25P04 identifies this
condition ([PostgreSQL timeout policy](https://www.postgresql.org/docs/18/runtime-config-client.html),
[SQLSTATE reference](https://www.postgresql.org/docs/18/errcodes-appendix.html)). With
an active query, node-postgres forwards the server error to that query rather than
the Client error event. Query rejection and a generic connection-close notification
can therefore compete for the adapter's first failure classification. The adapter
now observes the protocol errorMessage event for precisely 25P04 before the generic
close path. Other SQLSTATE handling, operation/cleanup limits, connection ownership,
Drizzle transaction SQL, rollback claims and retry policy are unchanged. No migration
artifact, authentication, tool contract or application-domain rule is modified.

## Retained failures and limits of diagnosis

The original S intermediate oversized-input test exposed a raw Zod configuration
error. The final S serializer already converted it to provider_configuration; this
slice retains that implementation and strengthens the regression to require the
safe category/message and no credential or transport access.

Historical S MCP response, migration subprocess and idle-pool shutdown failures are
retained as failed evidence. Focused isolated cases passed during T. The normal
full-suite gate also passed before the migration repair, while the instrumented run
failed the distinct timeout-category assertion above. Matched stdio startup samples reached readiness in 2.25-3.95 seconds in isolation
and 3.09-4.55 seconds in the full suite. Both runs recorded child event-loop delay;
observed TCP connections were much shorter. Those observations do not separate module
loading from authenticated database readiness, establish contention as a cause, or
explain every historical timeout. Those root causes remain unresolved; no scheduling
correction, deadline increase, automatic retry or suppressed assertion is justified.

## Review evidence security

Private execution material and sanitized review evidence use separate directories.
Review exports use an explicit JSON-file allowlist: command exit classifications,
relative test names, bounded numeric timing observations, migration hashes, and
resource-preservation counts. They must exclude postgres.json, environment files,
raw logs, copied checkout directories, node_modules, raw connection URLs and
passwords. Retained failed runs remain available privately; their safe classifications
and timings must appear in the review summary rather than being hidden by later runs.

## Verification results and remaining failures

Required commands ran against an isolated LF checkout with the exact uncommitted
source overlay, Node 24.12, PostgreSQL 18, and no provider key or live execution.
The original Windows checkout still reports formatting issues in 122 baseline
CRLF files. No unrelated file normalization or global Git setting change was made.

| Command                    | Final result                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| npm run format:check       | Passed in LF checkout                                                             |
| npm run verify             | Passed: 691 tests                                                                 |
| npm run db:check           | Passed                                                                            |
| npm run verify:all         | Failed: 691 unit tests passed; integration 462 passed, 3 failed, 3 platform skips |
| npm run eval               | Passed: 4 deterministic workflows                                                 |
| npm run eval:agent         | Passed: 6 offline scenarios                                                       |
| npm run eval:provider:test | Passed: 156 offline controls; live readiness remains blocked                      |
| git diff --check           | Passed                                                                            |

Focused cleanup/provider tests passed 135 cases; real fixture tests passed 13.
The original eight retained-failure cases passed in isolated diagnostic execution.
After the migration repair, its whole PostgreSQL test file passed 22 cases with one
platform skip. The normal final integration gate then exposed these three failures:

- The stdio discovery/legacy/tool/EOF test received SDK error -32603 on discovery;
  this was an actual error response, not an MCP response timeout.
- Both recovery snapshot idle-timeout tests found the expected database snapshot
  holder but their client-spy settings observations did not include that PID.

All three passed in a subsequent explicitly selected isolated comparison (3 passed,
58 excluded by selection). This does not establish their full-suite root causes or
make the failed normal gate pass. Recovery source and assertions remain unchanged.
No automatic retry, deadline increase, scheduling correction or production stdio
lifecycle change was introduced. These integration failures remain review blockers.

Failed evidence is retained: an earlier instrumented full integration run had
463 passed, 1 failed, 3 skipped (the reproduced migration category defect), while
the pre-repair normal gate passed 464 integration cases with 3 skips. Development
failures in diagnostic typing/lint, the new regression's initial missing import,
and a private probe's module-loading choice were corrected and retained separately.
Passing later commands do not erase those runs.

All 11 original migration artifact hashes match in source and verification checkout.
No migration generation, domain logic, authentication or tool-contract change was
made. Review exports contain sanitized failure classifications and timings, not
credentials or copied execution directories. Existing worktrees and Docker resources
are preserved; only the identity-checked task-owned tmpfs PostgreSQL is retired.

The approved model-request binding is unchanged. Live execution remains blocked by
the 13,013-token preflight versus the 4,096-token ceiling, durable replay storage,
active-model approval, owner limits/provisioning and unverified live compatibility.
Zero live model API requests or charges occurred. No commit or push was made.
