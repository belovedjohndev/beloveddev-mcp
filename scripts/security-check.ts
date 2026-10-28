import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const reportRun = `run-${randomUUID()}`;
const reportPath = `.security-reports/${reportRun}`;
const reports = join(root, '.security-reports', reportRun);
const policyDirectory = join(root, 'security');
const registry = '--registry=https://registry.npmjs.org';
let phase = 'configuration';
type CommandResult = { code: number; stdout: string; stderr: string };
let commandSequence = 0;
let policyBlocked = false;
class SecurityDeadlineError extends Error {}
class SecurityCommandFailure extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super('Security command failed.');
    this.kind = kind;
  }
}

/** For public scanner/build diagnostics only; never accepts runtime payloads. */
export function sanitizeSecurityDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PEM]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1?[REDACTED]')
    .split('\n')
    .map((line) =>
      /password|token|secret|authorization|cookie|credential|api[_-]?key|DATABASE_(?:URL|TLS_CA)/i.test(
        line,
      )
        ? '[REDACTED diagnostic line]'
        : line,
    )
    .join('\n')
    .replaceAll(root, '<workspace>')
    .slice(-8192);
}

export function securityFailureKind(stderr: string): string {
  if (
    /executable file not found|no such file.*executable|exec.*not found|exec:.*no such file or directory/i.test(
      stderr,
    )
  )
    return 'executable';
  if (/x509|certificate.*(?:invalid|unknown|expired)|tls handshake/i.test(stderr)) return 'tls';
  if (
    /failed to load vulnerability db|database.*(?:unavailable|invalid)|unable.*database/i.test(
      stderr,
    )
  )
    return 'database';
  if (/no such image|manifest unknown|pull access denied|invalid reference format/i.test(stderr))
    return 'image';
  if (/invalid character|malformed.*(?:json|sbom)|unable to decode|unable to parse/i.test(stderr))
    return 'input';
  if (
    /connection refused|no such host|i\/o timeout|network.*unreachable|context deadline exceeded/i.test(
      stderr,
    )
  )
    return 'network';
  return 'nonzero_exit';
}

async function commandEvidence(
  command: string,
  args: string[],
  result: {
    code: number | null;
    signal?: string | null;
    kind: string;
    stdout: string;
    stderr: string;
  },
  durationMs: number,
) {
  const sequence = String(++commandSequence).padStart(4, '0');
  await writeFile(
    join(reports, 'command-' + sequence + '.json'),
    JSON.stringify(
      {
        stage: phase,
        command,
        arguments: args.map(sanitizeSecurityDiagnostic),
        exitCode: result.code,
        signal: result.signal ?? null,
        failureKind: result.kind,
        durationMs,
        stdout: sanitizeSecurityDiagnostic(result.stdout),
        stderr: sanitizeSecurityDiagnostic(result.stderr),
        outputTruncated: result.stdout.length > 8192 || result.stderr.length > 8192,
      },
      null,
      2,
    ),
  );
}

async function bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SecurityDeadlineError('Security command deadline exceeded.')),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  command: string,
  args: string[],
  cwd = root,
  timeout = 120_000,
): Promise<CommandResult> {
  const started = performance.now();
  const operation = exec(command, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let tailOut = '',
    tailError = '';
  operation.child.stdout?.on('data', (chunk: Buffer) => {
    tailOut = (tailOut + chunk.toString()).slice(-16384);
  });
  operation.child.stderr?.on('data', (chunk: Buffer) => {
    tailError = (tailError + chunk.toString()).slice(-16384);
  });
  let result: CommandResult;
  try {
    result = { code: 0, ...(await bounded(operation, timeout)) };
  } catch (error: unknown) {
    const failure = z
      .object({ code: z.number().int(), stdout: z.string(), stderr: z.string() })
      .safeParse(error);
    if (failure.success) result = failure.data;
    else {
      const missing = z.object({ code: z.literal('ENOENT') }).safeParse(error).success;
      const kind =
        error instanceof SecurityDeadlineError ? 'deadline' : missing ? 'executable' : 'execution';
      const child = operation.child;
      if (child.pid !== undefined && child.exitCode === null) {
        if (process.platform === 'win32') {
          await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            timeout: 5000,
            windowsHide: true,
          }).catch(() => child.kill('SIGKILL'));
        } else child.kill('SIGKILL');
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      await commandEvidence(
        command,
        args,
        {
          code: null,
          signal: child.signalCode,
          kind,
          stdout: tailOut,
          stderr: tailError,
        },
        performance.now() - started,
      );
      throw new SecurityCommandFailure(kind);
    }
  }
  await commandEvidence(
    command,
    args,
    { ...result, kind: result.code === 0 ? 'none' : securityFailureKind(result.stderr) },
    performance.now() - started,
  );
  return result;
}

