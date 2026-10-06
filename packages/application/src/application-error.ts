import { RepositoryError } from './repository-error.js';

export const applicationErrorCodes = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ApplicationErrorCode = (typeof applicationErrorCodes)[number];

const messages: Record<ApplicationErrorCode, string> = {
  UNAUTHENTICATED: 'A trusted active principal is required.',
  FORBIDDEN: 'The required permission is missing.',
  VALIDATION_ERROR: 'The input is invalid.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The operation conflicts with existing data.',
  RATE_LIMITED: 'Too many requests.',
  INTERNAL_ERROR: 'The operation could not be completed.',
};

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode) {
    super(messages[code]);
    this.name = 'ApplicationError';
  }
}

export function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RepositoryError) {
    if (error.code === 'INVALID_INPUT') return new ApplicationError('VALIDATION_ERROR');
    if (error.code === 'CONFLICT') return new ApplicationError('CONFLICT');
  }
  return new ApplicationError('INTERNAL_ERROR');
}

export async function applicationOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toApplicationError(error);
  }
}
