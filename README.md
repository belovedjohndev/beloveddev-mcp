# BelovedDev MCP

BelovedDev MCP is a private operational knowledge service for developer profiles,
project evidence, blockers, and freelance opportunities. MCP is its interface;
deterministic application code owns authorization, tenant scope, data integrity,
transactions, idempotency, and business rules.

## Current status: Milestone 0

This workspace contains development infrastructure only. The executable validates
configuration, emits a structured log, and exits. It does not start an MCP server
or connect to PostgreSQL. Domain tables, authentication, authorization, MCP tools,
Drizzle, and the MCP SDK belong to later milestones.

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
4. Check the workspace: `npm run verify`.
5. Run the foundation bootstrap: `npm start`.

If port 5432 is already occupied, choose a free port in `POSTGRES_PORT` and
update `DATABASE_URL` to match before starting Compose.

A valid configuration produces one JSON log on stderr and exit code 0. Invalid
configuration produces a safe JSON error and exit code 1. Stdout stays empty for a
future MCP stdio transport. `LOG_LEVEL=silent` suppresses successful startup logs;
configuration errors still log. No long-running server is expected in this milestone.

## Commands

| Command                | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm ci`               | Install the locked dependency tree, including local workspaces            |
| `npm run build`        | Build active packages in dependency order with TypeScript                 |
| `npm run typecheck`    | Build production code and check tests/configuration without emitting them |
| `npm run lint`         | Build package declarations, then run type-aware ESLint                    |
| `npm run format:check` | Check formatting of maintained foundation files                           |
| `npm run format`       | Format maintained files                                                   |
| `npm test`             | Build and run Vitest, including compiled bootstrap tests                  |
| `npm run test:watch`   | Build once, then watch tests                                              |
| `npm run verify`       | Check formatting, lint, types, build, and tests                           |
| `npm start`            | Run the compiled bootstrap; build first                                   |
| `npm run db:up`        | Start PostgreSQL and wait for its health check                            |
| `npm run db:down`      | Stop PostgreSQL, retaining the data volume                                |
| `npm run db:logs`      | Follow PostgreSQL logs                                                    |

The bootstrap tests execute compiled files. After changing application startup code
during watch mode, rerun the build or restart the watcher. There is no repository
integration-test command yet because there are no repositories or schemas.

## Workspace

```text
apps/
  mcp-server/       Composition root: environment -> logger -> exit
packages/
  domain/           Reserved for pure domain rules
  application/      Reserved for use cases and ports
  database/         Reserved for Drizzle, migrations, and connection lifecycle
  infrastructure/   Environment validation and structured logging
  mcp/              Reserved for transport adapters and tool contracts
  shared/           Reserved for demonstrated cross-cutting needs
  test-support/     Reserved for reusable test infrastructure
docs/               Product, domain, architecture, contracts, and delivery plan
```

Reserved workspaces contain only private package metadata. There are no empty
service classes, repository interfaces, dependency-injection containers, or dummy
exports. Only `infrastructure` and `mcp-server` participate in the build today.

Runtime dependencies are Zod and Pino. Node loads local environment files natively;
TypeScript builds ESM with NodeNext resolution. The application imports explicit
infrastructure package exports. Future domain/application packages must remain
independent of concrete database and MCP adapters.

## Configuration

| Variable            | Default             | Purpose                                                         |
| ------------------- | ------------------- | --------------------------------------------------------------- |
| `NODE_ENV`          | `development`       | `development`, `test`, or `production`                          |
| `LOG_LEVEL`         | `info`              | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `DATABASE_URL`      | Required            | PostgreSQL URL with a host and database name                    |
| `POSTGRES_USER`     | Required by Compose | Local database administrator                                    |
| `POSTGRES_PASSWORD` | Required by Compose | Local database password                                         |
| `POSTGRES_DB`       | Required by Compose | Local database name                                             |
| `POSTGRES_PORT`     | `5432`              | Host port, bound to `127.0.0.1`                                 |

`DATABASE_URL` validation checks URL structure, not connectivity. Both `postgres:`
and `postgresql:` schemes are accepted. Keep the URL aligned with Compose settings;
percent-encode credentials containing URL-reserved characters. Native Node env-file
loading preserves values already supplied by the process environment.

Only the composition root reads `process.env`; the validator takes an explicit
input and returns a frozen configuration. Validation errors retain field names
only. Unknown environment variables are discarded.

Pino emits JSON to stderr. Known secret keys, authorization/cookie headers, and
top-level `config`/`env` objects are redacted. Redaction is a defensive backstop,
not an arbitrary-depth content scanner: use static messages and explicitly selected
safe metadata. Never log raw errors, credentials, request/response bodies, or
sensitive content in free-form messages or unrecognized fields.

## PostgreSQL and security boundaries

Compose uses the official `postgres:18` image, a health check, localhost-only
port publication, and a named volume mounted at `/var/lib/postgresql`. The major
version is fixed; patch image updates are intentional. No schema initialization or
domain migrations are included.

The example credentials are public and for isolated local development only.
The official image creates `POSTGRES_USER` as a superuser. Before application data
access is introduced, provision separate least-privilege runtime and migration
roles. Do not reuse this Compose setup as production deployment configuration.
Changing initialization credentials does not update an existing database volume.
`npm run db:down` preserves data; deleting the volume destroys it.

No authenticated tenant context exists yet. Future use cases must authorize explicit
permissions and pass trusted tenant scope into every tenant-owned query. Model
arguments cannot establish identity or access. Cross-tenant lookups must not reveal
another tenant's resources. Add real PostgreSQL integration tests for tenant
isolation, constraints, transactions, and idempotency with the corresponding
features. Every schema change requires a migration.

## CI and verification

GitHub Actions installs with `npm ci`, runs `npm run verify`, starts Compose,
and executes an authenticated `SELECT 1` against PostgreSQL. Unit and process tests
cover invalid/missing configuration, safe diagnostics, log redaction/filtering,
and startup output/exit behavior. No database tables are created by these checks.

## Specifications

- [Product specification](docs/product-spec.md)
- [Domain model](docs/domain-model.md)
- [Architecture](docs/architecture.md)
- [MCP tool contracts](docs/mcp-tool-contracts.md)
- [Implementation plan](docs/implementation-plan.md)
- [Agent instructions](AGENTS.md)

The eight tools described in these documents are planned V1 capabilities, not
implemented functionality.

Implementation references: [Node environment files](https://nodejs.org/api/cli.html#--env-filefile),
[PostgreSQL image initialization and storage](https://hub.docker.com/_/postgres),
and [Pino logging options](https://github.com/pinojs/pino/blob/main/docs/api.md).
