import {
  EnvironmentValidationError,
  parseEnvironment,
} from '@beloveddev/infrastructure/environment';
import { createLogger } from '@beloveddev/infrastructure/logger';

try {
  const environment = parseEnvironment(process.env);
  const logger = createLogger(environment.LOG_LEVEL);
  logger.info(
    { event: 'foundation.ready', environment: environment.NODE_ENV },
    'Configuration validated; no MCP transport is started',
  );
} catch (error: unknown) {
  const logger = createLogger('error');
  logger.error(
    {
      event: 'configuration.invalid',
      invalidVariables: error instanceof EnvironmentValidationError ? error.fields : [],
    },
    'Unable to initialize configuration',
  );
  process.exitCode = 1;
}