async function docker(args: string[], timeout = 30_000) {
  const result = await run('docker', args, root, timeout);
  if (result.code !== 0) throw new SecurityCommandFailure(securityFailureKind(result.stderr));
  return result.stdout.trim();
}

function npm(args: string[], cwd: string) {
  // Running npm's actual JS entry point avoids shell/npm.cmd quoting on Windows.
  const cli = process.env['npm_execpath'];
  if (cli === undefined)
    throw new Error('Launch security checks through the documented npm scripts.');
  return run(process.execPath, [cli, ...args], cwd);
}

const npmSeverity = z.enum(['info', 'low', 'moderate', 'high', 'critical']);
const auditSchema = z.object({
  auditReportVersion: z.literal(2),
  vulnerabilities: z.record(z.string(), z.object({ name: z.string(), severity: npmSeverity })),
  metadata: z.object({
    vulnerabilities: z.object({
      info: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
      moderate: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
      critical: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    dependencies: z.object({ prod: z.number().int().nonnegative() }),
  }),
});

export function readAuditResult(value: unknown, code: number) {
  const report = auditSchema.parse(value);
  const blocked =
    report.metadata.vulnerabilities.high > 0 ||
    report.metadata.vulnerabilities.critical > 0 ||
    Object.values(report.vulnerabilities).some(
      (item) => item.severity === 'high' || item.severity === 'critical',
    );
  assert.equal(code, blocked ? 1 : 0, 'npm audit must enforce its threshold and report errors.');
  return { report, blocked };
}

const artifactSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: z.string(),
  foundBy: z.string(),
});
const inventorySchema = z.object({
  artifacts: z.array(artifactSchema).min(1),
  descriptor: z.object({ name: z.literal('syft'), version: z.literal('1.54.1') }),
  source: z.object({ type: z.literal('image') }),
});

export function readInventory(value: unknown, release: boolean) {
  const inventory = inventorySchema.parse(value);
  if (release) {
    assert(
      inventory.artifacts.some((item) => item.type === 'deb'),
      'OS inventory is required.',
    );
    for (const name of ['@modelcontextprotocol/server', 'zod', 'pg']) {
      assert(
        inventory.artifacts.some(
          (item) =>
            item.type === 'npm' &&
            item.name === name &&
            item.foundBy === 'javascript-package-cataloger',
        ),
        'Runtime npm inventory is required.',
      );
    }
    for (const name of [
      'typescript',
      'vitest',
      'eslint',
      'vite',
      'launch-editor',
      '@modelcontextprotocol/client',
    ]) {
      assert(
        !inventory.artifacts.some((item) => item.type === 'npm' && item.name === name),
        'Development dependencies cannot ship.',
      );
    }
  }
  return inventory;
}

const vulnerabilitySchema = z.object({
  vulnerability: z.object({
    id: z.string().min(1),
    severity: z.enum(['Unknown', 'Negligible', 'Low', 'Medium', 'High', 'Critical']),
  }),
  artifact: z.object({ name: z.string(), version: z.string(), type: z.string() }),
});
const grypeSchema = z.object({
  matches: z.array(vulnerabilitySchema),
  ignoredMatches: z.array(z.unknown()).max(0).optional(),
  descriptor: z.object({
    name: z.literal('grype'),
    version: z.literal('0.120.1'),
    db: z.object({
      status: z.object({
        valid: z.literal(true),
        error: z.string().max(0).optional(),
        built: z.iso.datetime({ offset: true }),
        schemaVersion: z.string().min(1),
      }),
    }),
  }),
});

