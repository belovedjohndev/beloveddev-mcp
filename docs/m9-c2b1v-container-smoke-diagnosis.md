# M9-C2B1V container-smoke diagnosis

## Scope and acceptance criteria

Investigate post-merge run [41211910726](https://github.com/belovedjohndev/beloveddev-mcp/actions/runs/41211910726), job `container-smoke`, phase `safe rejection: TRANSPORT_POLICY`. Keep startup security assertions, certificate verification, exit code 1, zero protocol stdout, absence of `mcp.ready`, all eight tools, and existing authorization, lifecycle and provider boundaries unchanged. No live provider requests, retries, deadline increases, migrations, commits or publishing.

The starting checkout is clean at `d469edcaf069a65689024231e778a799c24465a7`. Its Git tree equals successful PR/branch head `94aa7f19c8d272311726ef91a0a72845ee052d4e` (`d2f9541ca74cc32dbfbd08a8e5127f598a1dd140`). The failed job used Ubuntu 24.04 image `20261025.353.1`; verify and container-smoke ran on distinct hosted runners.

## Initial evidence and hypotheses

The failed job reports only the final generic phase message. No `container_smoke.startup_mismatch`, `protocol_failed`, or `docker_failed` event was retained. This does not establish a transport-policy defect or resource contention. The old harness waits for child close before checking stderr; malformed JSON, secret detection, a readiness assertion, or a deadline exception can bypass its mismatch diagnostic. Nested cleanup can also replace an original failure.

Unproven hypotheses: Docker startup failure or warnings on stderr; a child exit deadline; an unexpected startup event/category; a cleanup error; fixture or host substitution problems. None is a demonstrated explanation of the original CI failure.

## Diagnostic plan

1. Inspect application startup, environment and PostgreSQL transport policy, TLS fixture, original smoke assertions and CI runner metadata.
2. Add bounded harness-only observations with fixed failure codes for startup, exit timeout, wrong exit code, missing startup event, wrong category, protocol stdout, invalid stderr, Docker command failure and cleanup failure. Retain original failures independently of cleanup.
3. Project stderr into allowlisted lifecycle events/categories and bounded counts/timings. Never emit raw messages, Docker errors, URLs, environment dictionaries, passwords, cursor secrets or provider credentials. Invalid stderr remains a failure.
4. Construct the intentionally invalid URL by changing URL components, and prove that the generated configuration is rejected by the unchanged connection policy before connection or readiness.
5. Compare focused rejection, full smoke (including cold reproducibility) and available CI evidence, without changing assertions or deadlines. Do not infer CI reproduction from a local pass.
6. Run the requested checks in the supported Node 24 environment using disposable owned PostgreSQL resources. Reconcile original containers/volumes and all 11 migration hashes.

## Repair policy

Only evidence-backed harness defects may be repaired in this slice. If a production defect is reproduced, specify a separate narrow repair first. An unresolved historical failure stays explicitly unresolved. Safe diagnostics must fail closed, preserve cleanup failures, and never turn an execution error into a successful security rejection.

## Results

### Harness changes

The affected paths are limited to:

```text
scripts/container-smoke.ts
packages/test-support/src/container-smoke-observation.ts
packages/test-support/test/container-smoke-observation.test.ts
docs/m9-c2b1v-container-smoke-diagnosis.md
```

The helper projects only approved lifecycle event names, readiness categories, numeric counts, exit status and relative timings. Child output remains private in bounded memory. Raw stderr, exception messages, Docker arguments and environment values never enter the diagnostic projection. Unexpected stderr and leaked configured secrets still fail the check. Startup-check failures and their owned runtime cleanup remain independent, including bounded nested aggregate classification.

Fixed failure codes distinguish child spawn failure, child exit timeout, wrong exit code, missing startup event, wrong failure category, unexpected readiness, unexpected protocol stdout, invalid stderr, output limits, Docker command failure and cleanup failure. The original 18-second child-exit and 20-second response deadlines remain unchanged.

The negative URL now uses `URL.hostname` and `searchParams.set`, with offline cases for localhost, IPv4 and IPv6 loopback. Tests prove credentials/database names containing `localhost` or `verify-full` are not rewritten, environment validation accepts the deliberately invalid transport setting, and the unchanged database policy rejects it synchronously. This fixes a demonstrated fixture-construction weakness; it does not explain the historical failure, whose generated credentials do not contain those substrings.

For focused diagnosis, after building the host workspaces and the final smoke image:

```sh
npm run build
node scripts/container-smoke.ts --transport-policy-only
```

This explicit diagnostic mode uses the existing final image and the same TLS fixture, environment, direct container launch and rejection assertions as the complete gate. It neither builds nor certifies that image. `npm run test:container` continues to run both reproducible builds and the entire original assertion set.

### Reproduction evidence

The first focused Linux-container check passed against the previously existing smoke image: exit 1, stdout count 0, `mcp.startup_failed` / `TRANSPORT_POLICY`, then stopping/stopped, without readiness. Child close was observed at 15,281 ms and the first startup-failure event at 14,993 ms. These timings include Docker launch/attachment and do not isolate application CPU time.

The failed hosted job and the successful PR job used the same Ubuntu image and identical source trees. The successful job reported release Node 24.22.0. The local host runs Windows, Node 24.12.0, npm 11.6.2 and Docker Desktop with a Linux backend. A local pass cannot establish why the hosted run failed.

### Local verification incident

The first separate `npm run verify` passed 713 tests. A subsequent full-gate attempt failed its unit phase with 700 passing and 13 failing bootstrap tests in `apps/mcp-server/test/main.test.ts`; its retained log contains 12 `ETIMEDOUT` occurrences. The workflow evaluation subsequently passed before the coordinator was stopped. These failed/partial runs remain retained privately and are not replaced by later successes.

During that execution the local Docker API returned an internal error, then bounded health probes timed out; Windows reported roughly 370–565 MB of available memory. This is contemporaneous local evidence, not proof of the hosted CI root cause. The existing restart authorization was used: graceful Docker Desktop restart timed out, then only verified Docker Desktop processes and the named `docker-desktop` distribution were restarted. No volumes or original containers were deleted. Resource reconciliation must succeed before claiming preservation has been verified. No assertions, retries, worker settings or deadlines were changed to address the incident.

### Final verification

Final source verification used an isolated LF checkout of the base plus the exact four-file patch. The original Windows checkout has 123 tracked text files containing CRLF; those unrelated baseline files were left untouched. Host Node 24.12.0/npm 11.6.2 and Docker client/server 29.1.3 (Linux AMD64 backend) were used. The normal two-worker integration configuration, assertions and deadlines are unchanged.

| Command / check                           | Final result                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run format:check`                    | Passed in LF verification checkout                                                                  |
| `npm run verify`                          | Passed: 714 tests in 28 files                                                                       |
| `npm run db:check`                        | Passed                                                                                              |
| `npm run verify:all`                      | Passed: 714 unit tests; 465 integration tests, 3 existing platform skips                            |
| `npm run eval`                            | Passed: 4 deterministic workflows                                                                   |
| `npm run eval:agent`                      | Passed: 6 offline scenarios                                                                         |
| `npm run eval:provider:test`              | Passed: 156 offline controls; overall live readiness remains blocked                                |
| Focused diagnostic regression tests       | Passed: 21                                                                                          |
| `npm run test:container`                  | Passed: both builds, artifact checks, eight tools, idempotency, EOF/signals and six safe rejections |
| Final focused transport-policy comparison | Passed against the freshly built image                                                              |
| `git diff --check`                        | Passed                                                                                              |

The recovered intermediate gates initially stopped at a new helper lint finding (unsafe spread of native `AggregateError.errors`, which TypeScript types as `any[]`). An explicit `unknown[]` variable fixed that without changing failure behavior. Both intermediate failures remain retained. The final full gate completed in 564.07 seconds; the complete container command completed in 498.25 seconds. Earlier failed runs are not counted as passes.

Both release builds produced local image ID `sha256:20f323b4032c10cb9b4acd77beb21cd20357f8bc8869dde14c4e1cac8f6a423f`, containing Node 24.22.0 and all 11 original migration artifacts. This is a local image ID, not a published registry digest. The full-run transport rejection closed at 4,186 ms, with exit 1, zero stdout, expected startup-failed/stopping/stopped events and no readiness. The final focused comparison against that same image closed at 4,944 ms and met the same assertions. These local successes do not reproduce or explain the original hosted failure.

The task-owned PostgreSQL fixture was retired after verifying zero remaining fixture databases, fixture/probe roles or other clients. Final inventories exactly match the original 30 containers and 51 volumes. All 11 migration hashes match the baseline and verification checkout; other worktree fingerprints match the saved baseline. No application, authentication, MCP contract, provider authorization, model/budget, migration or CI configuration files were changed.

Safe review evidence is separated from private raw logs, credential-bearing fixture configuration and the copied checkout. Review artifacts contain only fixed classifications, approved event names, bounded timing/count measurements, source hashes and test outcomes. No live provider requests or billable operations occurred. No commit, push or publication occurred.

## Conclusion and remaining uncertainty

The historical hosted `TRANSPORT_POLICY` smoke failure remains unresolved. Confirmed repairs address its missing diagnostic boundary, runtime cleanup error preservation and structural invalid-URL construction. No reproduced production defect justifies changing database transport or startup security policy. No deadline, retry, assertion or worker-count relaxation was introduced.

The next review step is a native Linux CI run of the reviewed patch. If the intermittent failure recurs, the child-result record will distinguish exit timeout, invalid stderr, exit status, missing/wrong startup events or readiness from Docker/cleanup failures without exposing raw error text. Do not interpret a local pass as a root-cause determination or as approval for live provider execution.
