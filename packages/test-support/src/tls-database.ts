import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Disposable TLS-only fixture; never reconfigures the caller's PostgreSQL server. */
export async function createTlsPostgres() {
  const name = `beloveddev_tls_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const fixtures = fileURLToPath(new URL('../fixtures/tls/', import.meta.url));
  const ca = await readFile(new URL('../fixtures/tls/ca.crt', import.meta.url), 'utf8');
  const docker = async (...args: string[]) => {
    const result = await exec('docker', args, { timeout: 30_000, windowsHide: true });
    return result.stdout.trim();
  };
  const close = async () => {
    if (!/^beloveddev_tls_test_[0-9a-f]{32}$/.test(name))
      throw new Error('Unexpected TLS fixture name');
    await docker('rm', '--force', name);
  };
  try {
    await docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--mount',
      `type=bind,source=${fixtures},target=/run/test-tls,readonly`,
      '--publish',
      '127.0.0.1::5432',
      // Ephemeral TLS tests need no durable volume. Avoid host-filesystem initdb
      // fsync latency competing with the real durability/transaction suites.
      '--tmpfs',
      '/var/lib/postgresql:rw,noexec,nosuid,size=512m',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      'postgres:18',
      'bash',
      '-ec',
      'mkdir /tmp/private-tls; cp /run/test-tls/server.* /tmp/private-tls/; chown -R postgres:postgres /tmp/private-tls; chmod 600 /tmp/private-tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/private-tls/server.crt -c ssl_key_file=/tmp/private-tls/server.key',
    );
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        // pg_isready must probe TCP: initdb's temporary Unix-socket-only server
        // does not yet accept application connections.
        await docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres');
        ready = true;
        break;
      } catch {
        await setTimeout(100);
      }
    }
    if (!ready) {
      const diagnostics = await docker('logs', name);
      throw new Error(`TLS PostgreSQL fixture did not become ready: ${diagnostics}`);
    }
    const endpoint = await docker('port', name, '5432/tcp');
    const port = /127\.0\.0\.1:(\d+)/.exec(endpoint)?.[1];
    if (port === undefined) throw new Error('Unexpected TLS PostgreSQL port');
    return {
      ca,
      url: `postgresql://postgres:${password}@localhost:${port}/postgres?sslmode=verify-full`,
      close,
    };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}
