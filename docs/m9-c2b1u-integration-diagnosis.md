# M9-C2B1U: final integration failure diagnosis

## Scope and retained failures

Preserve all S/T request-binding, cleanup and migration-classification work. This
slice diagnoses three failures from the final T normal two-worker integration run:

1. The discovery/legacy/tool/EOF stdio test received JSON-RPC -32603 on
   server/discover instead of success. It completed in 4.56 seconds rather than
   reaching its response deadline.
2. The default snapshot-holder timeout test observed its real PostgreSQL snapshot
   holder, but client-spy settings did not contain that PID (expected 330000 ms).
3. The maximum snapshot-holder timeout test had the same observation failure
   (expected 3630000 ms).

All three passed in T's selected isolated comparison. That is not proof of a
concurrency cause or permission to weaken the normal gate. Root causes start as
unresolved. No live provider requests, production changes, retries, deadline
increases, blanket serialization, commits or pushes are part of this diagnosis.

## Diagnostic plan

First extend test-only observations without changing assertions. Run selected
cases with the existing two-worker configuration, then their complete suite files
with normal partners, then npm run verify:all. Preserve every failed result and
record actual suite overlap. Run the three offline evaluation commands afterward.
The ordinary integration configuration and all existing deadlines stay unchanged.

For stdio, retain bounded phase timings and add numeric JSON-RPC error codes,
allowlisted error-message classifications, lifecycle event names, readiness failure
categories, exit code/signal, and ordering relative to readiness. Never copy raw
messages, stderr, arguments, responses, credentials or environment settings into
review evidence. Observations must not write on server stdout. Record whether a
failure is startup, readiness, protocol, or shutdown; missing observations are not
proof of absence. Inspect the SDK and application call paths before attributing an
internal protocol error to application logic. If a stdio application defect is
reproduced, write a separate narrow repair specification before considering code.

For recovery, record connect-spy context count, configured-database matches,
instanceof matches, observed backend PIDs, snapshot-holder PID, and whether the
holder was captured. Compare test and recovery pg resolution paths by equality
and constructor/prototype identity; export booleans rather than filesystem paths.
Check connection timing and real server settings. If the observation mechanism is
shown unreliable, repair that test mechanism while retaining the exact server-side
idle_in_transaction_session_timeout assertion for the actual snapshot-holder PID,
its active snapshot, advisory lock, and backup result. Do not infer that a missing
spy context proves a misconfigured database session.

## Evidence and acceptance

Use a newly owned, labeled, disposable PostgreSQL 18 cluster with no named volume;
never alter existing databases or Docker resources. Record original resource
inventories, dirty-file hashes, branch/HEAD, and all 11 migration hashes. Baseline
Windows CRLF files are verified using the established isolated LF source overlay;
do not normalize unrelated files. Diagnostic output is finite and allowlisted.
Private execution logs/configuration stay separate from explicitly selected JSON
review exports; exclude postgres.json, .env, copied checkouts, node_modules, raw
connection URLs and passwords from archives.

Acceptance requires a supported causal account for each failure or an explicit
unresolved classification, the required observations and resolution-identity
checks, focused/partner/full results with unchanged assertions and configuration,
retained failed runs, and migration/worktree/resource preservation evidence.
Passing isolated tests or a later full run alone does not establish a root cause.
Keep C2B2 live-execution restrictions and the 4096-token ceiling unchanged.

## Findings

The three historical T root causes remain unresolved. No U run has reproduced
-32603 or a missing snapshot-holder context. A passing later run is not a repair
or a causal explanation. No production defect, unreliable-spy cause, or scheduling
correction has been established; no production or observation fallback was added.

### Discovery

The retained T error was a real SDK response (-32603, Internal server error) at
4.56 seconds, during the opening discovery request before tool execution. T did
not retain the underlying exception, readiness ordering or lifecycle history for
that failure. It cannot now be classified as before or after operational readiness.

Source inspection shows that main.ts awaits the shared readiness promise in both
startup and the serveStdio factory, then checks lifecycle admission and creates the
McpServer. The installed SDK's stdio opening-message error path maps unexpected
exceptions to -32603 and calls onerror; the application logs mcp.protocol_error
without the raw exception. The generic response alone cannot distinguish readiness
rejection, server construction, or SDK handling. It is not evidence of an
application-use-case authorization or repository failure.

The first U focused run reproduced a different failure: response_timeout at
8033 ms, before the first PostgreSQL connect attempt at 9699 ms and its successful
TCP connection at 9713 ms. The child first event-loop turn was at 9716 ms. Maximum
observed child event-loop delay was 9043 ms, versus 3327 ms total observed child CPU.
No readiness event or discovery response was observed. The test closed stdin after
its timeout; the child logged stopping, protocol_error and stopped, exiting 0.
This localizes that new timeout to pre-connection startup. It does not establish
why startup was slow, prove host contention, or explain T's distinct -32603.

The initial complete-suite and full-gate discovery samples reached readiness at
4248 ms and 4183 ms respectively and exited 0. Their recorded -32602 responses
belong to the existing deliberately malformed tool-input checks after readiness.
They are not failed discovery responses. No -32603 was captured in these contexts.
Final live-iteration samples and all phase values are retained in sanitized JSON.

A separate owned-fixture hypothesis probe deleted one temporary role after the
readiness snapshot was established. Readiness still passed in 180 ms with no
underlying SQLSTATE error. This does not support unrelated role deletion as the
historical cause. No stdio application defect was reproduced, so no separate
production-repair specification or implementation is justified.

### Recovery PID observations

