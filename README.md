# BelovedDev MCP

A TypeScript MCP server that gives an AI client structured access to a developer's
project context, portfolio evidence, blockers, and freelance opportunities. The
model chooses and explains tool results; application code owns permissions,
tenant scope, deterministic evaluation, and the one audited write operation.

Freelance project context often lives across notes and project histories. This
project explores a narrower alternative to a general-purpose agent: eight tools
over explicit PostgreSQL records, with bounded results and defined failure and
retry behavior. It does not scrape job sites, submit proposals, or call an LLM.

**Status:** all eight V1 tools are implemented. Local stdio packaging and M8-H
migration/recovery work are merged at baseline
[2e56b7a](https://github.com/belovedjohndev/beloveddev-mcp/commit/2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7).
M8-G security maintenance remains in [draft PR #2](https://github.com/belovedjohndev/beloveddev-mcp/pull/2)
and is not included here. Known dependency and release-image findings remain;
production deployment is not approved. See the [security disclosure](docs/security.md).

## Start with the engineering evidence

- [Technical case study](docs/case-study.md): decisions, trade-offs, evidence, and a concise portfolio summary.
- [Architecture](docs/architecture.md): six diagrams and links to the actual boundaries.
- [Tool reference](docs/mcp-tool-contracts.md): exact inputs, outputs, permissions, and synthetic examples for all eight tools.
- [Database operations](docs/database.md) and [recovery runbook](docs/recovery.md): separate administrative workflows.
- [Container operating guide](docs/local-stdio-container.md): local stdio packaging and runtime restrictions.

## Architecture and stack

```mermaid
flowchart TD
  Client[AI client] --> MCP[MCP server and strict schemas]
  MCP --> Application[Authorized application use cases]
  Application --> Domain[Deterministic domain rules]
  Application --> Ports[Explicit repository ports]
  Ports --> Adapters[PostgreSQL adapters]
  Adapters --> PostgreSQL[(PostgreSQL 18)]
```

Node.js 24, strict TypeScript/ESM, npm workspaces, Zod, MCP TypeScript SDK v2,
PostgreSQL 18, Drizzle ORM/Kit, node-postgres, Pino, Vitest, Docker, and GitHub
Actions. The composition root wires concrete dependencies explicitly; domain and
application packages do not import the MCP SDK or Drizzle. There is no generic
repository base, DI container, vector database, or agent framework.

## Eight implemented tools

| Tool                    | Purpose                                                     | Permission             | Writes |
| ----------------------- | ----------------------------------------------------------- | ---------------------- | ------ |
| get_profile             | Read the current tenant's developer profile                 | profile:read           | No     |
| list_projects           | Filter and page projects                                    | projects:read          | No     |
| get_project             | Read bounded project context, evidence, blockers, and notes | projects:read          | No     |
| search_project_evidence | PostgreSQL full-text search with structured filters         | projects:read          | No     |
| get_blockers            | Page open blockers, oldest first                            | projects:read          | No     |
| list_opportunities      | Filter and page stored opportunities                        | opportunities:read     | No     |
| evaluate_opportunity    | Run versioned, deterministic fit rules                      | opportunities:evaluate | No     |
| create_project_note     | Append one note and its durable audit atomically            | project_notes:create   | Yes    |

Owners and members have all five permissions. Viewers have the three read
permissions, so they cannot evaluate opportunities or create notes. Tool arguments
never supply tenant or actor identity. The [tool reference](docs/mcp-tool-contracts.md)
defines output shapes, pagination, error boundaries, and annotations.

## Requirements

- Node >=24.12.0 and <25; .nvmrc selects major 24.
- npm >=11 and <12; packageManager records npm@11.6.2.
- Docker Engine/Desktop using Linux containers and Compose v2 for local PostgreSQL/container tests.
- PostgreSQL 18 native pg_dump and pg_restore for recovery operations and recovery integration tests; see [recovery prerequisites](docs/recovery.md#prerequisites-and-trusted-inputs).

## Windows checkout line endings

The repository's .gitattributes explicitly checks out its supported TypeScript,
JavaScript, JSON, Markdown, YAML and named root configuration/build files as LF,
matching Prettier. This works with Windows core.autocrlf=true; developers do not
need to disable or change system-wide Git settings. Editors should also save
these supported files as LF.

After this policy is available on the selected revision, create a fresh clone or
new worktree at that revision, then run npm ci, npm run format:check and npm run
verify there. Attributes govern checkout; adding the policy does not rewrite
files already materialized as CRLF. For an existing dirty checkout, preserve its
work and prefer a fresh checkout containing the policy rather than automatically
resetting or overwriting files. No repository-wide formatter pass is required.

The last attributes rule keeps /packages/database/migrations/** as -text. Do not
normalize/regenerate applied SQL, migration journal or historical snapshots: their
exact committed bytes are used for integrity/readiness checks. This exception
also overrides the JSON text rule for migration metadata. Certificates and key
fixtures are not included in the new text rules.

## Local setup

Run from the repository root. Keep administrative and runtime configuration
separate; the example Compose login is a local-only superuser and is rejected by
MCP startup. Migrations create schema, not a populated portfolio or a login flow.

1. Install/build: npm ci, then npm run build.
2. Copy .env.example to a protected local administrator file, for example
   .env.admin (PowerShell: Copy-Item .env.example .env.admin; POSIX: cp .env.example .env.admin).
   Review its local credentials, port, DATABASE_MIGRATION_URL, and TEST_DATABASE_URL.
   Do not reuse its public example password outside isolated local development.
3. Start local PostgreSQL and run the separate administrative migration CLI:

```sh
docker compose --env-file=.env.admin up -d --wait
node --env-file=.env.admin scripts/migrate.ts
```

4. As the database administrator, provision the exact restricted runtime role from
   the [database guide](docs/database.md#migrations), including PUBLIC revocations
   and note/audit INSERT grants. No grants run at application startup.
5. Create a separate protected .env for the MCP process. The following is a
   configuration template: replace the password, generate a private cursor secret,
   and align the port with Compose. Do not copy administrator/test/recovery
   variables into it.

```dotenv
NODE_ENV=development
LOG_LEVEL=info
DATABASE_URL=postgresql://beloveddev_runtime:REPLACE_WITH_URL_ENCODED_PASSWORD@127.0.0.1:5432/beloveddev
MCP_AUTH_MODE=local
MCP_CURSOR_SECRET=REPLACE_WITH_A_NEW_PRIVATE_RANDOM_SECRET
# Set both IDs to existing active records, or omit both:
# MCP_LOCAL_TENANT_ID=
# MCP_LOCAL_USER_ID=
```

Generate the cursor secret separately, then store it only in protected configuration:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

There is no public seed/import/onboarding command. An operator must provision
real tenant/user/membership/profile/project records through an approved
administrative workflow. With both principal IDs omitted, the server can become
ready but tools return UNAUTHENTICATED. A profile lookup with no profile returns
NOT_FOUND. The examples below and in the reference are synthetic, not seeded data.

If 5432 is occupied, choose a free POSTGRES_PORT and update the administrative,
test, and runtime URLs consistently. The [assigned-port example](docs/database.md#real-postgresql-integration-tests)
avoids touching existing services. Changing initialization credentials does not
change an existing database volume. Stop this local Compose instance with
docker compose --env-file=.env.admin down; omit volume-deletion flags.

## Direct Node MCP launcher

After building, the exact supported repository-root launch is:

<!-- mcp-client-command -->

```sh
node --env-file=.env apps/mcp-server/dist/main.js
```

The selected environment file is required. A missing file fails in Node before
bootstrap. Existing process environment values override file values; remove stale
administrator exports before launch. Logs use stderr; stdout is exclusively MCP
protocol traffic. npm start is a terminal convenience, not a supported MCP-client
launcher, because npm lifecycle banners use stdout.

MCP clients invoke Node directly with absolute paths. Each argument is one string;
spaces need no embedded shell quotes. Replace these example installation paths:

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": [
    "--env-file=C:/Protected/BelovedDev MCP/runtime.env",
    "C:/Installed/BelovedDev MCP/apps/mcp-server/dist/main.js"
  ]
}
```

On POSIX, use absolute executable/configuration/entry-point paths such as
/usr/bin/node and /srv/BelovedDev MCP/apps/mcp-server/dist/main.js. Do not add a
shell or npm wrapper. The client owns subprocess startup/shutdown. Close stdin,
send SIGINT/SIGTERM, or use Ctrl+C in a terminal; allow at least 15 seconds for
shutdown. Forced termination cannot run cleanup.

## Example AI-client interactions

These are suggested requests to a connected client, not claims about a bundled
chat UI or model integration:

- "List my active projects, then show the open blockers for the selected project."
  The client can use list_projects, get_project, and get_blockers.
- "Find evidence of PostgreSQL transaction work and explain which records support it."
  The client can use search_project_evidence and cite the returned records.
- "List reviewing opportunities and evaluate this stored opportunity against my profile."
  The client can use list_opportunities and evaluate_opportunity. Evaluation is
  deterministic v1 code, not LLM scoring, and does not persist a decision.
- "Append this decision to the selected project."
  create_project_note requires project ID, category, exact content, and an explicit
  idempotency key. The client must retain that key and payload if delivery fails.

See [eight concrete invocations and responses](docs/mcp-tool-contracts.md).

## Security and failure behavior

Local stdio is an operator-controlled subprocess. The OS account, installed code,
launcher, environment files, and database administration are trusted. Configured
tenant/user IDs are assertions, not independent authentication. Active tenant,
user, and membership are rechecked on every invocation; permissions come from the
stored role. A compromised launcher can change the principal.

Runtime startup verifies PostgreSQL 18, configured identities, committed migration
history, reviewed schema signature, and effective least privileges within ten
seconds. Remote database endpoints require sslmode=verify-full with certificate
and hostname verification; plaintext is limited to explicit loopback. These are
startup checks, not continuous administrator monitoring. There is no RLS: stolen
runtime credentials can access granted data across tenants.

Strict SDK schemas reject malformed input before application work. Application
failures return safe codes and request IDs; successful DTOs are validated before
release. There are eight application slots, no queue, a 30-second response
deadline, and a 1 MiB serialized-success limit. These do not bound SDK input
framing, cancel SQL, or guarantee response delivery.

SIGINT, SIGTERM, EOF/transport closure, and fatal database connection errors share
one idempotent shutdown path: stop admission, allow up to ten seconds for admitted
work, attempt transport and pool cleanup independently, and enforce a 15-second
total deadline. A timeout, disconnect, output-validation error, or lost COMMIT
acknowledgement does not prove a note rolled back. Retry explicitly under the
same tenant/user with the original key and identical payload; a committed retry
returns the original note with created=false and adds no audit. No automatic
mutation retry or process restart is implemented.

Only local auth mode exists; NODE_ENV=production rejects it. There is no HTTP
listener, OAuth, or approved remote multi-user deployment. Main's invocation logs
use info for both success and failure; M8-G severity/scanner repairs are unmerged.
Read the [full security disclosure](docs/security.md) before evaluating release readiness.

## Database migration and recovery

The separate migration CLI holds a database-scoped session advisory lock while
checking the ledger, applying committed Drizzle migrations, and verifying the
complete history. Startup never migrates. Locking is cooperative; arbitrary
administrator SQL can bypass it. See [migration operations](docs/database.md#m8-h1-administrative-execution-policy).

The separate recovery CLI uses explicit administrator credentials and PostgreSQL
18 native clients. It creates new private logical-backup artifacts, validates the
entire archive, and drills restoration only into generated disposable databases.
Drills compare complete table digests/schema/ledger and restricted readiness;
they never replace an existing production database. A mutable checksum manifest
is integrity metadata, not independent authenticity. RPO/RTO, scheduling,
retention, encryption/off-site storage, cutover, and incident ownership remain
operator decisions. Commands and limitations are in the [recovery runbook](docs/recovery.md).

## Testing and verification

```sh
npm run format:check
npm run verify
```

verify runs formatting, type-aware ESLint, strict TypeScript/build, and Vitest
without PostgreSQL. Real database tests use an explicit TEST_DATABASE_URL on a
dedicated test instance with CREATE DATABASE/ROLE, never a production endpoint:

```sh
npm run verify:all
npm run test:container
```

verify:all adds migration metadata checks and PostgreSQL integration tests.
Container tests build from a source-only snapshot and exercise all eight tools
against disposable TLS PostgreSQL. CI also checks migration-generation drift.
Tests cover permissions, tenant predicates/constraints, signed pagination,
concurrency, exact retries, audit rollback, readiness, disconnects, and recovery.
See [verification evidence and its limits](docs/case-study.md#verification).
Passing functional tests is not a clean vulnerability scan or deployment approval.

## Deterministic workflow evaluations

M9-B composes existing MCP tools against synthetic fixtures on a dedicated test
PostgreSQL instance. Supply TEST_DATABASE_URL with CREATE DATABASE/ROLE privileges
(the same isolated provisioning configuration as integration tests), then run:

```sh
npm run eval
```

The four workflows check evidence-grounded opportunity results, tenant/permission
refusals, explicit note retries and audit reconciliation, and safe unavailable
resource handling. A strict custom reporter writes a new machine-readable JSON
report under ignored .evaluation-reports and exits nonzero for failed, incomplete,
skipped, or cleanup-failed scenarios. Reports contain allowlisted progress and
failure codes, never database URLs, raw errors, or request/response content.
Only invocation-created databases/roles are cleaned up; never use production
credentials or endpoints for fixture provisioning.

These are scripted workflow regressions, not evidence that a live LLM selected
tools or reasoned correctly. No LLM provider is called. The SDK transport is
in-memory; packaged stdio and operational checks remain separate. See the
[evaluation specification](docs/m9-b-evaluation-spec.md) for exact expectations,
negative controls, cleanup, reporting, and limitations.

## Offline agent-harness validation

M9-B validates scripted workflows. M9-C1 validates the infrastructure for future
independent model decisions, entirely offline. M9-C2 is future real-model work;
no LLM performance results are claimed here.

With the same dedicated synthetic TEST_DATABASE_URL provisioning configuration:

```sh
npm run eval:agent
```

Six scenarios cover evidence retrieval, opportunity selection, score/risk
interpretation, unavailable information, tenant boundaries and mutation refusal.
The gateway discovers tools using the existing SDK and exposes seven read-only
tools. It validates arguments/results using existing strict schemas. Existing
trusted context and permissions still apply. Project-note writes are never
exposed to the adapter or dispatched by this gateway; these fixtures seed no notes.

Model turns, tool selections, bytes, elapsed time and simulated token usage are
bounded. Expected claims stay outside model requests and must match both fixture
oracles and completed MCP observations. Reports distinguish selected, rejected,
dispatched and completed calls. A blocked write fails; it is not independent
refusal. Reports omit prompts, arguments, credentials and returned domain facts.
Artifacts use .evaluation-reports/agent-run-*.json; failures exit nonzero.

All live adapters are rejected in C1, including CI. There is no environment flag
that enables a provider. Offline counters are simulated, and structured-claim
checks do not establish arbitrary prose grounding. Future live execution needs
a reviewed adapter, explicit owner opt-in outside CI, private credential
injection and provider-side usage/cost limits. See the
[M9-C1 specification](docs/m9-c1-agent-evaluation-spec.md).

## Mock OpenAI provider boundary

M9-B is scripted deterministic MCP workflow evaluation. M9-C1 is offline agent-harness
validation. M9-C2A adds a mock-tested OpenAI Responses API boundary. M9-C2B is future,
separately authorized live-model evaluation. None of these mocked results measures
actual LLM accuracy, reasoning quality or arbitrary prose grounding.

```sh
npm run eval:provider:test
```

The test-only adapter uses an injected mock HTTP transport and estimator, validates
strict request/response profiles, and normalizes structured actions into the same
seven-tool read-only gateway. Existing authorization and tenant isolation remain
authoritative; project-note writes cannot be dispatched by the evaluation gateway.
No provider-native execution path, new dependency or production change is added.

Responses usage fields are labeled provider_reported, with mock provenance in the
provider-control report; C1 simulated counts and offline reports remain distinct.
Conservative per-invocation call/token/cost reservations precede requests and are
not recycled. Missing/late usage is incomplete, never evidence of zero charges.
Mock token estimates and fictional test pricing do not verify live costs.

Both existing evaluation commands and ordinary CI remain offline. No API key or
environment flag enables live execution. Network transports are rejected before
credential resolution; no fetch implementation or live launcher is shipped.
Provider keys must stay outside source, model inputs and reports. Reports under
.evaluation-reports/provider-controls-*.json contain safe control counts and fail
nonzero on missing, skipped or failed controls.

Before C2B, review the exact model snapshot and supported text-only response profile,
model-compatible token estimation, verified pricing (including cache-write rates),
explicit owner approval and monetary/call/token ceilings, account-level billing
controls, private secret injection and a network transport with redirect/deadline
controls. Local cancellation and reservations cannot guarantee final provider billing.
See the [M9-C2A specification](docs/m9-c2a-provider-spec.md) for verified boundaries
and remaining limitations. M8-G isolation and release blockers are unchanged.

## Secure live-provider readiness (offline verification)

M9-C2A validates mocked provider contracts. M9-C2B1 adds the guarded network path
and tests it offline. M9-C2B2 is future real-model evaluation with separate owner
authorization and a spending limit. No real LLM results are claimed here.

The network adapter accepts only the fixed OpenAI Responses endpoint, using a
private HTTPS agent, bundled CAs, hostname verification, TLS 1.3, no proxies,
redirects or retries, and bounded headers/body/deadlines. It requires a signed,
invocation-specific Ed25519 approval verified against an independently trusted
owner public key. Short-lived opaque capabilities and single-use body-bound
reservation permits cannot be supplied through model/scenario arguments.

Ordinary eval, eval:agent and CI remain unable to execute live providers. There is
no live launcher, owner key/approval loader, API-key environment lookup or enable
flag. eval:provider:test runs existing mocks plus intercepted native-HTTPS controls;
real sockets/fetch are prohibited. Version-3 readiness reports separate offline control status, token-budget preflight
and overall live readiness. Overall readiness remains blocked; reports contain
only safe counts, estimates and fixed blocker codes.

The pinned development-only js-tiktoken encoder uses o200k_base with estimation
margin and separately approved framing overhead. Existing 4096-token scenario
limits remain; oversized catalog/history is rejected before credentials or network.
The representative full catalog estimates 11733 input + 1024 framing + 256 output
tokens (13013 total), exceeding that ceiling. Full live scenarios remain blocked
until B2 approves a budget or prompt-contract change.
Reservations are never refunded, and missing/late usage remains unknown. These
local controls do not guarantee the provider invoice; account billing controls
remain necessary.

The initial explicit compatibility profile is gpt-4.1-mini-2025-04-14, documented
for Responses/Structured Outputs without reasoning. It is deprecated, with
shutdown scheduled for January 14, 2027; approval checks refuse it at that date.
This is not a default model choice or proof of account availability. Actual API
compatibility, token framing, latency, TLS handshake and billing remain unverified.

Before B2, the owner must approve the exact available model/profile, protected
signing-key and approval provisioning, current pricing, synthetic fixtures,
call/token/cost limits and account billing controls. Any catalog-budget mismatch
needs an explicit reviewed decision; no limits or schemas are silently weakened.
Process-local approval replay checks do not replace operational protection across
process restarts. See the [B1 specification](docs/m9-c2b1-live-readiness-spec.md).
Existing application authentication, tenant isolation, MCP tools and M8-G release
blockers are unchanged. No billable calls are part of B1.

B1 source-review repair (M9-C2B1R) binds each signed approval to an opaque
fixture created by the trusted synthetic PostgreSQL setup, its data-manifest
digest, and one canonical scenario's digest and exact inventory. The approved
runner accepts no arbitrary prompt or MCP client. It owns independent bounded
cleanup and revokes the grant in a final step on success or failure. Closed or
revoked grants cannot create transports or send requests. One approval covers
exactly one scenario; a suite requires separately approved invocations.

Replay protection remains process-local. A persistent atomic replay store is
required before C2B2, together with an explicitly approved active model (the
current snapshot is deprecated), token/cost decisions and protected owner
provisioning. Offline JSON Schema subset validation does not prove live API
acceptance. See the [repair specification](docs/m9-c2b1r-security-repair-spec.md).
No live provider calls are authorized by this repair.

## Workspace and documentation

```text
apps/mcp-server/      Composition root and process lifecycle
packages/domain/     Portable entities and deterministic evaluation
packages/application/ Use cases, authorization, explicit repository ports
packages/database/   Drizzle schema, migrations, connection/readiness/admin operations
packages/infrastructure/ PostgreSQL/context/cursor adapters and logging
packages/mcp/        Schemas, eight explicit registrations, invocation bounds
packages/shared/     Metadata-only; no speculative shared abstractions
packages/test-support/ Disposable database and synthetic fixtures
docs/                Architecture, contracts, operations, security, case study
```

Additional specifications: [product](docs/product-spec.md), [domain](docs/domain-model.md),
[implementation plan](docs/implementation-plan.md), and [agent instructions](AGENTS.md).

## Limitations and next work

- Resolve supported dependency/native-image security maintenance through the
  separate M8-G review; no zero-vulnerability or production-ready claim.
- Decide the intended deployment profile before designing independent remote
  authentication; local stdio does not itself require HTTP or OAuth.
- Define operational recovery objectives, protected storage, update ownership,
  and monitoring; current restore drills are not a disaster-recovery service.
- Review transport input/resource limits and native/runtime failure scenarios.
- Opportunity budget scoring stays null because profile currency is not modeled.
  Evidence retrieval is bounded and reports incomplete retrieval explicitly.
- No job-site/email/calendar integration, proposal submission, vector search,
  background worker, UI, or mutation beyond note creation is implemented.

### M9-C2B1S: request-bound authorization (offline)

The [request-binding repair](docs/m9-c2b1s-request-binding-spec.md) requires a private
runner-owned execution lease and a one-use authorization for each exact model
request. A LiveGrant alone cannot authorize provider calls. Turns bind the canonical
scenario, discovered tools, actual MCP observations, transcript, adapter/model and
remaining budgets. The native transport still requires a separate body-bound,
one-use HTTP permit. No live API requests or LLM performance results are included.

Synthetic live-evaluation fixture setup additionally requires an explicitly approved
test cluster: literal loopback address and explicit port, postgres control database,
pinned PostgreSQL system identifier, and an operator-installed database comment
`beloveddev.synthetic-evaluation-cluster:<UUID>`. Trusted bootstrap supplies
`TEST_CLUSTER_SYSTEM_IDENTIFIER` and `TEST_CLUSTER_MARKER` alongside the private
`TEST_DATABASE_URL`; these are test configuration, not model input or live approval.
The fixture gate verifies this identity read-only before any fixture database/role
creation and rechecks it on use. It never marks an arbitrary target itself. CI marks
only its dedicated disposable test service. Local verification must use a separately
owned disposable cluster; never install this marker on a shared or production server.

C2B2 remains blocked: the measured 13,013-token request exceeds the unchanged
4,096-token limit; replay protection is process-local; the current model snapshot
is deprecated. Durable replay storage, an active model and owner-approved budgets
require separate review. Ordinary evaluation commands remain offline.
