import { z } from 'zod';
import { openReplayStore } from '@beloveddev/database/evaluation-replay-postgres';
import {
  replayAdmissionSchema,
  replayIdentitySchema,
  ReplayError,
} from '@beloveddev/database/evaluation-replay';

const inputSchema = z.strictObject({
  configuration: z.strictObject({
    connectionString: z.string(),
    tlsCa: z.string().optional(),
    identity: replayIdentitySchema,
  }),
  admission: replayAdmissionSchema,
  hold: z.boolean(),
});
const send = (value: unknown) => {
  if (process.connected) process.send?.(value);
};
process.once('message', (raw: unknown) => {
  void (async () => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) {
      send({ event: 'result', category: 'VALIDATION' });
      process.disconnect();
      return;
    }
    const input = parsed.data;
    const store = await openReplayStore(
      {
        connectionString: input.configuration.connectionString,
        identity: input.configuration.identity,
        ...(input.configuration.tlsCa === undefined ? {} : { tlsCa: input.configuration.tlsCa }),
      },
      { deadlineAt: performance.now() + 5000 },
    );
    const timer = setTimeout(() => {
      void store
        .close()
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(() => {
          process.exitCode = 1;
          if (process.connected) process.disconnect();
        });
    }, 15000);
    process.once('message', (message: unknown) => {
      void (async () => {
        let category = 'accepted';
        try {
          if (message !== 'go') throw new ReplayError('VALIDATION');
          await store.admit(input.admission, { deadlineAt: performance.now() + 5000 });
        } catch (error: unknown) {
          category = error instanceof ReplayError ? error.category : 'UNAVAILABLE';
        }
        try {
          await store.close();
        } catch {
          category = 'CLEANUP';
        }
        send({ event: 'result', category });
        if (!input.hold || category !== 'accepted') {
          clearTimeout(timer);
          process.disconnect();
        }
      })().catch(() => {
        send({ event: 'result', category: 'UNAVAILABLE' });
        clearTimeout(timer);
        if (process.connected) process.disconnect();
        process.exitCode = 1;
      });
    });
    send({ event: 'ready' });
  })().catch(() => {
    send({ event: 'result', category: 'UNAVAILABLE' });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  });
});