export function readImageResult(value: unknown, code: number, now = Date.now()) {
  const report = grypeSchema.parse(value);
  const age = now - Date.parse(report.descriptor.db.status.built);
  assert(
    age >= -300_000 && age <= 120 * 60 * 60 * 1000,
    'A current vulnerability database is required.',
  );
  const blocked = report.matches.some(
    (item) => item.vulnerability.severity === 'High' || item.vulnerability.severity === 'Critical',
  );
  assert.equal(code, blocked ? 2 : 0, 'Grype must enforce its threshold and report errors.');
  return { report, blocked };
}

function auditArgs(production = true) {
  return [
    'audit',
    '--json',
    '--audit-level=high',
    '--strict-ssl=true',
    '--include=optional',
    '--include=peer',
    registry,
    '--fetch-retries=1',
    '--fetch-timeout=30000',
    ...(production
      ? ['--omit=dev', '--workspace=@beloveddev/mcp-server', '--include-workspace-root=false']
      : ['--include=dev']),
  ];
}

async function audit(directory: string, filename: string, production = true) {
  const result = await npm(auditArgs(production), directory);
  await writeFile(join(reports, filename), result.stdout);
  return readAuditResult(JSON.parse(result.stdout), result.code);
}

const toolchainSchema = z.strictObject({
  grype: z.string().regex(/^anchore\/grype:v0\.120\.1@sha256:[a-f0-9]{64}$/),
  syft: z.string().regex(/^anchore\/syft:v1\.54\.1@sha256:[a-f0-9]{64}$/),
});

/** Reject unknown settings and policy drift before any scanner side effects. */
export function validateGrypePolicy(value: unknown) {
  return z
    .strictObject({
      'check-for-app-update': z.literal(false),
      'fail-on-severity': z.literal('high'),
      'only-fixed': z.literal(false),
      'only-notfixed': z.literal(false),
      ignore: z.array(z.unknown()).max(0),
      exclude: z.array(z.unknown()).max(0),
      'vex-documents': z.array(z.unknown()).max(0),
      db: z.strictObject({
        'cache-dir': z.literal('/cache'),
        'auto-update': z.literal(true),
        'validate-by-hash-on-start': z.literal(true),
        'validate-age': z.literal(true),
        'max-allowed-built-age': z.literal('120h'),
        'require-update-check': z.literal(true),
        'max-update-check-frequency': z.literal('0s'),
        'update-available-timeout': z.literal('30s'),
        'update-download-timeout': z.literal('5m'),
      }),
    })
    .parse(value);
}

