# BelovedDev MCP

BelovedDev MCP is a private operational knowledge service for developer profiles,
project evidence, blockers, and freelance opportunities. MCP is its interface;
deterministic application code owns authorization, tenant scope, data integrity,
transactions, idempotency, and business rules.

## Current status: Milestone 8-F

The stdio MCP server exposes eight tools backed by tenant-scoped
PostgreSQL repositories. The tools `get_profile`, `list_projects`, `get_project`,
`search_project_evidence`, `get_blockers`, `list_opportunities`, and
`evaluate_opportunity` are read-only; `create_project_note` is the sole mutation. Project
evidence search uses a stored weighted English `tsvector`, deterministic
PostgreSQL relevance ranking, structured filters, and signed keyset cursors.
Opportunity listing uses exact structured filters, a literal cross-field query,
and signed deterministic keyset pagination. Opportunity evaluation reuses the
versioned domain policy and bounded evidence search; budget compatibility remains
null because profile currency is not modeled. Owners and members can evaluate;
viewers can list opportunities. Evaluation is derived and read-only.

Milestone 7-A implements `CreateProjectNote` in the application and PostgreSQL
layers, with owner/member authorization, tenant-scoped project checks, exact
idempotent retries, and atomic note/audit insertion. Strict input accepts only
project ID, category, content, and an opaque idempotency key. Milestone 7-B exposes
the command through an explicit MCP registration and the shared invocation boundary.
New notes and durable audits commit together. Identical retries return the original
note with `created=false` and a fresh `meta.requestId`; changed payloads conflict.
The runtime role needs INSERT on `project_notes` and `audit_logs` for this tool;
see [runtime grant requirements](docs/database.md).

## Requirements

- Node.js 24 (at least 24.12.0); `.nvmrc` selects the supported major.
- npm 11 (`packageManager` pins 11.6.2); the lockfile is committed for reproducible installs.
- Docker Engine/Desktop with Docker Compose v2 or later, using Linux containers.

## Local setup

Run commands from the repository root.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env`:
   - PowerShell: `Copy-Item .env.example .env`
   - POSIX shell: `cp .env.example .env`
3. Start PostgreSQL: `npm run db:up`.
4. Apply the migration chain: `npm run db:migrate`.
5. Check everything, including real PostgreSQL tests: `npm run verify:all`.
6. Provision the restricted role using the [runtime SQL](docs/database.md#migrations).
   Keep the example administrator configuration in a separate protected file for
   migrations/tests; replace `.env` with a minimal runtime configuration containing
   the restricted `DATABASE_URL`, MCP settings, and log settings. Do not inject
   `POSTGRES_PASSWORD`, `TEST_DATABASE_URL`, or `DATABASE_MIGRATION_*` into the server process. The example
   Compose superuser is now rejected by the server's startup gate.
7. Launch the compiled server directly with Node using the instructions below:
   `node --env-file=.env apps/mcp-server/dist/main.js`.

If port 5432 is already occupied, choose a free port in `POSTGRES_PORT` and
update `DATABASE_URL`, `DATABASE_MIGRATION_URL`, and `TEST_DATABASE_URL` to match before starting Compose.
The [database guide](docs/database.md) includes a PowerShell workflow that asks
Docker for an available host port.

A valid configuration and successful database readiness check start application
request handling and write structured logs
to stderr. Stdout is reserved exclusively for JSON-RPC protocol traffic. Invalid
application configuration produces a safe JSON error on stderr and exits with code 1.
If the explicitly selected env file is missing, Node fails before application
startup and writes its diagnostic to stderr without exposing environment contents.
`LOG_LEVEL=silent` suppresses successful startup and invocation logs;
configuration errors still log.

Before declaring `mcp.ready`, the server verifies PostgreSQL 18 connectivity,
the configured database and connected role identities,
the committed migration ledger and schema signature, and effective least-privilege
grants under one 10-second deadline. Dangerous roles, schema drift, missing grants,
and unreachable databases fail safely and trigger M8-C cleanup. There are no
startup migrations, grants, or retries. Remote database URLs require
`sslmode=verify-full`; optional `DATABASE_TLS_CA` supplies private-CA PEM contents.
Plaintext is limited to explicit loopback hosts. See the
[database security policy](docs/database.md#m8-d-connection-and-readiness-policy).

## Direct Node MCP launcher

Build the workspace before launching (`npm run build`, also included in
`verify:all`). The supported terminal command from the repository root is:

<!-- mcp-client-command -->

```sh
node --env-file=.env apps/mcp-server/dist/main.js
```

Node executes the compiled composition root directly. This command requires the
selected `.env` file to exist; it does not silently skip missing configuration.
It does not spawn npm, build packages, run migrations, or discover other env files.

For MCP client configuration, use absolute paths for the Node executable, the
operator-owned environment file, and the compiled entry point. Replace these
example paths with the actual installed locations:

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": [
    "--env-file=C:/private/BelovedDev MCP/server.env",
    "C:/installed/BelovedDev MCP/apps/mcp-server/dist/main.js"
  ]
}
```

