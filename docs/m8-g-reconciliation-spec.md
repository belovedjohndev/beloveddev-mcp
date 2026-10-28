# M8-G security reconciliation specification

Assessment date: 2026-10-26. Base: origin/main 2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7.
Main CI run 40309126177 passed verify and container-smoke. M8-G is not accepted.

## Preservation and isolation

The original checkout remains at 588caf5 with its existing dirty files, ignored
scanner artifacts and owner review ZIP. M8-H remains at its existing commit.
Neither worktree is edited, switched, reset, stashed, cleaned or pulled. Only
fetch/common Git metadata and the new feat/m8-g-security worktree are used.
Pre-work source hashes and report metadata are saved outside both worktrees in
an invocation-private temporary directory. Historical reports are not regenerated
in place or asserted to be current. No environment files or generated reports
are copied into tracked files. Existing Docker resources are protected; only
verification-owned disposable resources may be retired by their existing helpers.

## Inventory and disposition

| Class                          | Existing M8-G files                                                                                                                                                                  | Reconciliation                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: reusable after verification | infrastructure environment/logger/signed-cursor changes, signing-secret module; matching infrastructure tests; MCP server and contract/limits tests; bootstrap/lifecycle regressions | Main has no overlapping H edits in these files. Compare base blobs before porting each file. Preserve eight contracts, SDK boundary, safe envelopes, authorization and transactions.                                  |
| A: reusable after verification | security-check.ts, security/grype.json, security/toolchain.json, security-policy.test.ts                                                                                             | Review parsers, bounded execution, real inventory, database freshness, actual exit enforcement, and vulnerable/error fixtures. Keep unfixed High/Critical blocking and all local exception lists empty.               |
| B: adapt to M8-H               | package.json, CI, .env.example, .gitignore, README, architecture, implementation plan, local container guide                                                                         | Retain recovery command/lockfile, PostgreSQL 18 CI clients, administrative URL separation, all backup exclusions, H documentation and two-worker integration/cleanup behavior. Port only relevant security additions. |
| B: refresh and prove           | official Dockerfile                                                                                                                                                                  | First build current main unchanged. Resolve fresh official digests and compare finished release images. Prefer compatible stable remediation; no arbitrary package upgrades or major dependency changes.              |
| C: experimental                | Dockerfile.distroless; container-smoke.ts --distroless support                                                                                                                       | Keep separate, shell-free inspection, same current build/dependency graph and migration bytes. Do not promote merely because inventory is smaller.                                                                    |
| C: historical evidence         | security-triage.md/json, distroless-experiment.md/json                                                                                                                               | Preserve in original checkout. New dated assessment links to historical evidence and records refreshed results separately. Historical findings/counts are not current facts.                                          |
| D: excluded/unverified         | m8g-security-review.zip, all generated archives/SBOMs/logs, weak-key heuristics as entropy proof, scanner success before refreshed execution                                         | Preserve originals; never port ZIP/artifacts/secrets into Git. Heuristics reject obvious bad keys only, not prove entropy. Scans and compatibility must pass before acceptance.                                       |

## Intended affected structure

- Recovered files: packages/infrastructure/src/{environment,logger,signed-cursor,signing-secret}.ts and their tests; packages/mcp/src/server.ts and matching tests; apps/mcp-server/test/{main,lifecycle}.test.ts.
- Security tooling: scripts/security-check.ts, security/{grype,toolchain}.json, packages/test-support/test/security-policy.test.ts, .github/dependabot.yml.
- Adapted configuration: package.json, .github/workflows/ci.yml, .gitignore, .env.example, Dockerfile, Dockerfile.distroless, scripts/container-smoke.ts.
- Documentation: this specification, dated security assessment/evidence index, security.md, README.md, docs/{architecture,implementation-plan,local-stdio-container}.md.

No migration SQL, H1/H2 executor/recovery code, test resource-cleanup code,
permission, tool schema, domain rule, runtime TLS, readiness, lifecycle deadline,
response bound or automatic retry changes are intended. Administrative/native
recovery tools stay outside the MCP runtime.

## Verification and stopping

Use locked npm installation without hooks; audit production and full dependency
trees. Build current-main release and supported official updated candidates,
record immutable bases and final image identities, and smoke each changed runtime
with all tools, TLS/readiness, note/audit idempotency, EOF and signals. Inventory
the complete final image using pinned Syft and scan with pinned Grype/current
validated data. Revalidate every High/Critical advisory, including the five old
ones; record package/version, ecosystem, layer/dependency, vendor status, fix,
remediation and result. Preserve all findings without blanket suppression or VEX.

Run format, verify, verify:all, db:check, test:container, no-drift generation and
diff checks. H1 lock/ledger/credential and H2 snapshot/restore/readiness/idempotency
integration tests remain mandatory with PostgreSQL 18 native clients. Preserve
existing test concurrency and timeouts; do not overlap cold builds with the
shared-cluster reliability run. Stop with a candid report if scanner execution,
required data, compatibility, or supported remediation is blocked. No commit,
push, merge, release approval or production deployment occurs here.