async function scannerContext() {
  const toolchain = toolchainSchema.parse(
    JSON.parse(await readFile(join(policyDirectory, 'toolchain.json'), 'utf8')),
  );
  validateGrypePolicy(JSON.parse(await readFile(join(policyDirectory, 'grype.json'), 'utf8')));
  phase = 'Docker engine verification';
  const engine = z
    .object({ Version: z.string(), Os: z.literal('linux'), Arch: z.string() })
    .parse(JSON.parse(await docker(['version', '--format', '{{json .Server}}'])));
  const versions: Record<string, { image: string; executable: string; output: string }> = {};
  for (const tool of ['syft', 'grype'] as const) {
    phase = tool + ' image provisioning';
    await docker(['pull', toolchain[tool]], 180_000);
    phase = tool + ' executable verification';
    const version = await docker(
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        toolchain[tool],
        'version',
      ],
      60_000,
    );
    assert.match(version, tool === 'syft' ? /Version:\s+1\.54\.1\b/ : /Version:\s+0\.120\.1\b/);
    versions[tool] = { image: toolchain[tool], executable: '/' + tool, output: version };
  }
  await writeFile(
    join(reports, 'tool-environment.json'),
    JSON.stringify(
      {
        host: { os: process.platform, architecture: process.arch, node: process.versions.node },
        engine,
        tools: versions,
      },
      null,
      2,
    ),
  );
  phase = 'scanner cache creation';
  const volume = `beloveddev_security_db_${randomUUID().replaceAll('-', '')}`;
  // The database exceeds 1 GiB. Keep SQLite on native Linux storage, not a
  // Windows bind mount or VM-memory-backed tmpfs. The volume is always disposable.
  await docker(['volume', 'create', volume]);
  const close = async () => {
    assert(/^beloveddev_security_db_[a-f0-9]{32}$/.test(volume));
    await docker(['volume', 'rm', volume]);
  };
  const initializer = /^FROM (node:24\S+@sha256:[a-f0-9]{64}) AS manifests\r?$/m.exec(
    await readFile(join(root, 'Dockerfile'), 'utf8'),
  )?.[1];
  const initName = `beloveddev_security_init_${randomUUID().replaceAll('-', '')}`;
  try {
    assert(initializer, 'The existing pinned Node base is required.');
    try {
      await docker([
        'run',
        '--rm',
        '--name',
        initName,
        '--read-only',
        '--network=none',
        '--cap-drop=ALL',
        '--cap-add=CHOWN',
        '--user=0:0',
        '--memory=64m',
        '--cpus=0.5',
        '--pids-limit=32',
        '--mount',
        `type=volume,source=${volume},target=/cache`,
        '--entrypoint=node',
        initializer,
        '--input-type=module',
        '-e',
        "import{chmodSync,chownSync}from'node:fs';chmodSync('/cache',0o700);chownSync('/cache',1000,1000);",
      ]);
    } finally {
      await removeScannerContainer(initName);
    }
  } catch (error: unknown) {
    await close();
    throw error;
  }
  return { toolchain, volume, close };
}
type ScannerContext = Awaited<ReturnType<typeof scannerContext>>;

async function removeScannerContainer(name: string) {
  assert(/^beloveddev_security_(scan|init)_[a-f0-9]{32}$/.test(name));
  const remaining = await docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]);
  if (remaining) await docker(['rm', '--force', name]);
}

async function scanner(
  context: ScannerContext,
  tool: 'syft' | 'grype',
  args: string[],
  offline = false,
  executable?: '/missing-security-scanner',
  timeout = 600_000,
): Promise<CommandResult> {
  const name = `beloveddev_security_scan_${randomUUID().replaceAll('-', '')}`;
  try {
    return await run(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=1000:1000',
        '--memory=2g',
        '--cpus=2',
        '--pids-limit=64',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=1g,mode=1777',
        '--env=HOME=/tmp',
        '--env=XDG_CACHE_HOME=/tmp/.cache',
        ...(tool === 'syft' ? ['--env=SYFT_CHECK_FOR_APP_UPDATE=false'] : []),
        ...(offline || tool === 'syft' ? ['--network=none'] : []),
        '--mount',
        `type=bind,source=${reports},target=/work,readonly`,
        '--mount',
        `type=bind,source=${policyDirectory},target=/policy,readonly`,
        '--mount',
        `type=volume,source=${context.volume},target=/cache`,
        ...(executable === undefined ? [] : ['--entrypoint=' + executable]),
        context.toolchain[tool],
        ...args,
      ],
      root,
      timeout,
    );
  } finally {
    // The --rm path can finish before this command. Ignore only a confirmed absent container.
    await removeScannerContainer(name);
  }
}

export function readCatalogIdentity(value: unknown) {
  const source = z
    .object({
      source: z.object({
        metadata: z.object({
          imageID: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          config: z.string().min(1),
        }),
      }),
    })
    .parse(value).source.metadata;
  const raw = Buffer.from(source.config, 'base64');
  assert.equal(
    'sha256:' + createHash('sha256').update(raw).digest('hex'),
    source.imageID,
    'Catalog config must match its digest.',
  );
  const config = z
    .object({
      rootfs: z.object({ diff_ids: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1) }),
    })
    .parse(JSON.parse(raw.toString('utf8')));
  return { configDigest: source.imageID, filesystemLayers: config.rootfs.diff_ids };
}

