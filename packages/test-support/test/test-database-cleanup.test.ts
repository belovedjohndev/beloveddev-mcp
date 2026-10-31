import { AssertionError } from 'node:assert';
import { describe, expect, it } from 'vitest';
import {
  cleanupTestResources,
  TestCleanupError,
  withTestResourceCleanup,
} from '../src/test-database.js';

describe('test resource cleanup orchestration', () => {
  it('attempts every independent step and reports every failing stage', async () => {
    const visited: string[] = [];
    const result = await cleanupTestResources(
      ['runtime_pool', 'admin_pool', 'database', 'role', 'control_pool'].map((stage) => ({
        stage,
        run: () => {
          visited.push(stage);
          return stage === 'runtime_pool' || stage === 'database'
            ? Promise.reject(
                Object.assign(new Error('private SQL and credentials'), { code: '57014' }),
              )
            : Promise.resolve();
        },
      })),
    ).catch((error: unknown) => error);
    expect(visited).toEqual(['runtime_pool', 'admin_pool', 'database', 'role', 'control_pool']);
    expect(result).toBeInstanceOf(TestCleanupError);
    expect(result).toMatchObject({
      failures: [
        { stage: 'runtime_pool', code: '57014' },
        { stage: 'database', code: '57014' },
      ],
    });
    expect(String(result)).not.toMatch(/private|credentials|SQL/);
  });

  it('still removes the artifact directory after database cleanup fails', async () => {
    let removed = false;
    await expect(
      cleanupTestResources([
        { stage: 'database', run: () => Promise.reject(new Error('failure')) },
        {
          stage: 'artifact_directory',
          run: () => {
            removed = true;
            return Promise.resolve();
          },
        },
      ]),
    ).rejects.toMatchObject({ failures: [{ stage: 'database', code: 'UNKNOWN' }] });
    expect(removed).toBe(true);
  });

  it('does not retry failed cleanup or expose an arbitrary error code', async () => {
    let calls = 0;
    await expect(
      cleanupTestResources([
        {
          stage: 'database',
          run: () => {
            calls++;
            return Promise.reject(
              Object.assign(new Error('private-secret'), { code: 'postgresql://private-secret' }),
            );
          },
        },
      ]),
    ).rejects.toThrow('database [UNKNOWN]');
    expect(calls).toBe(1);
  });

  it('retains nested cleanup stages and SQLSTATE codes', async () => {
    await expect(
      cleanupTestResources([
        {
          stage: 'source_database',
          run: () => Promise.reject(new TestCleanupError([{ stage: 'database', code: '57014' }])),
        },
      ]),
    ).rejects.toMatchObject({ failures: [{ stage: 'source_database.database', code: '57014' }] });
  });
});

describe('assertion-safe owned resource teardown', () => {
  it('preserves assertion identity after every cleanup attempt', async () => {
    const assertion = new AssertionError({
      message: 'original assertion',
      actual: false,
      expected: true,
      operator: 'strictEqual',
    });
    const visited: string[] = [];
    await expect(
      withTestResourceCleanup(() => {
        throw assertion;
      }, [
        {
          stage: 'transport',
          run: () => {
            visited.push('transport');
          },
        },
        {
          stage: 'database',
          run: () => {
            visited.push('database');
          },
        },
        {
          stage: 'environment',
          run: () => {
            visited.push('environment');
          },
        },
      ]),
    ).rejects.toBe(assertion);
    expect(visited).toEqual(['transport', 'database', 'environment']);
  });
  it('retains the original asynchronous assertion and every safe cleanup failure', async () => {
    const assertion = new Error('original async assertion');
    const visited: string[] = [];
    const error: unknown = await withTestResourceCleanup(
      () => Promise.reject(assertion),
      [
        {
          stage: 'transport',
          run: () => {
            visited.push('transport');
            throw new Error('private transport secret');
          },
        },
        {
          stage: 'database',
          run: () => {
            visited.push('database');
            return Promise.reject(new Error('private database secret'));
          },
        },
        {
          stage: 'revocation',
          run: () => {
            visited.push('revocation');
          },
        },
        {
          stage: 'environment',
          run: () => {
            visited.push('environment');
          },
        },
      ],
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregate failure.');
    expect(error.errors[0]).toBe(assertion);
    expect(error.errors[1]).toMatchObject({
      failures: [
        { stage: 'transport', code: 'UNKNOWN' },
        { stage: 'database', code: 'UNKNOWN' },
      ],
    });
    expect(String(error.errors[1])).not.toContain('private');
    expect(visited).toEqual(['transport', 'database', 'revocation', 'environment']);
  });
  it('reports cleanup failure even when assertions pass and never retries it', async () => {
    let attempts = 0,
      restored = false;
    await expect(
      withTestResourceCleanup(
        () => true,
        [
          {
            stage: 'fixture',
            run: () => {
              attempts++;
              throw new Error('private failure');
            },
          },
          {
            stage: 'environment',
            run: () => {
              restored = true;
            },
          },
        ],
      ),
    ).rejects.toBeInstanceOf(TestCleanupError);
    expect(attempts).toBe(1);
    expect(restored).toBe(true);
  });
  it('returns successful values after successful cleanup', async () => {
    expect(await withTestResourceCleanup(() => 42, [])).toBe(42);
  });
});
