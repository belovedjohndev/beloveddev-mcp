import { TestCleanupError } from './test-database.js';

const events = [
  'configuration.invalid',
  'mcp.startup_failed',
  'mcp.ready',
  'mcp.stopping',
  'mcp.stopped',
  'mcp.protocol_error',
  'mcp.shutdown_timeout',
  'mcp.drain_timeout',
  'mcp.shutdown_failed',
  'mcp.invocation',
  'database.idle_error',
  'database.client_error',
] as const;
const categories = [
  'TIMEOUT',
  'CONNECTION',
  'IDENTITY',
  'SCHEMA',
  'READ_ONLY',
  'UNSAFE_PRIVILEGES',
  'MISSING_PRIVILEGES',
  'TRANSPORT_POLICY',
] as const;
export type StartupEvent = 'configuration.invalid' | 'mcp.startup_failed';
export type StartupCategory = (typeof categories)[number];
export type SmokeFailureCode =
  | 'child_startup_failure'
  | 'child_exit_timeout'
  | 'wrong_exit_code'
  | 'missing_startup_event'
  | 'wrong_failure_category'
  | 'unexpected_ready'
  | 'unexpected_protocol_stdout'
  | 'invalid_stderr_event'
  | 'stderr_limit'
  | 'secret_in_stderr'
  | 'docker_command_failure'
  | 'cleanup_failure'
  | 'response_timeout'
  | 'deadline_exceeded'
  | 'assertion_failure';

function isCategory(value: unknown): value is StartupCategory {
  return typeof value === 'string' && categories.some((category) => category === value);
}
function isEventRecord(
  value: unknown,
): value is Record<string, unknown> & { event: (typeof events)[number] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'event' in value &&
    events.some((event) => event === value.event)
  );
}

export class SmokeFailure extends Error {
  constructor(readonly code: SmokeFailureCode) {
    super(`Container smoke check failed: ${code}.`);
    this.name = 'SmokeFailure';
  }
}

/** Project only our fixed codes, never arbitrary child errors or their messages. */
export function smokeFailureCodes(error: unknown): SmokeFailureCode[] {
  const pending: unknown[] = [error];
  const codes: SmokeFailureCode[] = [];
  // Bound traversal even for cyclic aggregates; preserve nested primary/cleanup failures.
  for (let inspected = 0; pending.length > 0 && inspected < 32; inspected++) {
    const current = pending.shift();
    if (current instanceof SmokeFailure) codes.push(current.code);
    else if (current instanceof TestCleanupError) codes.push('cleanup_failure');
    else if (current instanceof AggregateError) {
      const children: unknown[] = current.errors;
      pending.unshift(...children.slice(0, 16));
    } else codes.push('assertion_failure');
  }
  if (pending.length > 0) codes.push('assertion_failure');
  return codes.slice(0, 16);
}

/** Harness-only, bounded observation. Raw stderr is retained in memory, never published. */
export class SmokeObservation {
  private stderr = '';
  private overflow = false;
  private readonly started: number;
  private readonly events: {
    event: (typeof events)[number];
    afterMs: number;
    category?: StartupCategory;
  }[] = [];
  private tail = '';
  stdoutLines = 0;
  invalidStdout = false;
  spawned = false;
  exited = false;
  exitCode: number | null = null;
  signal: string | null = null;
  constructor(private readonly now = () => performance.now()) {
    this.started = now();
  }
  private elapsed() {
    return Math.min(3_600_000, Math.max(0, Math.round(this.now() - this.started)));
  }
  stderrChunk(chunk: string) {
    const capacity = 1024 * 1024;
    if (this.stderr.length + chunk.length > capacity) this.overflow = true;
    this.stderr = (this.stderr + chunk).slice(0, capacity);
    if (this.overflow) return;
    const lines = (this.tail + chunk).split(/\r?\n/);
    this.tail = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = this.parseLine(line);
      if (parsed !== undefined && this.events.length < 16) {
        const category = parsed['category'];
        this.events.push({
          event: parsed['event'],
          afterMs: this.elapsed(),
          ...(isCategory(category) ? { category } : {}),
        });
      }
    }
  }
  private parseLine(
    line: string,
  ): (Record<string, unknown> & { event: (typeof events)[number] }) | undefined {
    try {
      const record: unknown = JSON.parse(line);
      if (!isEventRecord(record)) return undefined;
      if (record['category'] !== undefined && !isCategory(record['category'])) return undefined;
      return record;
    } catch {
      return undefined;
    }
  }
  records(secrets: readonly string[]) {
    if (this.invalidStdout) throw new SmokeFailure('unexpected_protocol_stdout');
    if (this.overflow) throw new SmokeFailure('stderr_limit');
    if (secrets.some((secret) => secret.length > 0 && this.stderr.includes(secret)))
      throw new SmokeFailure('secret_in_stderr');
    return this.stderr
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const record = this.parseLine(line);
        if (record === undefined) throw new SmokeFailure('invalid_stderr_event');
        return record;
      });
  }
  expectStartupFailure(
    event: StartupEvent,
    category: StartupCategory | undefined,
    secrets: readonly string[],
  ) {
    const records = this.records(secrets);
    if (this.exitCode !== 1) throw new SmokeFailure('wrong_exit_code');
    if (this.stdoutLines !== 0) throw new SmokeFailure('unexpected_protocol_stdout');
    if (!records.some((record) => record['event'] === event))
      throw new SmokeFailure('missing_startup_event');
    if (
      category !== undefined &&
      !records.some((record) => record['event'] === event && record['category'] === category)
    )
      throw new SmokeFailure('wrong_failure_category');
    if (records.some((record) => record['event'] === 'mcp.ready'))
      throw new SmokeFailure('unexpected_ready');
  }
  snapshot() {
    return {
      elapsedMs: this.elapsed(),
      spawned: this.spawned,
      exited: this.exited,
      exitCode:
        this.exitCode !== null &&
        Number.isInteger(this.exitCode) &&
        this.exitCode >= 0 &&
        this.exitCode <= 255
          ? this.exitCode
          : null,
      signal:
        this.signal === null
          ? null
          : ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(this.signal)
            ? this.signal
            : 'other',
      stdoutLines: Math.min(this.stdoutLines, 1_000_000),
      stderrBytes: Buffer.byteLength(this.stderr),
      stderrLimitExceeded: this.overflow,
      invalidStdout: this.invalidStdout,
      events: this.events.slice(),
    };
  }
}

/** Mutate components, never credentials or database names containing matching substrings. */
export function invalidTransportUrl(connectionString: string) {
  const url = new URL(connectionString);
  url.hostname = 'db.invalid';
  url.searchParams.set('sslmode', 'disable');
  return url.href;
}