async function imageInventory(
  context: ScannerContext,
  image: string,
  prefix: string,
  release: boolean,
) {
  const archiveInput = image.startsWith('docker-archive:')
    ? resolve(image.slice('docker-archive:'.length))
    : undefined;
  let imageId =
    archiveInput === undefined
      ? await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
      : undefined;
  if (imageId !== undefined) assert(/^sha256:[a-f0-9]{64}$/.test(imageId));
  const archive = join(reports, `${prefix}.tar`);
  if (imageId !== undefined) await docker(['image', 'save', imageId, '--output', archive], 120_000);
  else {
    assert(archiveInput !== undefined && archiveInput.endsWith('.tar'));
    await copyFile(archiveInput, archive);
  }
  const result = await scanner(context, 'syft', [
    `docker-archive:/work/${prefix}.tar`,
    '--output',
    'syft-json',
  ]);
  await writeFile(join(reports, `${prefix}.sbom.json`), result.stdout);
  await writeFile(join(reports, `${prefix}.inventory.log`), result.stderr);
  if (result.code !== 0)
    process.stderr.write(
      JSON.stringify({ event: 'security.inventory_failed', exitCode: result.code }) + '\n',
    );
  assert.equal(result.code, 0, 'Inventory generation must succeed.');
  const catalog: unknown = JSON.parse(result.stdout);
  const inventory = readInventory(catalog, release);
  const identity = readCatalogIdentity(catalog);
  if (imageId === undefined) imageId = identity.configDigest;
  else {
    // Docker save can normalize OCI config serialization. Verify the exact
    // ordered filesystem layer hashes rather than equating format-specific IDs.
    const expectedLayers: unknown = JSON.parse(
      await docker(['image', 'inspect', imageId, '--format', '{{json .RootFS.Layers}}']),
    );
    assert.deepEqual(
      identity.filesystemLayers,
      expectedLayers,
      'Catalog must represent the inspected image filesystem.',
    );
  }
  await writeFile(
    join(reports, `${prefix}.identity.json`),
    JSON.stringify(
      {
        imageId,
        catalogConfigDigest: identity.configDigest,
        source: archiveInput === undefined ? 'docker-image-export' : 'docker-archive',
        filesystemLayers: identity.filesystemLayers,
        archiveSha256: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
      },
      null,
      2,
    ),
  );
  return { inventory, imageId };
}

const grypeArgs = (prefix: string) => [
  `sbom:/work/${prefix}.sbom.json`,
  '--config',
  '/policy/grype.json',
  '--output',
  'json',
  '--fail-on',
  'high',
];

async function scanImage(context: ScannerContext, prefix: string) {
  const result = await scanner(context, 'grype', grypeArgs(prefix));
  await writeFile(join(reports, `${prefix}.vulnerabilities.json`), result.stdout);
  await writeFile(join(reports, `${prefix}.exit.json`), JSON.stringify({ code: result.code }));
  await writeFile(join(reports, `${prefix}.scanner.log`), result.stderr);
  return readImageResult(JSON.parse(result.stdout), result.code);
}

async function prepareScannerDatabase(context: ScannerContext) {
  phase = 'Grype database provisioning';
  const update = await scanner(
    context,
    'grype',
    ['db', 'update', '--config', '/policy/grype.json', '-v'],
    false,
    undefined,
    1_200_000,
  );
  await writeFile(join(reports, 'database-update.log'), sanitizeSecurityDiagnostic(update.stderr));
  await writeFile(
    join(reports, 'database-update.exit.json'),
    JSON.stringify({ code: update.code }),
  );
  if (update.code !== 0) throw new SecurityCommandFailure('database');
  phase = 'Grype database verification';
  const status = await scanner(context, 'grype', [
    'db',
    'status',
    '--config',
    '/policy/grype.json',
    '--output',
    'json',
  ]);
  await writeFile(join(reports, 'database-status.json'), status.stdout);
  assert.equal(status.code, 0, 'A valid scanner database is required.');
}