On POSIX systems, use absolute paths such as `/usr/bin/node` and
`/srv/BelovedDev MCP/apps/mcp-server/dist/main.js`. Use forward slashes such as
`C:/...` for Windows paths in JSON. Each argument is one string; do not add shell
quote characters around paths containing spaces. The client must invoke Node
directly, without a shell or npm lifecycle wrapper.
Existing process environment values take precedence over env-file values.
A relative `--env-file` path is intentionally relative to the caller's working
directory; absolute paths avoid that dependency.

`npm start` remains a terminal convenience that requires the repository `.env`.
Do not configure an MCP client to launch npm: its lifecycle banner writes to
stdout. The supported client launch path is direct Node, with stdout reserved
for MCP protocol messages and application logs on stderr.

## Local stdio release image

M8-F adds a digest-pinned Node 24 multi-stage image with production dependencies,
compiled workspaces, and the migration files needed by M8-D readiness. It runs
Node directly as non-root; configuration and secrets are supplied only at runtime.
Use `npm run test:container` to build and verify the Linux artifact with disposable
TLS PostgreSQL and restricted runtime credentials. See the
[container operating guide](docs/local-stdio-container.md) for build commands,
MCP client configuration, database networking, resource restrictions, and shutdown.
The image preserves the local-only authentication profile and rejects
`NODE_ENV=production`; it is not approval for remote multi-user deployment.
The gate builds from a source-only snapshot, checks for application listeners,
and proves missing packaged migrations prevent readiness. Native Windows can
continue using the [direct Node launcher](#direct-node-mcp-launcher).
M8-G vulnerability maintenance and M8-H2 backup/recovery operations remain;
Milestone 8 is not complete.

## Local stdio trust boundary

M8-B supports an operator-controlled local stdio subprocess. The MCP host, launcher, OS account,
installed code, and environment/env file are trusted. Protect configuration and
credentials with OS file/account permissions, and use a restricted database
runtime role. Do not share the process or its configuration with untrusted local
users, code, or agents. A process serving one configured principal must not be
used as an unauthenticated bridge for remote users.

`MCP_LOCAL_TENANT_ID` and `MCP_LOCAL_USER_ID` are operator assertions, not proof of
identity from credentials; local identity is not independent authentication.
A compromised launcher can alter the configured identity and select another
active principal. Both identifiers must be configured together;
if both are absent, application tool calls are unauthenticated. The server
rechecks active tenant/user/membership and derives permissions from the stored
role on every invocation. Model-controlled tool arguments cannot supply trusted
identity, tenant, role, or permissions.

Local process startup does not establish production authentication security.
`MCP_AUTH_MODE=local` remains the only implemented mode and is rejected with
`NODE_ENV=production`; remote/unsupported modes also fail closed. M8-B does not
relax that guard or add HTTP, OAuth, or an identity provider. Remote multi-user
hosting requires a separately approved deployment and authentication design.
Local stdio requires no HTTP listener or OAuth.

The MCP client controls the subprocess lifecycle. Stop it through the client's
disconnect/stop action, which should close stdin or terminate the child. In a
terminal, use Ctrl+C; the server handles SIGINT, SIGTERM, and stdin EOF by closing
the transport and database pool. Fatal database pool/client errors use the same
idempotent shutdown path and exit nonzero. See the lifecycle behavior below.

## Invocation bounds

The process admits at most eight executing application invocations across all
eight tools, with no waiting queue. Saturation returns the existing safe
`RATE_LIMITED` envelope before trusted-context lookup or use-case execution.
Each admitted callback has a 30-second response deadline, including context
resolution, execution, success validation, and serialization. Deadline expiry
returns safe `INTERNAL_ERROR`; it does not cancel SQL or release the active slot.
Work retains its capacity and shutdown lease until it actually settles. A context
lookup finishing after expiry cannot start a new use case.

Success responses are limited to 1 MiB (1,048,576 UTF-8 bytes) of the serialized
MCP `CallToolResult`, including both JSON text `content` and `structuredContent`
and their escaping. SDK JSON-RPC framing is outside this application limit.
Oversized results return safe `INTERNAL_ERROR` without truncation or partial
structured output. Errors remain small existing envelopes. These are fixed V1
defaults, not tool arguments or environment overrides.

Timeouts and response-size errors do not prove that a note/audit rolled back.
An admitted write can commit after an error response. An explicit retry must use
the original exact payload and idempotency key; if capacity is still occupied,
it may receive `RATE_LIMITED`. The server never retries automatically. Response
deadlines need an available Node event loop and do not preempt synchronous work;
an elapsed-time check also rejects results that finish after the deadline.
These application limits do not bound SDK input framing or PostgreSQL server
resource consumption, and cannot guarantee response delivery to a disconnected
client. Recover uncertain writes with the same trusted tenant and author as well
as the identical payload and original idempotency key.

## Shutdown and connection failures

On the first shutdown trigger, the process pauses input and stops admission before
trusted-context resolution. Already admitted tool callbacks have up to 10 seconds
to settle, including output validation and invocation logging. Transport and
database cleanup are then attempted independently, even if either fails or stalls.
Complete protocol messages are flushed before normal exit. One 15-second deadline
covers draining, cleanup, and output flushing; expiry forces exit code 1. Cleanup
failures and drain expiry also produce a nonzero exit. Repeated triggers do not
restart the deadline or repeat cleanup; a later fatal pool error makes exit nonzero.
The 10-second grace matches the existing statement timeout and leaves up to five
seconds for cleanup/output within the total budget. It does not guarantee that a
sequence of queries will finish. Startup failures after partial initialization use
the same cleanup path, including a wire started before a server handle exists.
Lifecycle diagnostics use safe structured stderr records without raw errors.
Configure clients/supervisors to allow at least 15 seconds after EOF or a catchable
signal before escalating to forced termination. A client that kills sooner can
interrupt the grace period; it must still treat missing responses as uncertain.

The SDK closes its wire immediately on stdin EOF or a broken output pipe. An
admitted operation may still finish during the grace period, but its response may
never arrive. Invocation success means application execution and output validation
succeeded, not that the client received the response. Disconnect, cancellation,
or forced termination does not prove rollback. A committed project note and its
audit remain durable. Preserve the original `projectId`, `category`, `content`, and
`idempotencyKey`. When service is available, retry that unchanged command under the
same tenant/user: an existing commit is returned
with `created=false`, while an uncommitted attempt can create the note. Do not
generate a new key merely because a response was lost. The server never retries
mutations automatically and does not claim to cancel database work on disconnect.

Active-query connection failures are safely mapped through the existing application
error boundary. PostgreSQL rolls back an interrupted open transaction; a failure
near COMMIT can still leave its outcome uncertain. Fatal socket errors on checked-out
clients are handled explicitly, preventing raw unhandled-event diagnostics. Both
these client errors and idle pool errors stop the process; shutdown can beat error
response delivery. Reconnect through a new process for an explicit retry if needed.
Ordinary SQL/query errors still follow existing application handling. There is no automatic process restart. Uncatchable
termination (including SIGKILL and Windows forced process termination) cannot run
graceful cleanup; use client-managed stdin closure where available. POSIX signal
delivery has integration coverage on POSIX; process-event routing is also tested
on Windows. Shutdown deadlines depend on the Node event loop being able to run.

## Commands

| Command                    | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm ci`                   | Install the locked dependency tree, including local workspaces               |
| `npm run build`            | Build active packages in dependency order with TypeScript                    |
| `npm run typecheck`        | Build production code and check tests/configuration without emitting them    |
| `npm run lint`             | Build package declarations, then run type-aware ESLint                       |
| `npm run format:check`     | Check formatting of maintained foundation files                              |
| `npm run format`           | Format maintained files                                                      |
| `npm test`                 | Build and run Vitest, including compiled bootstrap tests                     |
| `npm run test:watch`       | Build once, then watch tests                                                 |
| `npm run verify`           | Check formatting, lint, types, build, and tests                              |
| `npm run test:integration` | Run real PostgreSQL migration, constraint, and tenant-isolation tests        |
| `npm run verify:all`       | Run all checks, including integration tests and migration history validation |
| `npm run db:generate`      | Generate reviewed Drizzle SQL migrations and metadata                        |
| `npm run db:check`         | Validate Drizzle migration history                                           |
| `npm run db:migrate`       | Apply committed migrations using explicit DATABASE_MIGRATION_URL             |
| `npm start`                | Terminal convenience only; MCP clients must use the direct Node launcher     |
| `npm run db:up`            | Start PostgreSQL and wait for its health check                               |
| `npm run db:down`          | Stop PostgreSQL, retaining the data volume                                   |
| `npm run db:logs`          | Follow PostgreSQL logs                                                       |

The bootstrap tests execute compiled files. After changing application startup code
during watch mode, rerun the build or restart the watcher. The default unit suite
does not require PostgreSQL; integration tests are run explicitly or through
`verify:all`.

## Workspace

```text
apps/
  mcp-server/       Explicit database/use-case/MCP stdio composition root
packages/
  domain/           Portable entity types and status values
  application/      Authorization, read use cases, repository ports, and safe errors
  database/         Drizzle schema, migration, and connection lifecycle
  infrastructure/   Scoped PostgreSQL/context/cursor adapters, configuration, and logging
  mcp/              Strict tool schemas, explicit registration, and shared invocation boundary
  shared/           Reserved for demonstrated cross-cutting needs
  test-support/     Disposable databases and two-tenant fixtures
docs/               Product, domain, architecture, contracts, and delivery plan
```

`shared` remains metadata-only. Repository interfaces exist only for implemented
operations; there is no generic base repository or dependency-injection container.

Runtime dependencies are Zod, Pino, Drizzle ORM, and node-postgres. Drizzle Kit is
development tooling. Node loads local environment files natively; TypeScript
builds ESM with NodeNext resolution. Core domain/application code is independent
of Drizzle and concrete adapters.

## Configuration

| Variable                    | Default                        | Purpose                                                                    |
| --------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `NODE_ENV`                  | `development`                  | `development`, `test`, or `production`                                     |
| `LOG_LEVEL`                 | `info`                         | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`            |
| `DATABASE_URL`              | Required                       | PostgreSQL URL with a host and database name                               |
| `DATABASE_MIGRATION_URL`    | Required for migration CLI     | Separate administrative URL; no runtime/test fallback                      |
| `DATABASE_MIGRATION_TLS_CA` | Optional for migration CLI     | Private CA PEM; requires verify-full; no runtime CA fallback               |
| `MCP_AUTH_MODE`             | Required                       | `local`; rejected in production pending an approved authentication profile |
| `MCP_CURSOR_SECRET`         | Required                       | Cursor HMAC secret, 32–1024 characters                                     |
| `MCP_LOCAL_TENANT_ID`       | Optional                       | Trusted local operator tenant UUID; requires `MCP_LOCAL_USER_ID`           |
| `MCP_LOCAL_USER_ID`         | Optional                       | Trusted local operator user UUID; requires `MCP_LOCAL_TENANT_ID`           |
| `TEST_DATABASE_URL`         | Required for integration tests | Dedicated test-instance admin connection; never falls back to DATABASE_URL |
| `POSTGRES_USER`             | Required by Compose            | Local database administrator                                               |
| `POSTGRES_PASSWORD`         | Required by Compose            | Local database password                                                    |
| `POSTGRES_DB`               | Required by Compose            | Local database name                                                        |
| `POSTGRES_PORT`             | `5432`                         | Host port, bound to `127.0.0.1`                                            |

`DATABASE_URL` validation checks URL structure, not connectivity. Both `postgres:`
and `postgresql:` schemes are accepted. Keep the URL aligned with Compose settings;
percent-encode credentials containing URL-reserved characters. Native Node env-file
loading preserves values already supplied by the process environment.

The application composition root, migration CLI, and integration-test setup read
`process.env`; repositories and core code do not. Validators take explicit input
and return validated settings. Validation errors retain field names
only. Unknown environment variables are discarded.

Pino emits JSON to stderr. Known secret keys, authorization/cookie headers, and
top-level `config`/`env` objects are redacted. Redaction is a defensive backstop,
not an arbitrary-depth content scanner: use static messages and explicitly selected
safe metadata. Never log raw errors, credentials, request/response bodies, or
sensitive content in free-form messages or unrecognized fields.

## PostgreSQL and security boundaries

Compose uses the official `postgres:18` image, a health check, localhost-only
port publication, and a named volume mounted at `/var/lib/postgresql`. The major
version is fixed; patch image updates are intentional. Apply the committed schema
using `npm run db:migrate`; Compose itself does not apply migrations.

M8-H1 migrations use an explicit administrative process, separate from runtime.
After building, run `node --env-file=/protected/migrations.env scripts/migrate.ts`
(PowerShell also accepts a quoted `C:/protected/migrations.env` path), or inject
`DATABASE_MIGRATION_URL` and run `npm run db:migrate`. Remote endpoints require
`sslmode=verify-full`; the optional private CA is `DATABASE_MIGRATION_TLS_CA`.
One dedicated session holds a database-scoped advisory lock while Drizzle applies
and verifies the original migration chain. Defaults: connect 5s, advisory wait 10s,
other lock waits 5s, SQL 120s, overall 300s, cleanup at most 5s additional.
Positive integer administrative timeout overrides and failure/recovery steps are
documented in the [migration operations guide](docs/database.md#m8-h1-administrative-execution-policy).
Failures return safe structured stderr categories and nonzero status; a lost
commit response does not prove rollback. There are no automatic retries, ledger
repairs, or startup migrations. Runtime M8-D readiness remains mandatory.
Backup creation/verification, restore drills, and recovery objectives are M8-H2;
M8-H and Milestone 8 remain incomplete.

The example credentials are public and for isolated local development only.
The official image creates `POSTGRES_USER` as a superuser. Use this local role for
migrations and isolated test provisioning, and provision a restricted runtime
role as described in the [database guide](docs/database.md). Tests exercise separate
runtime credentials. Do not reuse this Compose setup as production deployment configuration.
Changing initialization credentials does not update an existing database volume.
`npm run db:down` preserves data; deleting the volume destroys it.

Use separate administrator/migration credentials and runtime credentials. The
runtime role needs only the documented SELECT grants (including the migration
ledger), column reads on tenant/user identity, and INSERT on `project_notes`
and `audit_logs`. Startup rejects ownership, dangerous role attributes or
membership paths, excess grants, and missing grants; administrators must also
revoke PUBLIC schema CREATE and database TEMPORARY. Tenant isolation relies on
application authorization and scoped SQL.
There are no RLS policies protecting runtime database credentials: compromised
credentials can access granted tables across tenants. Protect the env file,
credential injection, and local account accordingly.

Repositories require trusted tenant scope in SQL. The local request-context
adapter rechecks active tenant, user, and membership state on every invocation;
MCP arguments cannot establish identity or choose a tenant. Read use cases enforce
`profile:read`, `projects:read`, `opportunities:read`, or
`opportunities:evaluate` before protected repository access. Evaluation permits
owners and members and denies viewers. Foreign opportunity IDs return `NOT_FOUND`. Foreign
project filters return no search results. Composite foreign keys enforce project
ownership. Local mode remains unavailable with `NODE_ENV=production`; this
launcher slice does not introduce a supported production authentication profile.

Note creation requires `project_notes:create` for owners/members. Tenant, author,
and request ID come only from trusted context; foreign and missing projects are
indistinguishable `NOT_FOUND` errors. Invocation logs exclude note content and
idempotency keys. No automatic transaction or tool retries are performed.

## CI and verification

GitHub Actions installs with `npm ci`, starts Compose on an assigned port, applies
migrations, runs `npm run verify:all`, and checks migration-generation drift.
Integration tests provision isolated databases, test restricted runtime
credentials and two-tenant fixtures, and remove their temporary databases/roles.
See [database conventions and testing](docs/database.md) for permissions,
constraints, cleanup behavior, and Drizzle compatibility notes.

## Specifications

- [Product specification](docs/product-spec.md)
- [Domain model](docs/domain-model.md)
- [Database conventions and testing](docs/database.md)
- [Architecture](docs/architecture.md)
- [MCP tool contracts](docs/mcp-tool-contracts.md)
- [Implementation plan](docs/implementation-plan.md)
- [Agent instructions](AGENTS.md)

All eight planned V1 tools are implemented through Milestone 7-B. M8-B adds the
documented local trust boundary and protocol-safe launcher; M8-C bounds lifecycle
cleanup and documents uncertain outcomes after disconnect. M8-D adds database
transport policy and bounded schema/privilege readiness. M8-E bounds application
admission, response time, and serialized success size. M8-F packages and verifies
the local stdio release container. M8-H1 adds bounded, serialized administrative
migrations with verified history and documented interrupted-operation recovery.
Further Milestone 8
hardening remains unfinished; this slice is not a production-readiness claim.
Known blockers include an approved production authentication profile, broader
operational failure testing, request/input-limit review,
release vulnerability review and update ownership, and M8-H2 backup creation,
verification, restore drills, and recovery objectives.

Implementation references: [Node environment files](https://nodejs.org/api/cli.html#--env-filefile),
[PostgreSQL image initialization and storage](https://hub.docker.com/_/postgres),
and [Pino logging options](https://github.com/pinojs/pino/blob/main/docs/api.md).
