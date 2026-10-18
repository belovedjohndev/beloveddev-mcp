# Local stdio release container

M8-F packages the existing operator-controlled local stdio server. It does not
approve remote multi-user hosting or production authentication. The OS account,
Docker daemon, MCP client, launcher, installed image, and runtime configuration
remain trusted. A compromised launcher can select a different configured
principal. Active membership is still revalidated for each invocation; database
credentials are not isolated by RLS.

## Build and verify

Use a Linux Docker engine with Buildx/BuildKit, Node `>=24.12.0 <25`, and npm
`>=11 <12` on the build/test host. The image pins the official Debian bookworm
slim Node 24 base by digest, currently containing Node 24.22.0 and npm 11.19.1.
npm is used only in build stages and removed from the runtime stage.

```sh
npm ci
npm run test:container
```

The smoke command compiles host test helpers, exports tracked and non-ignored
release inputs into an isolated source-only snapshot, and builds the release and a cold
rebuild with an isolated digest-pinned BuildKit 0.26.1 builder, compares image
identities, and runs Linux containers against disposable PostgreSQL 18
with verified TLS and restricted runtime credentials. It checks migration bytes,
non-root execution, production dependency/workspace resolution, protocol-only
stdout, eight-tool discovery and calls, tenant isolation, note/audit idempotency,
EOF and actual SIGINT/SIGTERM handling, and safe startup rejection, including a
missing migration directory. It also inspects sockets owned by the running Node
process to reject TCP listeners or UDP bindings. PostgreSQL's own listener in the
shared test network namespace is not attributed to the application. It needs Docker
access and registry access for uncached images/dependencies; no existing database
or `.env` is used. Cleanup runs in `finally` without changing the selected
developer builder. Command deadlines terminate the owned Docker CLI process tree
on Windows, including Buildx plugins. An unavailable Docker daemon fails the gate
and can prevent container/builder removal; operator recovery may be required.
The gate never restarts Docker or prunes unrelated resources automatically.
The snapshot contains the current reviewed source changes but no host `dist`,
`node_modules`, Git metadata, env files, or test fixtures. CI starts from a fresh
checkout; local builds can verify uncommitted packaging changes without committing.
The built `beloveddev-mcp:container-smoke` image remains available for inspection.
The temporary builder is capped at 2 GiB memory (including swap) and two CPUs;
application smoke containers retain their separate 256 MiB/one-CPU limits.

Tag the verified artifact for local deployment:

```sh
docker image tag beloveddev-mcp:container-smoke beloveddev-mcp:local
docker image inspect beloveddev-mcp:local --format '{{.Id}}'
```

The base digest, committed npm lockfile, disabled install hooks, fixed
`SOURCE_DATE_EPOCH=0`, and rewritten timestamps make build inputs explicit.
The script uses a `docker-container` builder and a Docker archive exporter with
`rewrite-timestamp=true`; Docker Desktop's built-in image exporter cannot combine
timestamp rewriting with its automatic unpack operation.
Reproduce with identical source bytes, target platform, and BuildKit version;
different platforms are different artifacts. Preserve migration bytes exactly:
M8-D hashes the SQL applied to the database. Do not normalize or edit migrations
after deployment. `.gitattributes` disables checkout newline conversion for the
migration directory. Record the tested image identity with the release and deploy
that immutable artifact. Updating Node/OS packages requires an explicit base
digest update and rerunning verification. Pinning does not deliver future
security fixes automatically.

The final image contains production dependencies, the compiled six-workspace
application graph, and the full committed migration directory, including
`meta/_journal.json`. It contains no source/test trees, local configuration,
registry credentials, test certificates, npm executable, or development tools.
The `.dockerignore` allowlist excludes these from the build context as well.
No secret is accepted through a build argument or baked environment default.

## Run from an MCP client

Provision PostgreSQL and apply migrations separately with administrator/migration
credentials, using the existing [database guide](database.md). Grant the runtime
role exactly the M8-D permissions. The release entry point never runs migrations
or changes privileges, and the runtime role must not own the database or schema.
The image includes migration metadata for read-only readiness checks, not an
automatic migration workflow.
Readiness must fail closed if packaged migration files are missing, even when
the database is fully migrated. The smoke gate masks the migration directory with
an empty read-only tmpfs and verifies safe failure before any ready event or MCP
response; it does not alter migration sources or the release artifact.

Protect an absolute runtime env-file path with OS permissions. Docker reads this
file on the host; do not copy it into the image or source tree. Use one unquoted
`KEY=value` per line for Docker's `--env-file` format. Required settings include:

