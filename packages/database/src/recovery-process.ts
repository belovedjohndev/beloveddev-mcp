import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryError, assertNotAborted, type RecoveryConfiguration } from './recovery-policy.js';

/** Never inherit libpq service, SSL, password, endpoint, or session overrides. */
export async function withRecoveryTools<T>(
  configuration: RecoveryConfiguration,
  signal: AbortSignal,
  action: (run: ReturnType<typeof utilityRunner>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'beloveddev-recovery-'));
  const passfile = join(directory, 'pgpass');
  const rootcert = join(directory, 'ca.pem');
  try {
    const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    await writeFile(
      passfile,
      [
        configuration.host,
        String(configuration.port),
        '*',
        configuration.user,
        configuration.password,
      ]
        .map(escape)
        .join(':') + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    if (configuration.ca !== undefined)
      await writeFile(rootcert, configuration.ca, { mode: 0o600, flag: 'wx' });
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    Object.assign(environment, {
      PGHOST: configuration.host,
      PGPORT: String(configuration.port),
      PGUSER: configuration.user,
      PGDATABASE: configuration.database,
      PGPASSFILE: passfile,
      PGSSLMODE: configuration.tls ? 'verify-full' : 'disable',
      PGSSLROOTCERT: configuration.tls
        ? configuration.ca === undefined
          ? 'system'
          : rootcert
        : '',
      PGSSLMINPROTOCOLVERSION: 'TLSv1.2',
      PGSSLNEGOTIATION: 'postgres',
      PGCONNECT_TIMEOUT: '5',
      PGCLIENTENCODING: 'UTF8',
      PGAPPNAME: 'beloveddev-recovery-utility',
      PGOPTIONS:
        '-c statement_timeout=120000 -c lock_timeout=5000 -c client_connection_check_interval=1000 -c timezone=UTC',
      LC_ALL: 'C',
    });
    const run = utilityRunner(configuration, environment, signal);
    for (const utility of ['pg_dump', 'pg_restore'] as const) {
      const version = await run(utility, ['--version']);
      if (!/^pg_(?:dump|restore) \(PostgreSQL\) 18(?:\.|\s)/.test(version))
        throw new RecoveryError('CLIENT_VERSION');
    }
    return await action(run);
  } finally {
    // Only fixed files in this invocation's mkdtemp directory are eligible.
    await Promise.allSettled([unlink(passfile), unlink(rootcert)]);
    await rmdir(directory);
  }
}

function utilityRunner(
  configuration: RecoveryConfiguration,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  return async (
    utility: 'pg_dump' | 'pg_restore',
    args: string[],
    output?: number | 'discard',
  ): Promise<string> => {
    assertNotAborted(signal);
    const executable =
      configuration.binaryDirectory === undefined
        ? utility
        : join(
            configuration.binaryDirectory,
            utility + (process.platform === 'win32' ? '.exe' : ''),
          );
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: [
          'ignore',
          typeof output === 'number' ? output : output === 'discard' ? 'ignore' : 'pipe',
          'pipe',
        ],
      });
      let text = '';
      let warning = false;
      let failed = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill('SIGKILL');
        grace ??= setTimeout(() => {
          failed = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          reject(new RecoveryError('CLEANUP'));
        }, 5_000);
      };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (text.length + chunk.length > 10_000_000) {
          failed = true;
          child.kill('SIGKILL');
        } else text += chunk.toString('utf8');
      });
      child.stderr?.on('data', () => {
        warning = true;
      });
      child.on('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        clearTimeout(grace);
        signal.removeEventListener('abort', abort);
        try {
          assertNotAborted(signal);
          if (failed || code !== 0 || warning) throw new RecoveryError('PROCESS');
          resolve(text);
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new RecoveryError('PROCESS'));
        }
      });
      if (signal.aborted) abort();
    });
  };
}
