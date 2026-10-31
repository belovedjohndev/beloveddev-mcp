// Opt-in test subprocess preload. Never writes stdout/stderr or serializes environment data.
import { Socket } from 'node:net';
let sent = 0;
function emit(phase: string, lagMs?: number) {
  if (!process.connected || sent++ >= 192) return;
  const now = performance.now();
  const cpu = process.cpuUsage();
  try {
    process.send?.(
      {
        kind: 'beloveddev-test-timing',
        phase,
        childUptimeMs: now,
        sentAtMs: performance.timeOrigin + now,
        cpuTotalMs: (cpu.user + cpu.system) / 1000,
        ...(lagMs === undefined ? {} : { lagMs }),
      },
      undefined,
      undefined,
      () => {},
    );
  } catch {
    /* IPC can close during an otherwise normal process shutdown. */
  }
}
emit('bootstrap');
setImmediate(() => emit('first_turn'));
let expected = performance.now() + 250;
const heartbeat = setInterval(() => {
  const now = performance.now();
  emit('event_loop_sample', Math.max(0, now - expected));
  expected = now + 250;
}, 250);
heartbeat.unref();
const connect: unknown = Reflect.get(Socket.prototype, 'connect');
if (typeof connect !== 'function') throw new Error('Node socket method unavailable.');
Object.defineProperty(Socket.prototype, 'connect', {
  configurable: true,
  writable: true,
  value: function (this: Socket, ...args: unknown[]): Socket {
    // Test applications have PostgreSQL as their only TCP dependency. No addresses are recorded.
    emit('tcp_connect_started');
    this.once('connect', () => emit('tcp_connected'));
    return Reflect.apply(connect, this, args) as Socket;
  },
});

const stdoutWrite: unknown = Reflect.get(process.stdout, 'write');
if (typeof stdoutWrite !== 'function') throw new Error('Node stdout method unavailable.');
Object.defineProperty(process.stdout, 'write', {
  configurable: true,
  writable: true,
  value: function (this: typeof process.stdout, ...args: unknown[]): boolean {
    emit('stdout_write');
    return Reflect.apply(stdoutWrite, this, args) as boolean;
  },
});
