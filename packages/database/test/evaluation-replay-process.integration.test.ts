import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { cleanupTestResources } from '@beloveddev/test-support/test-database';
import type { ReplayAdmission } from '../src/evaluation-replay.js';
import { admission, createReplayFixture, type ReplayFixture } from './evaluation-replay-fixture.js';

const messageSchema = z.union([
  z.strictObject({ event: z.literal('ready') }),
  z.strictObject({
    event: z.literal('result'),
    category: z.enum([
      'accepted',
      'DUPLICATE',
      'STATE',
      'BINDING',
      'EXPIRED',
      'UNAVAILABLE',
      'TIMEOUT',
      'COMMIT_UNKNOWN',
      'CLEANUP',
      'VALIDATION',
    ]),
  }),
]);
const entry = fileURLToPath(new URL('./fixtures/evaluation-replay-worker.ts', import.meta.url));
let fixture: ReplayFixture;
const children = new Map<ChildProcess, Promise<void>>();
beforeAll(async () => {
  fixture = await createReplayFixture(parseTestDatabaseUrl(process.env));
});
afterEach(async () => {
  await cleanupTestResources(
    [...children].map(([child, exited]) => ({
      stage: 'replay_worker',
      run: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      },
    })),
  );
  children.clear();
});
afterAll(async () => {
  await fixture?.close();
});

async function worker(value: ReplayAdmission, hold = false) {
  const child = spawn(process.execPath, [entry], {
    env: Object.fromEntries(
      ['PATH', 'SystemRoot', 'TEMP', 'TMP'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let readyResolve: () => void = () => {},
    resultResolve: (value: string) => void = () => {};
  let rejectReady: (error: Error) => void = () => {},
    rejectResult: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    rejectReady = reject;
  });
  const result = new Promise<string>((resolve, reject) => {
    resultResolve = resolve;
    rejectResult = reject;
  });
  void ready.catch(() => {});
  void result.catch(() => {});
  let stdoutBytes = 0,
    stderrBytes = 0,
    done = false,
    isReady = false;
  const fail = () => {
    const error = new Error('Replay worker protocol or startup failed.');
    rejectReady(error);
    rejectResult(error);
    child.kill('SIGKILL');
  };
  const timer = setTimeout(fail, 10000);
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      fail();
      reject(new Error('Replay worker could not start.'));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!done) fail();
      if (stdoutBytes !== 0 || stderrBytes !== 0 || (code !== 0 && signal !== 'SIGKILL'))
        reject(new Error('Replay worker exit was not clean.'));
      else resolve();
    });
  });
  void exited.catch(() => {});
  children.set(child, exited);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 8192) fail();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) fail();
  });
  child.on('message', (raw: unknown) => {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      fail();
      return;
    }
    if (parsed.data.event === 'ready') {
      isReady = true;
      readyResolve();
    } else {
      done = true;
      if (!isReady) rejectReady(new Error('Replay worker setup rejected: ' + parsed.data.category));
      resultResolve(parsed.data.category);
    }
  });
  child.send({ configuration: fixture.configuration, admission: value, hold }, (error) => {
    if (error) fail();
  });
  await ready;
  return {
    child,
    result,
    exited,
    go() {
      child.send('go', (error) => {
        if (error) fail();
      });
    },
  };
}

describe('durable replay across independent Node processes', () => {
  it('admits exactly one concurrently released worker', async () => {
    const value = admission(),
      [a, b] = await Promise.all([worker(value), worker(value)]);
    expect(a.child.pid).not.toBe(b.child.pid);
    a.go();
    b.go();
    expect((await Promise.all([a.result, b.result])).sort()).toEqual(['DUPLICATE', 'accepted']);
    await Promise.all([a.exited, b.exited]);
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.invocations WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.identifiers WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });
  it('rejects a committed admission after process termination and restart', async () => {
    const value = admission(),
      first = await worker(value, true);
    first.go();
    expect(await first.result).toBe('accepted');
    expect(
      (
        await fixture.admin.pool.query<{ status: string }>(
          'SELECT status FROM evaluation_replay.invocations WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.status,
    ).toBe('admitted');
    first.child.kill('SIGKILL');
    await first.exited;
    const restarted = await worker(value);
    restarted.go();
    expect(await restarted.result).toBe('DUPLICATE');
    await restarted.exited;
  });
});
