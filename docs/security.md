# Security model and release limitations

This disclosure applies to main baseline
[2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7](https://github.com/belovedjohndev/beloveddev-mcp/commit/2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7),
reviewed on 2026-10-28. It describes a local stdio MCP subprocess. It is not a
security certification, vulnerability-free claim, or production deployment approval.

## Local trust and identity

Trust the operator's OS account, host, installed application/Node binary, MCP
client, launcher configuration, protected environment files and database
administrators. One process uses one operator-configured tenant/user pair.
MCP_LOCAL_TENANT_ID and MCP_LOCAL_USER_ID are assertions, not independent proof of
identity. A compromised launcher can change them and act as another active
principal it can configure. Environment files must be protected by Unix account
permissions or appropriate Windows ACLs; POSIX modes alone do not prove Windows
file isolation. Existing process variables override selected env-file values.

Only MCP_AUTH_MODE=local exists. NODE_ENV=production rejects that mode rather
than offering a bypass. Both identity IDs must be configured or both omitted;
without a principal, tools return UNAUTHENTICATED. The context provider rechecks
active tenant, user and membership for each valid invocation and derives
permissions from the stored role. These checks are point-in-time, not a
transaction-held revocation lock.

Tool inputs are strict and have no tenantId, userId, role, permissions or
requestId selector. Unknown identity fields are rejected by the SDK before
application execution. The application generates request IDs and checks required
permissions before protected resource work. Owner/member get all five V1
permissions; viewers get only profile:read, projects:read and opportunities:read.
Resource IDs do not establish access: cross-tenant lookups return NOT_FOUND and
foreign list filters return empty results.

Local stdio needs no HTTP listener or OAuth. Do not bridge this fixed-principal
subprocess to untrusted remote users. Remote hosting would require a separately
approved identity, transport, session and tenant-selection model; it is not an
implemented feature or an automatic next requirement for a local-only release.

Sources: [environment validation](../packages/infrastructure/src/environment.ts),
[context provider](../packages/infrastructure/src/local-request-context.ts),
[active membership query](../packages/infrastructure/src/postgres/membership-repository.ts),
[permission mapping](../packages/application/src/request-context.ts), and
[strict tool schemas](../packages/mcp/src/schemas.ts).

## Database and secret boundaries

Use separate restricted runtime and administrator credentials. Runtime readiness
checks PostgreSQL 18, database/role identity, committed migration history,
reviewed schema and effective privileges under a ten-second deadline. It rejects
superuser/ownership and other dangerous effective grants, including PUBLIC,
inherited and SET ROLE paths. The runtime needs documented reads plus INSERT on
project_notes/audit_logs; it has no general update/delete, migration, grant or
audit-read API. Startup neither repairs schema nor provisions privileges.

Remote database connections require sslmode=verify-full with certificate-chain,
hostname and TLS 1.2+ verification. Optional DATABASE_TLS_CA supplies private trust
roots. Plaintext is allowed only for explicit loopback; a loopback tunnel is not
proof the actual destination is local. URL and ambient PG* overrides cannot
replace the explicit endpoint/session policy. See the [database guide](database.md#m8-d-connection-and-readiness-policy)
for the exact privilege and transport contract.

Tenant isolation uses application authorization, explicit tenant SQL predicates
and composite ownership foreign keys. **There is no RLS.** Stolen runtime
credentials can read granted data across tenants and append directly to notes
and audits. Constraints enforce relationships, not the caller's business
permission. Database administrators remain trusted and can change grants/schema
after readiness. Startup checks are not continuous monitoring.

Keep administrator, migration, test and backup/restore secrets out of MCP
launchers, images, command arguments and logs. Use a protected runtime-only env
file or equivalent trusted process injection. .env.example contains public local
example credentials, not a deployable secret. Do not commit .env files, backups,
real portfolio/client data or private scan artifacts. Node env-file loading is
configuration delivery, not a secret-management service.

The [recovery runbook](recovery.md) requires private passfiles/CA files, trusted
PostgreSQL 18 binaries and protected artifacts. Backup compression is not
encryption; a digest in a mutable manifest is not authenticity. Whole-database
backups contain every tenant's data and require independent storage/retention/
access decisions. The CLI never accepts a production replacement destination.

## MCP, writes and failure behavior

All eight registrations use strict input and success-output schemas. Protocol,
unknown-tool and argument-schema failures are SDK-owned and precede application
context/use-case execution. Application failures use safe codes and a generated
request ID; raw SQL, secrets and stack traces are not part of tool responses.
Only create_project_note writes, and its note/audit commit is atomic. An exact
same-tenant/author/key retry returns the original result without another audit.
Changed payload reuse returns CONFLICT. No automatic mutation retries exist.

Output validation, timeout or delivery failure can happen after commit. Clients
must preserve the exact original payload and idempotency key; an error or missing
response is not rollback evidence. Idempotency is scoped effect protection, not
an exactly-once delivery or cancellation guarantee. Runtime audit metadata contains
only projectId/category; note content and keys are excluded. Audit rows are not
cryptographically signed or protected from a trusted administrator.

Admission is bounded to eight concurrent application invocations, a 30-second
response deadline and a 1 MiB serialized success result. These limits do not bound
SDK request framing, all Zod validation resource use, host memory/CPU or total
PostgreSQL work. Timed-out work may continue and retains admission until settled.
SIGINT/SIGTERM, EOF and fatal database errors use one bounded shutdown path;
forced termination cannot run cleanup. See [architecture](architecture.md).

## Logging limitations on main

Pino writes structured logs to stderr and stdout is reserved for MCP protocol
traffic. Known credential keys and selected config/environment/header fields are
redacted. This is a bounded field policy, not an arbitrary-depth content scanner.
Use static messages and selected safe metadata. Never put credentials, note
content, opaque keys, raw errors or full request/response bodies into free-form
messages or unknown fields.

Main's shared invocation boundary calls logger.info for both success and failure;
LOG_LEVEL=warn therefore hides invocation failure records. The M8-G severity and
invocation logging-failure repair is not merged. Do not describe it as a main
control. [Logger source](../packages/infrastructure/src/logger.ts) and
[invocation source](../packages/mcp/src/server.ts) are the reference, not the
existence of a successful local launch.

## Known security findings and separate draft work

As checked on 2026-10-28, [PR #2](https://github.com/belovedjohndev/beloveddev-mcp/pull/2)
is open, draft and unmerged. Its security-scanner enforcement, dependency patches,
logging repair, and alternative-image investigations are not on this baseline.
Main's [CI definition](../.github/workflows/ci.yml) has functional verification and
container smoke jobs; it does not have the draft's mandatory security scanner jobs.
Do not run or document security:verify/security:image as available main scripts.

A fresh npm audit --json against this baseline lockfile on 2026-10-28 exits 1 and
reports **two High package findings**: runtime Zod and development Vite. These are
package-level counts, not two unique advisory IDs or a container scan. The report
includes [Zod constrained-collection memory exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
and [a High Windows Vite launch-editor finding](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
alongside other Vite advisories. This disclosure does not adjudicate practical
reachability or apply fixes. Dependency changes belong in the separate reviewed
security workflow; a passing verify command does not clear the audit.

M8-G's retained image assessment reports unresolved High/Critical release-image
findings and a separate concern about Node's bundled zlib. Those scans identify
specific draft artifacts; their counts must not be attributed to main's different
pinned Bookworm image. No fresh M9 container scan was run, and no zero-vulnerability
claim is made. The distroless experiment is not main's image or production-approved.
Installed-package matches and an unobserved vulnerable path are neither exploit
proof nor grounds to suppress a finding.

## Production decisions still required

- Resolve supported dependency/native-runtime remediation and review exact final
  artifacts through the unchanged security policy before promotion.
- Approve the intended deployment/trust profile. No production remote MCP
  authentication, identity provider or multi-user service is implemented.
- Assign vulnerability maintenance, secret rotation, monitoring, incident and
  operational ownership. Current readiness is not an availability SLA.
- Define recovery objectives, backup frequency/retention, protected encrypted
  off-site storage, restore/cutover authorization and incident responsibility.
  Logical restore drills do not implement WAL/PITR, HA or cluster-global recovery.
- Review remaining transport/input resource limits and host/container isolation.

Functional, tenant, concurrency and recovery tests are valuable evidence with
specific scope; they do not approve production deployment. See the
[case-study verification ledger](case-study.md#verification) for exact-commit
results and [implementation plan](implementation-plan.md) for unfinished work.
