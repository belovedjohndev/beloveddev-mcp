# Local stdio security policy

M8-G is under source review, not production approval. The dated
[reconciliation specification](m8-g-reconciliation-spec.md) records recovered
changes and preservation requirements. Fresh results belong in the dated review;
October 19 scanner reports in the original checkout are historical evidence.

## Threat model and protected assets

Treat model-controlled MCP arguments and stored project/opportunity content as
untrusted. Protect tenant confidentiality, authorization, audited note integrity,
idempotency, cursor integrity, database credentials, private signing keys and
backup archives. The OS account, Docker daemon, launcher, compiled image and
operator configuration remain trusted. A compromised launcher can select another
configured tenant/user pair. Environment-based local identity is not independent
authentication and does not authorize a remotely shared MCP service.

All eight tool inputs remain strict SDK-validated schemas; identity and tenant
selection cannot come from arguments. Active membership is revalidated by the
existing context resolver and application permissions precede protected repository
work. NODE_ENV=production still rejects local authentication. No HTTP/OAuth mode,
new tool, mutation retry, or authentication bypass is introduced.

Runtime PostgreSQL credentials must satisfy M8-D least-privilege readiness and
verified remote TLS. They are not protected by RLS: a compromised trusted runtime
credential is not a tenant boundary. M8-H1 migration and M8-H2 recovery credentials
remain separate, powerful administrative inputs. Startup never migrates or grants
privileges. Native PostgreSQL 18 recovery clients and all-tenant backup artifacts
stay outside the MCP runtime image. See [database operations](database.md) and
[backup/recovery](recovery.md) for advisory locks, ledger verification, snapshots,
restore drills, uncertain outcomes, file protection and operator decisions.

## Reproducible gates

