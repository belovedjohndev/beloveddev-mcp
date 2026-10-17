import { ApplicationError } from '@beloveddev/application/application-error';

export const MAX_ACTIVE_INVOCATIONS = 8;
export const APPLICATION_RESPONSE_DEADLINE_MS = 30_000;
export const MAX_SUCCESS_RESPONSE_BYTES = 1_048_576;

/** One process-owned capacity gate, also usable by an isolated MCP server. No queue. */
export class InvocationAdmission {
  private active = 0;

  constructor(private readonly lifecycle?: { enter(): (() => void) | null }) {}

  enter(): () => void {
    // Preserve shutdown refusal even when every capacity slot is occupied.
    const lifecycleRelease = this.lifecycle?.enter();
    if (lifecycleRelease === null) throw new ApplicationError('INTERNAL_ERROR');
    if (this.active >= MAX_ACTIVE_INVOCATIONS) {
      lifecycleRelease?.();
      throw new ApplicationError('RATE_LIMITED');
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      lifecycleRelease?.();
    };
  }
}
