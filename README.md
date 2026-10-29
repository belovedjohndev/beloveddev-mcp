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