```dotenv
NODE_ENV=development
MCP_AUTH_MODE=local
LOG_LEVEL=info
DATABASE_URL=postgresql://RUNTIME_USER:ENCODED_PASSWORD@db.example.invalid:5432/beloveddev?sslmode=verify-full
MCP_CURSOR_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
MCP_LOCAL_TENANT_ID=REPLACE_WITH_OPERATOR_CONFIGURED_TENANT_UUID
MCP_LOCAL_USER_ID=REPLACE_WITH_OPERATOR_CONFIGURED_USER_UUID
```

These are template values, not working credentials. `NODE_ENV=development`
selects the existing approved local profile. `NODE_ENV=production` still rejects
local authentication; a release image does not bypass this restriction. Do not
use this process as a remotely shared identity bridge. Tool inputs cannot choose
tenant, user, membership, role, or permissions.

The database address must be reachable from the container. Container `localhost`
is its own network namespace, not the host's PostgreSQL. Container DNS names,
`host.docker.internal`, and remote addresses require `sslmode=verify-full` and
a certificate matching that hostname; do not substitute plaintext or disable
verification. For a private CA, inject actual PEM contents in the
`DATABASE_TLS_CA` environment variable. Docker env files do not support multiline
PEM values: an operator-controlled launcher can supply it via `--env DATABASE_TLS_CA`
from its environment, or an MCP client's protected `env` configuration. No private
key is needed by the application for this server-certificate verification.

```sh
docker run --rm --interactive --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=256m --cpus=1 --stop-timeout=20 \
  --env-file /absolute/private/beloveddev.env \
  beloveddev-mcp:local
```

MCP client configuration uses Docker directly, individual arguments, absolute
host paths, and no shell/npm wrapper. Paths containing spaces remain one argument:

```json
{
  "command": "/usr/bin/docker",
  "args": [
    "run",
    "--rm",
    "--interactive",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--stop-timeout=20",
    "--env-file",
    "/absolute/private/BelovedDev MCP/server.env",
    "beloveddev-mcp:local"
  ]
}
```

Keep stdin attached with `--interactive`/`-i`; never add a TTY (`-t`), detach, or
publish a port. The image runs `node /app/apps/mcp-server/dist/main.js` directly
as UID/GID 1000:1000, with root-owned application files and no writable volume.
The smoke test uses the same read-only/capability/resource restrictions. Docker
daemon operators can override these controls and inspect runtime environment
secrets; daemon access belongs inside the trusted local operating boundary.
There is no container HTTP listener or network health-check endpoint. Readiness
is the existing bounded database gate followed by MCP initialization and the
structured `mcp.ready` stderr log.

### Native Windows alternative

Docker packaging requires Linux containers. Native Windows remains supported with
Node 24 and the compiled workspaces; see the [direct Node launcher](../README.md#direct-node-mcp-launcher).
Use the actual absolute paths in client configuration, for example:

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": [
    "--env-file=C:/private/BelovedDev MCP/server.env",
    "C:/installed/BelovedDev MCP/apps/mcp-server/dist/main.js"
  ]
}
```

The explicitly selected env file must exist. Keep paths with spaces as individual
arguments, without shell quoting or an npm wrapper. The native launcher has the
same local trust assumptions, database requirements, and production-auth rejection.

## Stop and recover

The MCP client owns the subprocess lifecycle. Closing stdin triggers the existing
M8-C shutdown path. For an independently managed container, use `docker stop`
with the configured 20-second grace; SIGTERM reaches Node as PID 1. This exceeds
the application's 15-second total shutdown bound. No restart policy or automatic
mutation retry is configured. Logs stay on stderr and stdout carries only MCP.

An EOF, signal, timeout, oversized response, or OOM/forced kill does not prove a
write rolled back. Retry an uncertain project note only with the identical
payload and original idempotency key under the same trusted tenant and author.
The existing transaction and audit guarantees remain; response delivery is not
guaranteed. M8-E retains eight active operations, no queue, a 30-second response
deadline, and the 1 MiB serialized-success limit. Docker resource ceilings do not
bound PostgreSQL server consumption or guarantee graceful cleanup under OOM.

M8 is not complete. M8-G must address dependency/image vulnerability review and
update ownership; M8-H must address tested backup/restore and migration deployment
procedures. These are proposed follow-up boundaries, not completed controls.
An approved production authentication profile and broader operational/input-limit
review also remain decisions before any production approval. A packaged release
artifact is not an approved production deployment. This slice
does not introduce HTTP, OAuth, a new authentication mode, automatic migrations,
business features, or image publishing.

Build references: [Docker build practices](https://docs.docker.com/build/building/best-practices/),
[reproducible timestamps](https://docs.docker.com/build/ci/github-actions/reproducible-builds/),
and [builder resource controls](https://docs.docker.com/build/builders/drivers/docker-container/).
