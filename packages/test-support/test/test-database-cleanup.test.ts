import { describe, expect, it } from 'vitest';
import { cleanupTestResources, TestCleanupError } from '../src/test-database.js';

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
