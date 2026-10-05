export type RepositoryErrorCode =
  'CONFLICT' | 'INVALID_REFERENCE' | 'INVALID_INPUT' | 'UNAVAILABLE';

const messages: Record<RepositoryErrorCode, string> = {
  CONFLICT: 'The record conflicts with an existing record.',
  INVALID_REFERENCE: 'A referenced record is not available in this tenant.',
  INVALID_INPUT: 'The record does not satisfy storage constraints.',
  UNAVAILABLE: 'The repository operation could not be completed.',
};

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode) {
    super(messages[code]);
    this.name = 'RepositoryError';
  }
}
