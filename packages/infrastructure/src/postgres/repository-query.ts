import { RepositoryError } from '@beloveddev/application/repository-error';

function sqlState(error: unknown): string | undefined {
  let current = error;
  // Drizzle wraps driver errors; inspect only the SQLSTATE, never retain raw details.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export async function repositoryQuery<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error: unknown) {
    if (error instanceof RepositoryError) throw error;
    const code = sqlState(error);
    if (code === '23505') throw new RepositoryError('CONFLICT');
    if (code === '23503') throw new RepositoryError('INVALID_REFERENCE');
    if (code === '23514' || code === '23502' || code?.startsWith('22')) {
      throw new RepositoryError('INVALID_INPUT');
    }
    throw new RepositoryError('UNAVAILABLE');
  }
}