async function policyProof() {
  const fixture = await mkdtemp(join(reports, 'fixture-'));
  const fixtureTag = `beloveddev-security-fixture:${randomUUID()}`;
  const builtImages: string[] = [];
  let context: ScannerContext | undefined;
  try {
    for (const kind of ['production', 'optional', 'development'] as const) {
      const development = kind === 'development';
      const directory = join(fixture, kind);
      await mkdir(join(directory, 'apps/mcp-server'), { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'security-fixture',
          private: true,
          workspaces: ['apps/*'],
          ...(development ? { devDependencies: { lodash: '4.17.20' } } : {}),
        }),
      );
      await writeFile(
        join(directory, 'apps/mcp-server/package.json'),
        JSON.stringify({
          name: '@beloveddev/mcp-server',
          version: '0.0.0',
          ...(!development
            ? {
                [kind === 'optional' ? 'optionalDependencies' : 'dependencies']: {
                  lodash: '4.17.20',
                },
              }
            : {}),
        }),
      );
      const install = await npm(
        [
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          registry,
          '--fetch-retries=1',
          '--fetch-timeout=30000',
        ],
        directory,
      );
      assert.equal(install.code, 0, 'Fixture lockfile generation must succeed.');
      const outcome = await audit(directory, `${kind}.audit.json`);
      assert.equal(outcome.blocked, !development);
      if (development) {
        assert(
          (await audit(directory, 'unfiltered-dev.audit.json', false)).blocked,
          'The dev-only fixture must really be vulnerable.',
        );
      } else {
        assert(
          Object.values(outcome.report.vulnerabilities).some(
            (item) => item.name === 'lodash' && ['high', 'critical'].includes(item.severity),
          ),
        );
      }
    }
    phase = 'npm audit failure enforcement';
    const missingLock = join(fixture, 'missing-lock');
    await mkdir(join(missingLock, 'apps/mcp-server'), { recursive: true });
    await writeFile(
      join(missingLock, 'package.json'),
      JSON.stringify({ name: 'no-lock', private: true, workspaces: ['apps/*'] }),
    );
    await writeFile(
      join(missingLock, 'apps/mcp-server/package.json'),
      JSON.stringify({ name: '@beloveddev/mcp-server', version: '0.0.0' }),
    );
    const missing = await npm(auditArgs(), missingLock);
    assert.notEqual(missing.code, 0);
    const lockError = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(JSON.parse(missing.stdout));
    assert(['ENOLOCK', 'EAUDITNOLOCK'].includes(lockError.error.code));
    assert.throws(() => readAuditResult(JSON.parse(missing.stdout), missing.code));
    const unavailable = await npm(
      [
        ...auditArgs(),
        '--registry=http://127.0.0.1:1',
        '--fetch-retries=0',
        '--fetch-timeout=1000',
      ],
      join(fixture, 'production'),
    );
    assert.notEqual(unavailable.code, 0);
    assert.throws(() => readAuditResult(JSON.parse(unavailable.stdout), unavailable.code));

    phase = 'installed-package fixture npm ci';
    const directory = join(fixture, 'production');
    const install = await npm(
      ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', registry],
      directory,
    );
    assert.equal(install.code, 0);
    await writeFile(
      join(directory, 'Dockerfile'),
      'FROM scratch\nCOPY node_modules/lodash /app/node_modules/lodash\n',
    );
    await writeFile(
      join(directory, '.dockerignore'),
      '**\n!node_modules/\n!node_modules/lodash/\n!node_modules/lodash/**\n',
    );
    phase = 'installed-package fixture docker build';
    await docker(['build', '--provenance=false', '--tag', fixtureTag, directory], 180_000);
    builtImages.push(fixtureTag);
    phase = 'scanner provisioning';
    context = await scannerContext();
    phase = 'missing scanner executable enforcement';
    const missingExecutable = await scanner(
      context,
      'syft',
      ['version'],
      true,
      '/missing-security-scanner',
    );
    assert.notEqual(missingExecutable.code, 0);
    assert.equal(securityFailureKind(missingExecutable.stderr), 'executable');
    phase = 'invalid image reference enforcement';
    await assert.rejects(
      imageInventory(context, 'beloveddev-security-absent:' + randomUUID(), 'invalid-image', false),
      (error: unknown) => error instanceof SecurityCommandFailure && error.kind === 'image',
    );
    phase = 'fixture SBOM generation';
    const { inventory } = await imageInventory(
      context,
      fixtureTag,
      'vulnerable-installed-npm',
      false,
    );
    assert(
      inventory.artifacts.some(
        (item) =>
          item.name === 'lodash' &&
          item.version === '4.17.20' &&
          item.type === 'npm' &&
          item.foundBy === 'javascript-package-cataloger',
      ),
    );
    assert(
      !inventory.artifacts.some((item) => item.foundBy.includes('lock')),
      'The image fixture must not rely on lockfile scanning.',
    );
    await prepareScannerDatabase(context);
    phase = 'fixture vulnerability scan';
    const outcome = await scanImage(context, 'vulnerable-installed-npm');
    assert(outcome.blocked);
    assert(
      outcome.report.matches.some(
        (item) =>
          item.artifact.name === 'lodash' &&
          item.artifact.type === 'npm' &&
          ['High', 'Critical'].includes(item.vulnerability.severity),
      ),
    );

    phase = 'clean fixture installation';
    const clean = join(fixture, 'clean');
    await mkdir(clean);
    await writeFile(
      join(clean, 'package.json'),
      JSON.stringify({
        name: 'security-clean-fixture',
        private: true,
        dependencies: { 'is-number': '7.0.0' },
      }),
    );
    const cleanInstall = await npm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', registry],
      clean,
    );
    assert.equal(cleanInstall.code, 0);
    await writeFile(
      join(clean, 'Dockerfile'),
      'FROM scratch\nCOPY node_modules/is-number /app/node_modules/is-number\n',
    );
    await writeFile(
      join(clean, '.dockerignore'),
      '**\n!node_modules/\n!node_modules/is-number/\n!node_modules/is-number/**\n',
    );
    const cleanTag = fixtureTag + '-clean';
    phase = 'clean fixture build';
    await docker(['build', '--provenance=false', '--tag', cleanTag, clean], 180_000);
    builtImages.push(cleanTag);
    phase = 'clean fixture SBOM and scan';
    const cleanInventory = await imageInventory(context, cleanTag, 'clean-installed-npm', false);
    assert(
      cleanInventory.inventory.artifacts.some(
        (item) =>
          item.type === 'npm' &&
          item.name === 'is-number' &&
          item.version === '7.0.0' &&
          item.foundBy === 'javascript-package-cataloger',
      ),
    );
    const cleanResult = await scanImage(context, 'clean-installed-npm');
    assert.equal(cleanResult.blocked, false);
    phase = 'scanner database failure enforcement';
    const unavailableDb = await scanner(
      context,
      'grype',
      grypeArgs('vulnerable-installed-npm'),
      true,
    );
    assert(/failed to load vulnerability db/i.test(unavailableDb.stderr));
    assert.notEqual(
      unavailableDb.code,
      0,
      'An update-check failure must not use the cache as a silent success.',
    );
    assert.throws(() => readImageResult(JSON.parse(unavailableDb.stdout), unavailableDb.code));
    phase = 'malformed scanner input enforcement';
    await writeFile(join(reports, 'invalid.sbom.json'), '{invalid');
    const invalid = await scanner(context, 'grype', grypeArgs('invalid'));
    assert.notEqual(invalid.code, 0);
    assert(
      /invalid character|invalid.*(?:JSON|SBOM)|unable to decode|unable to parse/i.test(
        invalid.stderr,
      ),
    );
    assert.throws(() => readImageResult(JSON.parse(invalid.stdout), invalid.code));
    await writeFile(
      join(reports, 'policy-proof.json'),
      JSON.stringify(
        {
          scannerVersionsVerified: true,
          missingScannerExecutableRejected: true,
          invalidImageRejected: true,
          cleanInstalledNpmScanPassed: true,
          productionVulnerabilityBlocked: true,
          optionalProductionVulnerabilityBlocked: true,
          developmentOnlyExcluded: true,
          unfilteredDevelopmentBlocked: true,
          missingLockRejected: true,
          registryFailureRejected: true,
          installedNpmWithoutLockBlocked: true,
          cachedDatabaseNetworkFailureRejected: true,
          malformedScannerInputRejected: true,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        for (const tag of builtImages) await docker(['image', 'rm', tag]);
      } finally {
        assert.equal(dirname(resolve(fixture)), resolve(reports));
        assert(basename(fixture).startsWith('fixture-'));
        await rm(fixture, { recursive: true, force: true });
      }
    }
  }
}

