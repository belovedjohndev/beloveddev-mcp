import { openDatabase } from '@beloveddev/database/client';
import { migrateDatabase } from '@beloveddev/database/migrate';
import {
  EnvironmentValidationError,
  parseEnvironment,
} from '@beloveddev/infrastructure/environment';
import { createLogger } from '@beloveddev/infrastructure/logger';

const logger = createLogger('info');
try {
  const environment = parseEnvironment(process.env);
  const connection = openDatabase(environment.DATABASE_URL, {
    onIdleError: () => logger.error({ event: 'database.idle_error' }, 'Database connection failed'),
  });
  try {
    await migrateDatabase(connection.db);
    logger.info({ event: 'database.migrated' }, 'Database migrations applied');
  } finally {
    await connection.close();
  }
} catch (error: unknown) {
  logger.error(
    {
      event: 'database.migration_failed',
      invalidVariables: error instanceof EnvironmentValidationError ? error.fields : [],
    },
    'Database migration failed; verify configuration, connectivity, and migration permissions',
  );
  process.exitCode = 1;
}
