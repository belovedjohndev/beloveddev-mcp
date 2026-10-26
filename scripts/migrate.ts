import {
  migrateDatabase,
  MigrationError,
  MigrationConfigurationError,
  parseMigrationEnvironment,
} from '@beloveddev/database/migrate';
import { createLogger } from '@beloveddev/infrastructure/logger';

const logger = createLogger('info');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const started = performance.now();
try {
  await migrateDatabase(parseMigrationEnvironment(process.env), { signal: controller.signal });
  logger.info(
    { event: 'database.migrated', durationMs: Math.round(performance.now() - started) },
    'Database migrations verified and administrative connection closed',
  );
} catch (error: unknown) {
  logger.error(
    {
      event: 'database.migration_failed',
      category:
        error instanceof MigrationConfigurationError
          ? 'CONFIGURATION'
          : error instanceof MigrationError
            ? error.category
            : 'INTERNAL',
      outcome: 'unconfirmed',
      durationMs: Math.round(performance.now() - started),
    },
    'Database migration failed; verify configuration, connectivity, and migration permissions',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
