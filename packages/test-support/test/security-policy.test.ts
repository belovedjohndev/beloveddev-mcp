import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readAuditResult,
  readCatalogIdentity,
  readImageResult,
  readInventory,
  sanitizeSecurityDiagnostic,
  securityFailureKind,
  stageScannerInputs,
  validateGrypePolicy,
} from '../../../scripts/security-check.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const image = () => ({
  matches: [],
  descriptor: {
    name: 'grype',
    version: '0.120.1',
    db: { status: { valid: true, built: new Date(now).toISOString(), schemaVersion: '6' } },
  },
});
const match = (severity: string) => ({
  vulnerability: { id: 'CVE-fixture', severity },
  artifact: { name: 'fixture', version: '1', type: 'npm' },
});
const audit = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 1 },
  },
});

const configuredPolicy = (): unknown =>
  JSON.parse(readFileSync(new URL('../../../security/grype.json', import.meta.url), 'utf8'));
const approvedPolicy = () => validateGrypePolicy(configuredPolicy());

async function withScannerFixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'beloveddev-scanner-test-'));
  try {
    await run(directory);
  } finally {
    expect(dirname(directory)).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^beloveddev-scanner-test-/);
    await rm(directory, { recursive: true, force: true });
  }
}

describe('explicit scanner input staging', () => {
  it('copies only selected inputs to read-only file mounts without exposing private diagnostics', async () => {
    await withScannerFixture(async (directory) => {
      const source = join(directory, 'selected.sbom.json');
      await writeFile(source, '{"artifacts":[]}');
      await writeFile(join(directory, 'private.log'), 'private-diagnostic-sentinel');
      const staging = await stageScannerInputs([{ source, target: '/work/selected.sbom.json' }]);
      try {
        expect(staging.files).toHaveLength(1);
        const file = staging.files[0]!;
        expect(await readFile(file.staged, 'utf8')).toBe(await readFile(source, 'utf8'));
        expect(staging.mounts).toEqual([
          '--mount',
          'type=bind,source=' + file.staged + ',target=/work/selected.sbom.json,readonly',
        ]);
        expect(staging.mounts.join(' ')).not.toContain(directory);
        expect(staging.mounts.join(' ')).not.toContain('private.log');
        if (process.platform === 'linux')
          expect((await stat(file.staged)).mode & 0o777).toBe(0o444);
        await staging.verify();
      } finally {
        await staging.close();
      }
      await expect(stat(staging.files[0]!.staged)).rejects.toThrow();
    });
  });

  it.each(['missing', 'empty', 'directory'])(
    'rejects %s inputs before invoking a scanner',
    async (kind) => {
      await withScannerFixture(async (directory) => {
        const source = join(directory, 'input');
        if (kind === 'empty') await writeFile(source, '');
        if (kind === 'directory') await mkdir(source);
        await expect(stageScannerInputs([{ source, target: '/work/input.tar' }])).rejects.toThrow();
      });
    },
  );

  it.skipIf(process.platform === 'win32')('rejects symlink inputs', async () => {
    await withScannerFixture(async (directory) => {
      await writeFile(join(directory, 'target'), 'unselected');
      const source = join(directory, 'link');
      await symlink(join(directory, 'target'), source);
      await expect(stageScannerInputs([{ source, target: '/work/input.tar' }])).rejects.toThrow();
    });
  });

  it.each([
    '/work/../private.log',
    '/work/input.tar,readonly=false',
    '/work/credentials.env',
    '/policy/toolchain.json',
  ])('rejects unapproved mount target %s', async (target) => {
    await withScannerFixture(async (directory) => {
      const source = join(directory, 'source');
      await writeFile(source, 'fixture');
      await expect(stageScannerInputs([{ source, target }])).rejects.toThrow();
    });
  });

  it('rejects duplicate input targets', async () => {
    await withScannerFixture(async (directory) => {
      const source = join(directory, 'source');
      await writeFile(source, 'fixture');
      const input = { source, target: '/work/input.tar' };
      await expect(stageScannerInputs([input, input])).rejects.toThrow();
    });
  });

  it('fails integrity verification if original evidence changes', async () => {
    await withScannerFixture(async (directory) => {
      const source = join(directory, 'source');
      await writeFile(source, 'fixture');
      const staging = await stageScannerInputs([{ source, target: '/work/input.tar' }]);
      try {
        await writeFile(source, 'changed');
        await expect(staging.verify()).rejects.toThrow('Original scanner evidence changed');
      } finally {
        await staging.close();
      }
    });
  });
});

