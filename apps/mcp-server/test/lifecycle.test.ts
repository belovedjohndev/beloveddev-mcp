import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS, StdioLifecycle } from '../src/lifecycle.js';

function deferred() {
  let resolve: (() => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve: () => resolve?.(), reject: (reason: unknown) => reject?.(reason) };
}

function fixture() {
  const options = {
    pauseInput: vi.fn<() => void>(),
    closeTransport: vi.fn(async () => {}),
    closeDatabase: vi.fn(async () => {}),
    finishOutput: vi.fn(async () => {}),
    terminate: vi.fn<(code: 0 | 1) => void>(),
    logger: {
      info: vi.fn<(record: Record<string, unknown>, message: string) => void>(),
      error: vi.fn<(record: Record<string, unknown>, message: string) => void>(),
    },
  };
  return { options, lifecycle: new StdioLifecycle(options) };
}

describe('bounded stdio lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['SIGINT', 'SIGTERM', 'transport_closed', 'database_error', 'startup_error'] as const)(
    'uses the same idempotent cleanup path for %s',
    async (reason) => {
      const { options, lifecycle } = fixture();
      const stopped = lifecycle.stop(reason);
      expect(lifecycle.stop('transport_closed')).toBe(stopped);
      expect(lifecycle.enter()).toBeNull();
      await stopped;
      expect(options.pauseInput).toHaveBeenCalledTimes(1);
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.finishOutput).toHaveBeenCalledTimes(1);
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(
        reason === 'database_error' || reason === 'startup_error' ? 1 : 0,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('drains every admitted invocation before cleanup and releases each only once', async () => {
    const { options, lifecycle } = fixture();
    const first = lifecycle.enter();
    const second = lifecycle.enter();
    const stopped = lifecycle.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(options.closeDatabase).not.toHaveBeenCalled();
    first?.();
    first?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(options.closeTransport).not.toHaveBeenCalled();
    second?.();
    await stopped;
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('handles transport-close reentrancy and upgrades an ongoing shutdown on fatal pool failure', async () => {
    const { options, lifecycle } = fixture();
    const release = lifecycle.enter();
    options.closeTransport.mockImplementation(() => {
      void lifecycle.stop('transport_closed');
      return Promise.resolve();
    });
    const stopped = lifecycle.stop('SIGINT');
    expect(lifecycle.stop('SIGTERM')).toBe(stopped);
    expect(lifecycle.stop('database_error')).toBe(stopped);
    release?.();
    await stopped;
    expect(options.closeTransport).toHaveBeenCalledTimes(1);
    expect(options.closeDatabase).toHaveBeenCalledTimes(1);
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(['pauseInput', 'closeTransport', 'closeDatabase', 'finishOutput'] as const)(
    'still attempts both resource cleanups when %s throws synchronously',
    async (operation) => {
      const { options, lifecycle } = fixture();
      options[operation].mockImplementation(() => {
        throw new Error('private-secret-SQL-path');
      });
      await lifecycle.stop('SIGTERM');
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.finishOutput).toHaveBeenCalledTimes(1);
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
      expect(options.logger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(options.logger.error.mock.calls)).not.toContain('private-secret');
    },
  );

  it('observes both cleanup rejections without logging raw errors', async () => {
    const { options, lifecycle } = fixture();
    options.closeTransport.mockRejectedValue(new Error('private-transport'));
    options.closeDatabase.mockRejectedValue(new Error('private-database'));
    await lifecycle.stop('transport_closed');
    expect(options.logger.error.mock.calls.map(([record]) => record)).toEqual([
      { event: 'mcp.shutdown_failed', phase: 'transport' },
      { event: 'mcp.shutdown_failed', phase: 'database' },
    ]);
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('bounds draining without retrying or claiming that the active operation rolled back', async () => {
    const { options, lifecycle } = fixture();
    const release = lifecycle.enter();
    const stopped = lifecycle.stop('transport_closed');
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(options.closeTransport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(options.closeTransport).toHaveBeenCalledTimes(1);
    expect(options.closeDatabase).toHaveBeenCalledTimes(1);
    expect(options.logger.error).toHaveBeenCalledWith(
      { event: 'mcp.drain_timeout', activeInvocations: 1 },
      expect.stringContaining('outcomes may be unknown'),
    );
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
    release?.();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    expect(options.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['closeTransport', 'closeDatabase', 'finishOutput'] as const)(
    'forces nonzero termination at the total deadline when %s never settles',
    async (operation) => {
      const { options, lifecycle } = fixture();
      const pending = deferred();
      options[operation].mockReturnValue(pending.promise);
      const stopped = lifecycle.stop('SIGINT');
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopped;
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
      expect(options.logger.error).toHaveBeenCalledWith(
        { event: 'mcp.shutdown_timeout', activeInvocations: 0 },
        expect.stringContaining('outcomes may be unknown'),
      );
      pending.resolve();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
      expect(options.terminate).toHaveBeenCalledTimes(1);
      expect(options.finishOutput).toHaveBeenCalledTimes(operation === 'finishOutput' ? 1 : 0);
      expect(options.logger.info.mock.calls.map(([record]) => record['event'])).not.toContain(
        'mcp.stopped',
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retains the total deadline across draining and a stuck pool cleanup', async () => {
    const { options, lifecycle } = fixture();
    lifecycle.enter();
    options.closeDatabase.mockReturnValue(new Promise<void>(() => {}));
    const stopped = lifecycle.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
    expect(options.closeTransport).toHaveBeenCalledTimes(1);
    expect(options.closeDatabase).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - DRAIN_TIMEOUT_MS - 1);
    expect(lifecycle.stop('database_error')).toBe(stopped);
    expect(options.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('waits for output flushing before successful termination', async () => {
    const { options, lifecycle } = fixture();
    const flushed = deferred();
    options.finishOutput.mockReturnValue(flushed.promise);
    const stopped = lifecycle.stop('transport_closed');
    await vi.advanceTimersByTimeAsync(0);
    expect(options.finishOutput).toHaveBeenCalledTimes(1);
    expect(options.terminate).not.toHaveBeenCalled();
    flushed.resolve();
    await stopped;
    expect(options.terminate).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['info', 'error'] as const)(
    'still cleans up and exits nonzero when the %s diagnostic sink throws',
    async (level) => {
      const { options, lifecycle } = fixture();
      options.logger[level].mockImplementation(() => {
        throw new Error('private-sink-error');
      });
      if (level === 'error')
        options.closeTransport.mockRejectedValue(new Error('private-close-error'));
      await lifecycle.stop('SIGTERM');
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.finishOutput).toHaveBeenCalledTimes(1);
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['idle', 'client'] as const)(
    'still shuts down on fatal %s loss when the diagnostic sink throws',
    async (source) => {
      const { options, lifecycle } = fixture();
      options.logger.error.mockImplementation(() => {
        throw new Error('private-sink-error');
      });
      await lifecycle.databaseError(source);
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
      expect(options.logger.error).toHaveBeenCalledWith(
        { event: source === 'idle' ? 'database.idle_error' : 'database.client_error' },
        'Database connection failed',
      );
    },
  );

  it('observes a late cleanup rejection after the deadline without repeating cleanup or emitting an unhandled rejection', async () => {
    const { options, lifecycle } = fixture();
    const pending = deferred();
    const unhandled: unknown[] = [];
    const capture = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', capture);
    try {
      options.closeTransport.mockReturnValue(pending.promise);
      const stopped = lifecycle.stop('transport_closed');
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
      await stopped;
      pending.reject(new Error('private-late-cleanup-error'));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
      expect(options.terminate).toHaveBeenCalledExactlyOnceWith(1);
      expect(options.closeTransport).toHaveBeenCalledTimes(1);
      expect(options.closeDatabase).toHaveBeenCalledTimes(1);
      expect(options.finishOutput).not.toHaveBeenCalled();
      expect(options.logger.error.mock.calls.map(([record]) => record['event'])).toEqual([
        'mcp.shutdown_timeout',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', capture);
    }
  });
});
