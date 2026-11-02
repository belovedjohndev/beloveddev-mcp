import {
  migrateReplayDatabase,
  parseReplayMigrationEnvironment,
} from '@beloveddev/database/evaluation-replay-migrate';
import { ReplayError } from '@beloveddev/database/evaluation-replay';
import { createLogger } from '@beloveddev/infrastructure/logger';

const logger = createLogger('info');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await migrateReplayDatabase(parseReplayMigrationEnvironment(process.env), {
    deadlineAt: performance.now() + 30000,
    signal: controller.signal,
  });
  logger.info({ event: 'evaluation_replay.migrated' }, 'Evaluator migration ledger verified');
} catch (error: unknown) {
  logger.error(
    {
      event: 'evaluation_replay.migration_failed',
      category: error instanceof ReplayError ? error.category : 'INTERNAL',
      outcome: 'unconfirmed',
    },
    'Evaluator migration was not confirmed',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
