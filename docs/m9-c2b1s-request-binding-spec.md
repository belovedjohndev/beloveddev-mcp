# M9-C2B1S: approved model request binding

Status: offline security repair; no live requests authorized.

## Execution ownership

A signed LiveGrant authorizes one canonical scenario in one synthetic fixture. The approved runner claims it once and privately creates an execution lease bound to the exact grant, invocation, opaque fixture, manifest digest, scenario ID and scenario digest. The lease also owns the exact model adapter and approved model/budget plan. Only the runner can mint leases and turns; exported verification functions cannot mint capabilities. Arbitrary prompts, clients and scenario objects are not fixture proof.

## Canonical turns and permits

The runner discovers the seven existing read-only tools through its fixture-owned MCP gateway. Its private conversation starts with the canonical scenario prompt and grows only with validated model output and actual completed gateway observations. Each turn receives an opaque, one-use capability binding the lease, model adapter and identifier, turn number, complete request digest, tool inventory, transcript and remaining execution budget. Live request snapshots are deeply frozen. No extra user messages or fabricated tool observations are accepted.

The provider claims the turn before credential resolution. It rejects missing, replayed or mismatched capabilities. A shared deterministic serializer binds the exact Responses request bytes, including instructions, output schema and output limit. prepareLiveRequest requires that claimed turn and its expected body digest before claiming a budget reservation. Its one-use HTTP permit retains invocation, grant, turn, body digest and reservation identity. The native transport independently checks these bindings, reservation state and freshness before HTTPS dispatch. Turn stages are issued, claimed, prepared, dispatched and completed. A rejected or timed-out turn is retired; the execution lease closes before cleanup. Revocation occurs after independent bounded cleanup attempts on success or failure.

Only the private runner issues subsequent turns, after the previous model result and any completed MCP observation. No automatic retries are added. Revoked grants, completed executions and stale turns cannot dispatch. Process-local replay protection is not durable; an atomic persistent replay store remains required before C2B2. These capabilities constrain trusted harness code; they are not a sandbox against arbitrary code executing in the same process.

## Approved test-cluster boundary

PostgreSQL 18 alone is insufficient evidence of a safe target. Trusted fixture setup requires an opaque ApprovedTestCluster, minted only after read-only verification of a literal loopback endpoint, explicit port, postgres control database, expected PostgreSQL system identifier and an exact operator-installed synthetic-cluster database comment. No URL query overrides are accepted. Expected identity and marker come from trusted test bootstrap, not model output or scenario arguments. The gate rechecks identity immediately before createTestDatabase. It never writes its own authorization marker or approves an arbitrary URL automatically. CI explicitly marks only its dedicated test service; local verification marks only a newly created, labeled, tmpfs PostgreSQL container. Existing database/role identity-checked cleanup remains unchanged.

## Limits, reports and remaining restrictions

The seven-tool allowlist, independent scenario oracles, all eleven migration artifacts, authentication and application semantics remain unchanged. The 4,096-token ceiling and current GPT-4.1 mini snapshot remain unchanged. Offline controls, token preflight and overall live readiness stay separate: the existing full-catalog estimate of 13,013 versus 4,096 remains blocked. Model deprecation, active-model selection, approved token/monetary limits and durable replay protection remain C2B2 owner decisions. No provider credentials or private request bodies enter reports.

## Verification

Regressions cover direct calls, wrong grants/models, prompt/history/tool/budget tampering, fabricated observations, capability and HTTP permit replay, completed/revoked execution, credential/HTTPS non-access on rejection, canonical approved execution, fixture-cluster rejection before mutations and ordinary offline evaluation. Run format:check, verify, db:check, verify:all, eval, eval:agent, eval:provider:test and git diff --check. Use an isolated LF checkout for baseline Windows CRLF failures, preserve every original resource and migration hash, and intercept all provider egress. No live API calls, commit or push.