describe('approved Grype configuration', () => {
  it('accepts the complete committed policy without dropping fields', () => {
    const value = configuredPolicy();
    expect(validateGrypePolicy(value)).toStrictEqual(value);
  });

  it('rejects unexpected top-level settings', () => {
    expect(() => validateGrypePolicy({ ...approvedPolicy(), unexpected: true })).toThrow();
  });

  it('rejects unexpected database settings', () => {
    const value = approvedPolicy();
    expect(() =>
      validateGrypePolicy({ ...value, db: { ...value.db, unexpected: true } }),
    ).toThrow();
  });

  it.each(['low', 'medium', 'critical'])('rejects a changed %s severity threshold', (severity) => {
    expect(() =>
      validateGrypePolicy({ ...approvedPolicy(), 'fail-on-severity': severity }),
    ).toThrow();
  });

  it.each([
    ['ignore', [{ vulnerability: 'CVE-fixture' }]],
    ['exclude', ['/app/**']],
    ['vex-documents', ['/policy/exception.json']],
    ['only-fixed', true],
    ['only-notfixed', true],
    ['check-for-app-update', true],
  ])('rejects unapproved top-level policy %s', (field, value) => {
    expect(() => validateGrypePolicy({ ...approvedPolicy(), [field]: value })).toThrow();
  });

  it.each([
    ['cache-dir', '/alternate-cache'],
    ['auto-update', false],
    ['validate-by-hash-on-start', false],
    ['validate-age', false],
    ['max-allowed-built-age', '121h'],
    ['require-update-check', false],
    ['max-update-check-frequency', '24h'],
    ['update-available-timeout', '31s'],
    ['update-download-timeout', '6m'],
  ])('rejects unapproved database policy %s', (field, replacement) => {
    const value = approvedPolicy();
    expect(() =>
      validateGrypePolicy({ ...value, db: { ...value.db, [field]: replacement } }),
    ).toThrow();
  });

  it.each(['update-available-timeout', 'update-download-timeout'])(
    'requires the approved %s setting',
    (field) => {
      const value = approvedPolicy();
      const db: Record<string, unknown> = { ...value.db };
      delete db[field];
      expect(() => validateGrypePolicy({ ...value, db })).toThrow();
    },
  );
});