Use supported Node 24/npm 11 and a Linux Docker engine:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run security:dependencies
npm run security:verify
npm run test:container
npm run security:image
```

The production audit covers the locked MCP workspace dependency closure,
including optional/peer dependencies, excluding development-only dependencies.
Run a full-tree audit separately when reviewing developer/build risk. Both retain
all findings; High/Critical blocks. Registry errors, missing lockfiles, malformed
reports and inconsistent subprocess exit statuses fail closed. Never use an
unreviewed forced audit fix or major upgrade merely to clear the gate.

Syft 1.54.1 and Grype 0.120.1 are digest-pinned in security/toolchain.json; the
runtime contains neither scanner. security:image accepts explicit local image references, resolves each immutable
identity and exports each complete image. A docker-archive:<path-to-.tar> reference
can assess a complete already-exported image when daemon import is unavailable;
its scan never substitutes for packaged runtime/reproducibility verification.
Catalog config hashes are checked, and daemon exports must match every ordered
filesystem layer digest because OCI-to-Docker config normalization can change
config IDs without changing filesystem content. Multiple references share one database
provisioning context; every scan still checks updates and database validity. Syft
catalogs its Docker archive offline to Syft JSON. OS inventory and installed MCP
SDK, Zod and pg npm packages are mandatory; selected development tools are
forbidden. This is an installed final-image scan, not a lockfile-only assessment.

Before checking Docker, pulling scanner images or provisioning a database cache,
the pure validateGrypePolicy parser validates the complete Grype configuration.
Both the top-level policy and nested db object are strict: unexpected fields are
rejected, not stripped. Every approved value is required, including the 30s update
availability timeout and 5m download timeout. Changing or adding scanner settings
requires an explicit guard/test review; the original approved JSON is passed to
Grype. Pinned toolchain validation remains separate and unchanged.

Grype scans that SBOM against current advisory data. security/grype.json retains
High/Critical enforcement including unfixed findings, empty local ignore/exclude/
VEX lists and no fix-availability filter. The wrapper checks actual exit status
as well as report contents and rejects emitted ignored matches. Scanner built-in
rules are versioned upstream behavior, not locally authorized exceptions. The
validated database must be no older than 120 hours and cannot be future-dated by
more than five minutes. Update checks run every scan and failures cannot silently
reuse a stale cache. Correct host time and advisory-service availability matter.

Each run uses a unique ignored .security-reports/run-* directory, recording exact
image/archive identities, full SBOM, vulnerability JSON, scanner exit and logs.
These are point-in-time metadata, not a claim of no unknown vulnerabilities.
Terminal diagnostics contain bounded phases/severity counts. Per-command JSON
records stage, sanitized command/arguments, actual exit/signal or an unknown exit
on deadline, elapsed time, bounded stdout/stderr and a failure category. Public
diagnostics redact credential markers, URL credentials/query strings, PEM blocks
and workspace paths. They never receive runtime SQL, environment dumps or MCP
payloads; this is not a universal arbitrary-content sanitizer. Never commit generated
reports, archives, env files, backups or review ZIPs. CI retains available JSON
artifacts for seven days, not image archives, fixtures or raw diagnostic logs.

Scanner containers are nonroot, read-only, capability-free, memory/CPU/PID bounded,
and use an invocation-owned cache volume. Scanner processes have two CPUs and
2 GiB memory. Database provisioning has a separate twenty-minute deadline;
matching and cataloging retain ten-minute deadlines. Downloads retain Grype
transport deadlines. A successful update is followed by explicit database status
and hash/freshness enforcement during matching. Timeout is an operational failure,
never a vulnerability result.
A restricted initializer changes ownership only on that new cache. No application
or PostgreSQL volume is mounted. Cleanup touches only invocation-owned resources;
it does not restart Docker, prune resources or delete an existing database.
Unavailable infrastructure fails the gate and can require operator cleanup.

## Enforcement and CI

security:verify uses real vulnerable production/optional npm fixtures, a genuinely
vulnerable development-only fixture, installed vulnerable npm without a lockfile,
missing lockfiles, unavailable registries/database updates and malformed SBOMs.
It also invokes a genuinely missing scanner executable, rejects a missing local
image and scans an actually installed clean npm fixture. Pinned scanner executable
versions and Docker Linux architecture are checked before provisioning.
Unit tests additionally reject empty inventories, stale/invalid metadata,
suppressions and false zero exits. Expected fixture failures prove enforcement;
they never turn a failing production scan into success.

CI preserves M8-H PostgreSQL 18 client installation, dedicated migration URL,
backup/restore integration tests and generation-drift verification. Recovered
security changes pin Actions by full verified commit, disable checkout credential
persistence/install hooks, retain read-only permissions, bound jobs and retain
failure evidence. Production and full-tree npm auditing are required candidate checks;
the container job builds, smokes, proves scanner enforcement, then scans the exact
artifact. Owners must configure required branch checks; this task does not change
repository settings. Dependabot proposes weekly npm, Action and Docker updates.
Manually review scanner/BuildKit pins at least monthly and after relevant vendor
advisories. A digest pin does not apply future patches automatically. BuildKit/image-import failures are operational failures, not clean scans;
release builds have finite fifteen-minute command budgets and retain sanitized
public build-output tails on error/deadline. Runtime Docker failures retain only
safe phases because their arguments may contain secrets.

## Keys, logs and safe failures

Generate cursor keys with crypto.randomBytes(32).toString('hex') and store them
in protected runtime-only configuration. Startup and codec construction share
checks for at least 32 characters, at most 1024 UTF-8 bytes, no whitespace/control
characters, at least eight distinct characters, no known placeholder and no short
repeating pattern. These reject obvious bad configuration; they do not prove
entropy. Persist keys across restarts; deliberate rotation invalidates cursors.

Invocation success logs at info, expected application failures and RATE_LIMITED
at warn, INTERNAL_ERROR at error. One invocation record preserves requestId,
trusted actor/tenant, tool, duration and safe category. Fixed failureKind values
identify admission/context/execution/output/size/deadline phases without copying
raw errors. Failures remain visible at LOG_LEVEL=warn; silent intentionally
suppresses ordinary logs. SDK protocol/schema failures remain SDK-owned.

A throwing invocation sink cannot replace a result, strand capacity or fall back
to protocol stdout. Known error objects/SQL/driver fields are redacted at root and
one nested level as defense in depth, not arbitrary-depth content sanitization.
Log only selected safe metadata. A response deadline/disconnect does not prove
rollback; a note may commit without delivery. Recover uncertainty only through an
explicit same-payload, same-key retry under the same tenant/author. M8-C lifecycle,
M8-D readiness, M8-E limits and transactional audit guarantees remain unchanged.

## Limitations and operator responsibilities

No scan alone proves practical exploitability or non-exploitability. Assess exact
package versions, source/binary presence, bundled copies, call paths and vendor
status. no-dsa/wont-fix is not proof of non-applicability. Historical findings must
be revalidated. Distroless stays experimental until compatibility and current
scan results justify separate review; removing a package record is not a patch
for embedded code. Other architectures require their own verification.

Retain unresolved findings and block release when there is no supported safe fix.
Any specific VEX statement or risk exception requires evidence and separate owner
approval; none is implemented here. Owners remain responsible for secret/OS/
launcher protection, patch ownership, required CI checks, least-privilege grants,
protected backups, restore cadence, encryption/off-site retention, incident
response and deployment-specific recovery objectives. M8-G acceptance is distinct
from production approval, and local stdio is not a remote authentication profile.

OS package matches and Node-bundled native components require separate review.
Inspect actual library/module/symbol presence and supported vendor source/fixes;
a package-level match does not prove exploitability, and a missing match, version
suffix, no-dsa or wont-fix status does not prove safety. Keep disputed findings
blocking until evidence and owner/vendor decisions satisfy the unchanged policy.
