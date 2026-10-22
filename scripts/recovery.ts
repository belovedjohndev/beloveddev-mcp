import {
  createBackup,
  validateBackup,
  withRestoredDatabase,
  parseRecoveryEnvironment,
  RecoveryError,
} from '@beloveddev/database/recovery';
import { createLogger } from '@beloveddev/infrastructure/logger';

const logger = createLogger('info');
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const started = performance.now();
try {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length > 0 || !['backup', 'validate', 'drill'].includes(command ?? ''))
    throw new RecoveryError('CONFIGURATION');
  const configuration = parseRecoveryEnvironment(
    process.env,
    command === 'backup' ? 'backup' : 'restore',
  );
  if (command === 'backup') {
    const manifest = await createBackup(configuration, directory, abort.signal);
    logger.info(
      {
        event: 'database.backup_validated',
        bytes: manifest.bytes,
        sha256: manifest.sha256,
        durationMs: manifest.backupDurationMs,
      },
      'Backup archive validated; restoration still requires a drill',
    );
  } else if (command === 'validate') {
    const manifest = await validateBackup(configuration, directory, abort.signal);
    logger.info(
      { event: 'database.backup_validated', bytes: manifest.bytes, sha256: manifest.sha256 },
      'Archive validated; restoration has not been demonstrated',
    );
  } else {
    const result = await withRestoredDatabase(
      configuration,
      directory,
      () => Promise.resolve(),
      abort.signal,
    );
    logger.info(
      {
        event: 'database.restore_verified',
        restoreDurationMs: result.restoreDurationMs,
        durationMs: Math.round(performance.now() - started),
      },
      'All table digests, ledger, schema and runtime readiness verified; isolated target retired',
    );
  }
} catch (error: unknown) {
  logger.error(
    {
      event: 'database.recovery_failed',
      category: error instanceof RecoveryError ? error.category : 'INTERNAL',
      outcome: 'unconfirmed',
      durationMs: Math.round(performance.now() - started),
    },
    'Recovery operation not verified; inspect protected artifacts and owned temporary resources',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
