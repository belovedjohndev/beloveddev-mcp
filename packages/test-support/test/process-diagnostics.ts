import { z } from 'zod';
const phaseSchema = z.enum([
  'bootstrap',
  'first_turn',
  'tcp_connect_started',
  'tcp_connected',
  'stdout_write',
  'event_loop_sample',
]);
const probeSchema = z.strictObject({
  kind: z.literal('beloveddev-test-timing'),
  phase: phaseSchema,
  childUptimeMs: z.number().finite().nonnegative().max(3600000),
  sentAtMs: z.number().finite().nonnegative(),
  cpuTotalMs: z.number().finite().nonnegative().max(3600000).optional(),
  lagMs: z.number().finite().nonnegative().max(3600000).optional(),
});
const events = [
  'spawn_called',
  'spawned',
  'bootstrap',
  'first_turn',
  'tcp_connect_started',
  'tcp_connected',
  'stdout_write',
  'ready',
  'initialize_sent',
  'discovery_sent',
  'discovery_probe_sent',
  'tool_sent',
  'response',
  'response_timeout',
  'protocol_invalid',
  'migration_failed',
  'runtime_startup_failed',
  'database_pool_error',
  'process_exit_nonzero',
  'process_terminated',
  'close_requested',
  'closed',
  'watchdog',
  'spawn_error',
  'cleanup_timeout',
] as const;
const lifecycleEventSchema = z.enum([
  'mcp.ready',
  'mcp.protocol_error',
  'mcp.startup_failed',
  'configuration.invalid',
  'mcp.stopping',
  'mcp.stopped',
  'mcp.shutdown_timeout',
  'mcp.drain_timeout',
  'mcp.shutdown_failed',
  'database.idle_error',
  'database.client_error',
]);
const readinessCategorySchema = z.enum([
  'TIMEOUT',
  'CONNECTION',
  'IDENTITY',
  'SCHEMA',
  'READ_ONLY',
  'UNSAFE_PRIVILEGES',
  'MISSING_PRIVILEGES',
  'TRANSPORT_POLICY',
]);
const rpcErrorSchema = z.strictObject({ code: z.number().int(), message: z.string().max(4096) });
type Phase = (typeof events)[number];
export class ProcessDiagnostics {
  readonly enabled: boolean;
  private readonly started: number;
  private readonly seen = new Set<Phase>();
  private cpuTotalMs = 0;
  private readonly points: {
    phase: Phase;
    afterMs: number;
    childUptimeMs?: number;
    cpuTotalMs?: number;
  }[] = [];
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private expected: number;
  private parentLagMs = 0;
  private childLagMs = 0;
  private deliveryLagMs = 0;
  private rejectedMessages = 0;
  private dropped = false;
  private published = false;
  private stderrTail = '';
  private invocationMaxMs = 0;
  private readonly lifecycleEvents: {
    event: z.infer<typeof lifecycleEventSchema>;
    afterMs: number;
    category?: z.infer<typeof readinessCategorySchema>;
  }[] = [];
  private readonly rpcErrors: {
    method: string;
    code: number;
    messageClass: string;
    readinessObserved: boolean;
    afterMs: number;
  }[] = [];
  private exitStatus: { code: number | null; signal: string | null } | null = null;
  response(method: string, error: unknown) {
    if (!this.enabled || error === undefined) return;
    const parsed = rpcErrorSchema.safeParse(error);
    if (!parsed.success) {
      this.rejectedMessages++;
      return;
    }
    if (this.rpcErrors.length >= 16) {
      this.dropped = true;
      return;
    }
    this.rpcErrors.push({
      method: ['server/discover', 'initialize', 'tools/list', 'tools/call'].includes(method)
        ? method
        : 'other',
      code: parsed.data.code,
      messageClass:
        parsed.data.message === 'Internal server error'
          ? 'internal_server_error'
          : 'other_redacted',
      readinessObserved: this.seen.has('ready'),
      afterMs: Math.max(0, this.now() - this.started),
    });
  }
  exit(code: number | null, signal: string | null) {
    if (!this.enabled) return;
    this.exitStatus = {
      code,
      signal:
        signal === null
          ? null
          : ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)
            ? signal
            : 'other',
    };
  }
  constructor(
    private readonly testName: string,
    enabled = process.env['BELOVEDDEV_TEST_DIAGNOSTICS'] === '1',
    private readonly now: () => number = () => performance.now(),
    private readonly write: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {
    this.enabled = enabled;
    this.started = now();
    this.expected = this.started + 250;
    if (enabled) {
      this.timer = setInterval(() => {
        const time = now();
        this.parentLagMs = Math.max(this.parentLagMs, time - this.expected);
        this.expected = time + 250;
      }, 250);
      this.timer.unref();
    }
  }
  mark(phase: Phase, childUptimeMs?: number, cpuTotalMs?: number) {
    if (!this.enabled) return;
    if (!events.includes(phase)) throw new Error('Invalid timing phase.');
    this.seen.add(phase);
    if (this.points.length >= 128) {
      this.dropped = true;
      return;
    }
    this.points.push({
      phase,
      afterMs: Math.max(0, this.now() - this.started),
      ...(childUptimeMs === undefined ? {} : { childUptimeMs }),
      ...(cpuTotalMs === undefined ? {} : { cpuTotalMs }),
    });
  }
  message(input: unknown) {
    if (!this.enabled) return;
    const parsed = probeSchema.safeParse(input);
    if (!parsed.success) {
      this.rejectedMessages++;
      return;
    }
    const message = parsed.data;
    this.cpuTotalMs = Math.max(this.cpuTotalMs, message.cpuTotalMs ?? 0);
    this.deliveryLagMs = Math.max(
      this.deliveryLagMs,
      performance.timeOrigin + this.now() - message.sentAtMs,
    );
    if (message.phase === 'event_loop_sample')
      this.childLagMs = Math.max(this.childLagMs, message.lagMs ?? 0);
    else this.mark(message.phase, message.childUptimeMs, message.cpuTotalMs);
  }
  stderr(chunk: string) {
    if (!this.enabled) return;
    this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    const lines = this.stderrTail.split('\n');
    this.stderrTail = lines.pop() ?? '';
    for (const line of lines) {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object') continue;
      const event: unknown = Reflect.get(data, 'event');
      const lifecycle = lifecycleEventSchema.safeParse(event);
      if (lifecycle.success) {
        if (this.lifecycleEvents.length < 64) {
          const category = readinessCategorySchema.safeParse(Reflect.get(data, 'category'));
          this.lifecycleEvents.push({
            event: lifecycle.data,
            afterMs: Math.max(0, this.now() - this.started),
            ...(category.success ? { category: category.data } : {}),
          });
        } else this.dropped = true;
      }
      if (event === 'mcp.ready') this.mark('ready');
      if (event === 'mcp.startup_failed' || event === 'configuration.invalid')
        this.mark('runtime_startup_failed');
      if (event === 'database.idle_error' || event === 'database.client_error')
        this.mark('database_pool_error');
      if (event === 'database.migration_failed') this.mark('migration_failed');
      const duration: unknown = Reflect.get(data, 'durationMs');
      if (
        event === 'mcp.invocation' &&
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration >= 0
      )
        this.invocationMaxMs = Math.max(this.invocationMaxMs, duration);
    }
  }
  snapshot() {
    const phases = this.seen;
    const classification = phases.has('runtime_startup_failed')
      ? 'reported_startup_failure'
      : phases.has('database_pool_error')
        ? 'reported_database_pool_failure'
        : this.rpcErrors.some(({ code }) => code === -32603)
          ? 'reported_protocol_internal_error'
          : phases.has('protocol_invalid')
            ? 'invalid_protocol_output'
            : phases.has('spawn_error')
              ? 'process_spawn_failure'
              : phases.has('cleanup_timeout')
                ? 'cleanup_timeout'
                : phases.has('watchdog')
                  ? 'migration_subprocess_timeout'
                  : phases.has('response_timeout')
                    ? phases.has('ready')
                      ? 'mcp_response_timeout_after_readiness'
                      : phases.has('tcp_connected')
                        ? 'startup_or_database_readiness_unconfirmed'
                        : phases.has('bootstrap')
                          ? 'connection_or_module_startup_unconfirmed'
                          : 'startup_unobserved'
                    : phases.has('migration_failed')
                      ? 'reported_migration_failure'
                      : phases.has('process_exit_nonzero')
                        ? 'reported_nonzero_exit'
                        : phases.has('process_terminated')
                          ? 'reported_process_termination'
                          : 'completed_observation';
    return {
      schemaVersion: 2,
      lifecycleEvents: structuredClone(this.lifecycleEvents),
      rpcErrors: structuredClone(this.rpcErrors),
      exitStatus: this.exitStatus === null ? null : { ...this.exitStatus },
      testName: /postgres(?:ql)?:\/\/|password|secret|token=/i.test(this.testName)
        ? 'redacted_test_name'
        : this.testName.slice(0, 300),
      classification,
      parentEventLoopLagMaxMs: Math.max(0, this.parentLagMs),
      childEventLoopLagMaxMs: this.childLagMs,
      childCpuTotalMs: this.cpuTotalMs,
      ipcDeliveryLagMaxMs: Math.max(0, this.deliveryLagMs),
      invocationMaxMs: this.invocationMaxMs,
      rejectedMessages: this.rejectedMessages,
      truncated: this.dropped,
      points: structuredClone(this.points),
    };
  }
  publish() {
    clearInterval(this.timer);
    if (!this.enabled || this.published) return;
    this.published = true;
    this.write('TEST_PROCESS_DIAGNOSTIC ' + JSON.stringify(this.snapshot()) + '\n');
  }
}
export function probeOptions(env: Record<string, string | undefined>) {
  if (process.env['BELOVEDDEV_TEST_DIAGNOSTICS'] !== '1') return { env, ipc: false };
  const probe = new URL('./process-probe.ts', import.meta.url).href;
  return {
    env: {
      ...env,
      NODE_OPTIONS:
        (env['NODE_OPTIONS'] ? env['NODE_OPTIONS'] + ' ' : '') +
        '--import=' +
        JSON.stringify(probe),
    },
    ipc: true,
  };
}