async function main() {
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const mode = process.argv[2];
  if (mode === 'dependencies') {
    phase = 'production npm audit';
    const outcome = await audit(root, 'production-dependencies.json');
    process.stderr.write(
      JSON.stringify({
        event: 'security.dependencies_audited',
        vulnerabilities: outcome.report.metadata.vulnerabilities,
        blocked: outcome.blocked,
      }) + '\n',
    );
    policyBlocked = outcome.blocked;
    assert(!outcome.blocked, 'Production dependencies exceed the policy.');
  } else if (mode === 'image') {
    phase = 'release image inventory';
    const context = await scannerContext();
    try {
      const images = process.argv.slice(3);
      if (images.length === 0) images.push('beloveddev-mcp:container-smoke');
      const candidates: {
        inventory: ReturnType<typeof readInventory>;
        imageId: string;
        prefix: string;
      }[] = [];
      for (const [index, image] of images.entries()) {
        const prefix = images.length === 1 ? 'release' : 'release-' + (index + 1);
        phase = 'release image inventory';
        const { inventory, imageId } = await imageInventory(context, image, prefix, true);
        candidates.push({ inventory, imageId, prefix });
      }
      await prepareScannerDatabase(context);
      for (const { inventory, imageId, prefix } of candidates) {
        phase = 'release image vulnerability policy';
        const outcome = await scanImage(context, prefix);
        process.stderr.write(
          JSON.stringify({
            event: 'security.image_scanned',
            imageId,
            reportPrefix: prefix,
            packages: inventory.artifacts.length,
            findings: outcome.report.matches.length,
            high: outcome.report.matches.filter((item) => item.vulnerability.severity === 'High')
              .length,
            critical: outcome.report.matches.filter(
              (item) => item.vulnerability.severity === 'Critical',
            ).length,
            uniqueBlockingAdvisories: new Set(
              outcome.report.matches
                .filter((item) => ['High', 'Critical'].includes(item.vulnerability.severity))
                .map((item) => item.vulnerability.id),
            ).size,
            blocked: outcome.blocked,
          }) + '\n',
        );
        policyBlocked ||= outcome.blocked;
      }
      assert(!policyBlocked, 'Release vulnerabilities exceed the policy.');
    } finally {
      await context.close();
    }
  } else if (mode === 'verify') {
    phase = 'npm audit policy enforcement';
    await policyProof();
  } else throw new Error('Unknown security check.');
  process.stderr.write(
    JSON.stringify({ event: 'security.check_passed', check: mode, reports: reportPath }) + '\n',
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error: unknown) {
    // Reports contain public package/advisory metadata; operational output never
    // serializes raw errors, environment values, process arguments, or stacks.
    process.stderr.write(
      JSON.stringify({
        event: 'security.check_failed',
        phase,
        kind: policyBlocked
          ? 'vulnerability_policy'
          : error instanceof SecurityCommandFailure
            ? error.kind
            : 'validation',
        reports: reportPath,
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