The final test retains the original live connections.mock.contexts iteration and
every original server-side assertion. A separate snapshot is used only to record
counts/PIDs. Diagnostics include counts before and after queries, database matches,
instanceof matches, observed and queried PIDs, holder PID, capture status, whether
the spy remains installed, and constructor/resolution equality booleans. The exact
idle timeout for the holder must still be 330000 ms or 3630000 ms; snapshot state,
shared advisory lock, lock contention and completed backup assertions remain.

Every captured U recovery case found two connect contexts, two configured-database
matches and two instanceof matches. The holder PID appeared in both the observed
and queried PID sets. The original live-iteration comparisons also report two
contexts after the queries. Constructor equality and resolution checks passed and
the spy remained installed. Exact PIDs are retained in each context's JSON record.
The database assertion passed for the actual holder in each observed execution.

Both test and compiled recovery implementation import Client from pg. Inspection
of the installed pg ESM wrapper shows that it exports the Client from its common
lib/index.js module. Diagnostics compare the test constructor with the pg.Client
resolved natively from the recovery module, and compare the test/recovery require
resolution results. These are runtime reference/path-equality checks, not exported
filesystem paths or a new production introspection API. No alternate constructor
was observed. This does not retroactively establish T's missing context counts or
constructor identities, which were not captured. Historical instrumentation,
module-identity, timing and session-configuration causes remain unproven.

### Comparison method and limits

Both comparison rounds used the unchanged two-worker integration configuration.
Suite setup/end observations record file identity, worker PID and finite timestamps,
allowing actual overlapping partners to be checked. The full run initially pairs
stdio and recovery; later partners are retained in the overlap records. Mere overlap
is not treated as a failure cause.

The initial diagnostic draft iterated a copied context array. The final version
restores the original live iteration and records before/after counts. Focused,
complete-suite and full-gate comparisons were explicitly repeated after that
observation adjustment; no automatic retry policy was introduced. Both versions
and all failed outcomes are preserved rather than replaced by a successful run.

Diagnostic recording remains opt-in with BELOVEDDEV_TEST_DIAGNOSTICS=1. It exports
only bounded fields and cannot establish exact child execution ordering from
independently delivered stdout/stderr events. Startup/readiness, protocol response
and process-exit observations must be considered together. Instrumentation may
perturb scheduling; these runs do not establish behavior for every uninstrumented
host or Linux CI. Deadlines, assertions, two-worker configuration and retries are
unchanged. No exception, fallback or blanket serialization was added.

## Verification

Verification runs use the established exact dirty-source overlay in an isolated LF
checkout on Node 24.12/npm 11.6 with real PostgreSQL 18. Baseline Windows CRLF files
were not broadly normalized and no system-wide Git setting was changed.

| Execution                               | Outcome                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Focused safe-diagnostic unit tests      | 13 passed                                                              |
| Initial focused target cases            | 2 passed, 1 pre-connection startup timeout; 58 not run under selection |
| Initial complete stdio/recovery suites  | 59 passed, 2 platform skips                                            |
| Initial npm run verify:all              | 693 unit and 465 integration passed, 3 platform skips                  |
| Original live-iteration focused cases   | 3 passed; 58 not run under selection                                   |
| Original live-iteration complete suites | 59 passed, 2 platform skips                                            |
| Final npm run verify:all                | Passed: 693 unit and 465 integration tests, 3 platform skips           |
| npm run eval                            | Passed: 4 deterministic workflows                                      |
| npm run eval:agent                      | Passed: 6 offline scenarios                                            |
| npm run eval:provider:test              | Passed: 156 offline controls; live readiness remains blocked           |

Type/lint corrections during instrumentation development and the initial owned
cluster setup failure are retained separately as execution evidence. They are not
successful test runs. The focused startup timeout remains a failure even though
later cases passed. Existing T failure evidence is preserved unchanged.

All 11 migration hashes match the original U baseline in source and verification
checkout. Only six test/document files are affected; application, authentication,
MCP contracts, migrations, S request binding and T production repair are unchanged.
Resource and other-worktree preservation checks are recorded separately before
retiring only the task-owned tmpfs PostgreSQL container.

The final full gate passed with the original live spy iteration and the two-worker
configuration. Its discovery process reached readiness at 5172 ms, then logged
stopping/stopped and exited 0 after EOF. No discovery error was returned. The only
recorded protocol errors were the existing -32602 malformed tool-input checks after
readiness. Final recovery samples were:

| Case    | Contexts before/after | Database/instance matches | Observed and queried PIDs | Holder PID | Verified timeout (ms) |
| ------- | --------------------- | ------------------------- | ------------------------- | ---------- | --------------------- |
| Default | 2 / 2                 | 2 / 2                     | 1593, 1594                | 1594       | 330000                |
| Maximum | 2 / 2                 | 2 / 2                     | 1596, 1597                | 1597       | 3630000               |

Both holders were captured, constructor/resolution equality checks passed, and the
spy remained installed. These observations still do not explain the historical T
misses. Final formatting/whitespace checks pass in the LF verification checkout.
Original Docker inventories and other worktree snapshots match; all owned fixture
and probe resources are checked before retiring only the task-owned cluster.

## Remaining uncertainty and review boundary

A future occurrence of the actual -32603 needs its corresponding safe lifecycle/
readiness record. A future missed-PID occurrence needs the new context, constructor
and backend observations. Current evidence is insufficient to replace the spy,
alter production startup/shutdown, change scheduling or extend any deadline.
Historical T failures remain explicitly unresolved rather than declared fixed.

Provider execution is still offline. Existing live token-budget, durable replay,
active-model approval and owner provisioning blockers remain unchanged. Zero live
provider API requests or charges occurred. No commit or push was made.