describe('security gate result validation', () => {
  it('binds catalog identity to its config digest and ordered filesystem layers', () => {
    const layers = ['sha256:' + 'a'.repeat(64)];
    const raw = Buffer.from(JSON.stringify({ rootfs: { diff_ids: layers } }));
    const imageID = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const value = { source: { metadata: { imageID, config: raw.toString('base64') } } };
    expect(readCatalogIdentity(value)).toEqual({ configDigest: imageID, filesystemLayers: layers });
    expect(() =>
      readCatalogIdentity({
        source: { metadata: { ...value.source.metadata, imageID: 'sha256:' + 'b'.repeat(64) } },
      }),
    ).toThrow();
    expect(() => readCatalogIdentity({})).toThrow();
    const invalid = Buffer.from(JSON.stringify({ rootfs: { diff_ids: [] } }));
    expect(() =>
      readCatalogIdentity({
        source: {
          metadata: {
            imageID: 'sha256:' + createHash('sha256').update(invalid).digest('hex'),
            config: invalid.toString('base64'),
          },
        },
      }),
    ).toThrow();
  });
  it('requires both a complete npm report and matching successful exit status', () => {
    expect(readAuditResult(audit(), 0).blocked).toBe(false);
    expect(() => readAuditResult(audit(), 1)).toThrow();
    for (const value of [{}, { error: { code: 'ENOAUDIT' } }, { vulnerabilities: {} }]) {
      expect(() => readAuditResult(value, 0)).toThrow();
    }
  });
  it.each(['high', 'critical'])(
    'rejects npm %s findings even if a faulty runner exits zero',
    (severity) => {
      const report = { ...audit(), vulnerabilities: { fixture: { name: 'fixture', severity } } };
      expect(readAuditResult(report, 1).blocked).toBe(true);
      expect(() => readAuditResult(report, 0)).toThrow();
    },
  );
  it.each(['High', 'Critical'])(
    'rejects image %s findings including those without fixes',
    (severity) => {
      const report = {
        ...image(),
        matches: [
          {
            ...match(severity),
            vulnerability: {
              ...match(severity).vulnerability,
              fix: { state: 'not-fixed', versions: [] },
            },
          },
        ],
      };
      expect(readImageResult(report, 2, now).blocked).toBe(true);
      expect(() => readImageResult(report, 0, now)).toThrow();
    },
  );
  it('keeps lower-severity findings visible without changing the High threshold', () => {
    expect(
      readImageResult({ ...image(), matches: [match('Medium')] }, 0, now).report.matches,
    ).toHaveLength(1);
  });
  it('fails closed on missing, invalid, stale or future-dated database metadata and suppressed findings', () => {
    for (const status of [
      undefined,
      { valid: false },
      { valid: true, built: new Date(now - 121 * 3600_000).toISOString(), schemaVersion: '6' },
      { valid: true, built: new Date(now + 3600_000).toISOString(), schemaVersion: '6' },
      { ...image().descriptor.db.status, error: 'failure' },
    ]) {
      expect(() =>
        readImageResult(
          { ...image(), descriptor: { ...image().descriptor, db: { status } } },
          0,
          now,
        ),
      ).toThrow();
    }
    expect(() => readImageResult({ ...image(), ignoredMatches: [{}] }, 0, now)).toThrow();
    expect(() => readImageResult(image(), 1, now)).toThrow();
    expect(() => readImageResult({}, 0, now)).toThrow();
  });
  it('requires real OS and installed production npm inventory, not an empty green report', () => {
    const artifact = (name: string, type: string) => ({
      name,
      type,
      version: '1',
      foundBy: type === 'npm' ? 'javascript-package-cataloger' : 'dpkg-db-cataloger',
    });
    const value = {
      descriptor: { name: 'syft', version: '1.54.1' },
      source: { type: 'image' },
      artifacts: [
        artifact('libc6', 'deb'),
        ...['@modelcontextprotocol/server', 'zod', 'pg'].map((name) => artifact(name, 'npm')),
      ],
    };
    expect(readInventory(value, true).artifacts).toHaveLength(4);
    for (const artifacts of [
      [],
      value.artifacts.slice(1),
      value.artifacts.slice(0, -1),
      ...[
        'typescript',
        'vitest',
        'eslint',
        'vite',
        'launch-editor',
        '@modelcontextprotocol/client',
      ].map((name) => [...value.artifacts, artifact(name, 'npm')]),
      value.artifacts.map((item) => ({ ...item, foundBy: 'javascript-lock-cataloger' })),
    ]) {
      expect(() => readInventory({ ...value, artifacts }, true)).toThrow();
    }
  });
});

describe('security command diagnostics', () => {
  it('retains useful public tool errors without credentials, PEM or sensitive lines', () => {
    const value =
      'certificate validation failed\nhttps://operator:private-value@registry.invalid/path\nAuthorization: Bearer private-value\nMCP_CURSOR_SECRET=private-value\n-----BEGIN CERTIFICATE-----\nprivate-value\n-----END CERTIFICATE-----';
    const result = sanitizeSecurityDiagnostic(value);
    expect(result).toContain('certificate validation failed');
    expect(result).not.toContain('private-value');
    expect(result).not.toContain('operator:');
    expect(result).not.toContain('BEGIN CERTIFICATE');
    expect(sanitizeSecurityDiagnostic('x'.repeat(20000))).toHaveLength(8192);
  });
  it.each([
    ['exec: executable file not found', 'executable'],
    [
      'OCI runtime create failed: exec: /missing: stat /missing: no such file or directory',
      'executable',
    ],
    ['x509: certificate has expired', 'tls'],
    ['failed to load vulnerability db', 'database'],
    ['manifest unknown', 'image'],
    ['unable to parse SBOM', 'input'],
    ['dial tcp: connection refused', 'network'],
    ['found high vulnerabilities', 'nonzero_exit'],
  ])('classifies public diagnostics without declaring policy findings (%s)', (message, kind) => {
    expect(securityFailureKind(message)).toBe(kind);
  });
});
