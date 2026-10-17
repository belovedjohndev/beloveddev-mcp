export const DRAIN_TIMEOUT_MS = 10_000;
export const SHUTDOWN_TIMEOUT_MS = 15_000;

type ShutdownReason =
  'SIGINT' | 'SIGTERM' | 'transport_closed' | 'database_error' | 'startup_error';
type CleanupPhase = 'input' | 'transport' | 'database' | 'output';

interface LifecycleOptions {
  readonly pauseInput: () => void;
  readonly closeTransport: () => Promise<void>;
  readonly closeDatabase: () => Promise<void>;
  readonly finishOutput: () => Promise<void>;
  readonly terminate: (code: 0 | 1) => void;
  readonly logger: {
    info(record: Record<string, unknown>, message: string): void;
    error(record: Record<string, unknown>, message: string): void;
  };
}

/** Process-owned admission, draining, and cleanup; never cancels or retries a use case. */
export class StdioLifecycle {
  private stopping = false;
  private finished = false;
  private failed = false;
  private active = 0;
  private idle: (() => void) | undefined;
  private shutdown: Promise<void> | undefined;

  constructor(private readonly options: LifecycleOptions) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  databaseError(source: 'idle' | 'client'): Promise<void> {
    if (!this.finished) {
      this.log(
        'error',
        {
          event: source === 'idle' ? 'database.idle_error' : 'database.client_error',
        },
        'Database connection failed',
      );
    }
    return this.stop('database_error');
  }

  /** Called before trusted-context resolution. Null means no application work may start. */
  enter(): (() => void) | null {
    if (this.stopping) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active === 0) this.idle?.();
    };
  }

  stop(reason: ShutdownReason): Promise<void> {
    if (reason === 'database_error' || reason === 'startup_error') this.failed = true;
    if (this.shutdown !== undefined) return this.shutdown;
    this.stopping = true;
    // Cache before any cleanup can re-enter through the SDK's onclose callback.
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.shutdown = completion;
    const deadline = setTimeout(() => {
      this.log(
        'error',
        { event: 'mcp.shutdown_timeout', activeInvocations: this.active },
        'Shutdown deadline exceeded; operation outcomes may be unknown',
      );
      finish(1);
    }, SHUTDOWN_TIMEOUT_MS);
    const finish = (code: 0 | 1) => {
      if (this.finished) return;
      this.finished = true;
      clearTimeout(deadline);
      resolveCompletion?.();
      this.options.terminate(code);
    };
    this.log(
      'info',
      { event: 'mcp.stopping', reason, activeInvocations: this.active },
      'Stopping MCP server',
    );
    try {
      this.options.pauseInput();
    } catch {
      this.cleanupFailed('input');
    }
    void this.close().then(
      () => {
        if (this.finished) return;
        const code = this.failed ? 1 : 0;
        this.log('info', { event: 'mcp.stopped', exitCode: code }, 'MCP server stopped');
        finish(this.failed ? 1 : 0);
      },
      () => finish(1),
    );
    return completion;
  }

  private async drain(): Promise<void> {
    if (this.active === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = await new Promise<boolean>((resolve) => {
        this.idle = () => resolve(true);
        timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS);
      });
      if (!drained) {
        this.failed = true;
        this.log(
          'error',
          { event: 'mcp.drain_timeout', activeInvocations: this.active },
          'In-flight operations did not settle; operation outcomes may be unknown',
        );
      }
    } finally {
      clearTimeout(timer);
      this.idle = undefined;
    }
  }

  private cleanupFailed(phase: CleanupPhase): void {
    if (this.finished) return;
    this.failed = true;
    this.log('error', { event: 'mcp.shutdown_failed', phase }, 'Unable to close server resources');
  }

  private log(level: 'info' | 'error', record: Record<string, unknown>, message: string): void {
    try {
      this.options.logger[level](record, message);
    } catch {
      // A failed diagnostic sink must neither skip cleanup nor defeat the watchdog.
      // Do not fall back to stdout or include the sink's raw error.
      this.failed = true;
    }
  }

  private async attempt(phase: CleanupPhase, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.cleanupFailed(phase);
    }
  }

  private async close(): Promise<void> {
    await this.drain();
    if (this.finished) return;
    // Start both independently: a rejected or stuck transport must not strand the pool.
    await Promise.all([
      this.attempt('transport', this.options.closeTransport),
      this.attempt('database', this.options.closeDatabase),
    ]);
    if (this.finished) return;
    await this.attempt('output', this.options.finishOutput);
  }
}
