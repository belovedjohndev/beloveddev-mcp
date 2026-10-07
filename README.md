# BelovedDev MCP

BelovedDev MCP is a private operational knowledge service for developer profiles,
project evidence, blockers, and freelance opportunities. MCP is its interface;
deterministic application code owns authorization, tenant scope, data integrity,
transactions, idempotency, and business rules.

## Current status: Milestone 4

The stdio MCP server exposes five read-only tools backed by tenant-scoped
PostgreSQL repositories: `get_profile`, `list_projects`, `get_project`,
`search_project_evidence`, and `get_blockers`. Project evidence search uses a
stored weighted English `tsvector`, deterministic PostgreSQL relevance ranking,
structured filters, and signed keyset cursors. Opportunity workflows and
mutations remain later milestones.

## Requirements

- Node.js 24 (at least 24.12.0); `.nvmrc` selects the supported major.
- npm 11; the lockfile is committed for reproducible installs.
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
6. Run the compiled MCP stdio server: `npm start`.

If port 5432 is already occupied, choose a free port in `POSTGRES_PORT` and
update `DATABASE_URL` and `TEST_DATABASE_URL` to match before starting Compose.
The [database guide](docs/database.md) includes a PowerShell workflow that asks
Docker for an available host port.

A valid configuration starts the MCP stdio transport and writes structured logs
to stderr. Stdout is reserved exclusively for JSON-RPC protocol traffic. Invalid
configuration produces a safe JSON error on stderr and exits with code 1.
`LOG_LEVEL=silent` suppresses successful startup and invocation logs;
configuration errors still log.

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
| `npm run db:migrate`       | Apply committed migrations using DATABASE_URL                                |
| `npm start`                | Run the compiled bootstrap; build first                                      |
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

| Variable              | Default                        | Purpose                                                                     |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `NODE_ENV`            | `development`                  | `development`, `test`, or `production`                                      |
| `LOG_LEVEL`           | `info`                         | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`             |
| `DATABASE_URL`        | Required                       | PostgreSQL URL with a host and database name                                |
| `MCP_AUTH_MODE`       | Required                       | `local`; rejected in production until a production identity provider exists |
| `MCP_CURSOR_SECRET`   | Required                       | Cursor HMAC secret, 32–1024 characters                                      |
| `MCP_LOCAL_TENANT_ID` | Optional                       | Trusted local operator tenant UUID; requires `MCP_LOCAL_USER_ID`            |
| `MCP_LOCAL_USER_ID`   | Optional                       | Trusted local operator user UUID; requires `MCP_LOCAL_TENANT_ID`            |
| `TEST_DATABASE_URL`   | Required for integration tests | Dedicated test-instance admin connection; never falls back to DATABASE_URL  |
| `POSTGRES_USER`       | Required by Compose            | Local database administrator                                                |
| `POSTGRES_PASSWORD`   | Required by Compose            | Local database password                                                     |
| `POSTGRES_DB`         | Required by Compose            | Local database name                                                         |
| `POSTGRES_PORT`       | `5432`                         | Host port, bound to `127.0.0.1`                                             |

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

The example credentials are public and for isolated local development only.
The official image creates `POSTGRES_USER` as a superuser. Use this local role for
migrations and isolated test provisioning, and provision a restricted runtime
role as described in the [database guide](docs/database.md). Tests exercise separate
runtime credentials. Do not reuse this Compose setup as production deployment configuration.
Changing initialization credentials does not update an existing database volume.
`npm run db:down` preserves data; deleting the volume destroys it.

Repositories require trusted tenant scope in SQL. The local request-context
adapter rechecks active tenant, user, and membership state on every invocation;
MCP arguments cannot establish identity or choose a tenant. Read use cases enforce
`profile:read` or `projects:read` before protected repository access. Foreign
project filters return no search results. Composite foreign keys enforce project
ownership. Local mode is intentionally unavailable in production until a
production identity provider is implemented.

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

Five of the eight planned V1 tools are implemented. Opportunities, deterministic
opportunity evaluation, and the audited idempotent note mutation remain planned.

Implementation references: [Node environment files](https://nodejs.org/api/cli.html#--env-filefile),
[PostgreSQL image initialization and storage](https://hub.docker.com/_/postgres),
and [Pino logging options](https://github.com/pinojs/pino/blob/main/docs/api.md).
