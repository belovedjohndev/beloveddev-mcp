import { commitLossProxy } from './evaluation-replay-commit-proxy.js';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { createServer } from 'node:net';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import { withTestResourceCleanup } from '@beloveddev/test-support/test-database';
import {
  admission,
  binding,
  turn,
  permit,
  operation,
  createReplayFixture,
  type ReplayFixture,
} from './evaluation-replay-fixture.js';
import { openReplayStore } from '../src/evaluation-replay-postgres.js';
import { migrateReplayDatabase, replayConnection } from '../src/evaluation-replay-migrate.js';
import { replayBindingSchema, ReplayError } from '../src/evaluation-replay.js';
import {
  replaySchemaQuery,
  REPLAY_SCHEMA_SHA256,
  replayTransaction,
} from '../src/evaluation-replay-policy.js';

let fixture: ReplayFixture;
beforeAll(async () => {
  fixture = await createReplayFixture(parseTestDatabaseUrl(process.env));
});
afterAll(async () => {
  await fixture?.close();
});
async function started(ttl = 60000) {
  const store = await fixture.open(),
    value = admission(ttl),
    owner = binding(value);
  await store.admit(value, operation());
  await store.start(owner, operation());
  return { store, value, owner };
}
async function waitFor(check: () => Promise<boolean>, deadline = performance.now() + 5000) {
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Replay synchronization barrier failed.');
    await yieldEventLoop();
  }
}
async function waitForLock() {
  await waitFor(
    async () =>
      (
        await fixture.admin.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND application_name='beloveddev-evaluation-replay' AND wait_event_type='Lock') waiting",
        )
      ).rows[0]?.waiting === true,
  );
}

describe('evaluator replay ledger: real PostgreSQL', () => {
  it('matches the pinned catalog and exact evaluator ledger independently of application migrations', async () => {
    const result = await fixture.admin.pool.query<{ manifest: string }>(replaySchemaQuery);
    expect(createHash('sha256').update(result.rows[0]!.manifest).digest('hex')).toBe(
      REPLAY_SCHEMA_SHA256,
    );
    expect(
      (
        await fixture.admin.pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.tenants') relation",
        )
      ).rows[0]?.relation,
    ).toBeNull();
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay_migrations.__drizzle_migrations',
        )
      ).rows[0]?.count,
    ).toBe(1);
    await migrateReplayDatabase(fixture.migration, operation(30000));
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay_migrations.__drizzle_migrations',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('admits once and rejects duplicate approval, invocation and execution identities', async () => {
    const store = await fixture.open(),
      value = admission();
    await store.admit(value, operation());
    for (const duplicate of [
      value,
      { ...admission(), approvalId: value.approvalId },
      { ...admission(), invocationId: value.invocationId },
      { ...admission(), executionId: value.executionId },
    ])
      await expect(store.admit(duplicate, operation())).rejects.toMatchObject({
        category: 'DUPLICATE',
      });
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.identifiers WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });
  it('preserves cross-role collisions and atomically rolls back new parent rows', async () => {
    const store = await fixture.open(),
      original = admission();
    await store.admit(original, operation());
    for (const value of [
      { ...admission(), approvalId: original.invocationId },
      { ...admission(), invocationId: original.approvalId },
    ]) {
      await expect(store.admit(value, operation())).rejects.toMatchObject({
        category: 'DUPLICATE',
      });
      expect(
        (
          await fixture.admin.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM evaluation_replay.invocations WHERE execution_id=$1',
            [value.executionId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    }
  });
  it('allows equal approval/invocation IDs only on initial admission', async () => {
    const store = await fixture.open(),
      value = admission();
    const same = { ...value, approvalId: value.invocationId };
    await store.admit(same, operation());
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.identifiers WHERE invocation_id=$1',
          [same.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    await expect(store.admit(same, operation())).rejects.toMatchObject({ category: 'DUPLICATE' });
  });
  it('arbitrates concurrent admissions from two independent physical connections', async () => {
    const first = await fixture.open(),
      second = await fixture.open(),
      value = admission();
    const results = await Promise.allSettled([
      first.admit(value, operation()),
      second.admit(value, operation()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { category: 'DUPLICATE' } });
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.invocations WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('rejects wrong execution, immutable model and fixture bindings', async () => {
    const store = await fixture.open(),
      value = admission(),
      owner = binding(value);
    await store.admit(value, operation());
    await expect(
      store.start({ ...owner, executionId: randomUUID() }, operation()),
    ).rejects.toMatchObject({ category: 'BINDING' });
    await expect(
      store.start({ ...owner, fixtureManifestDigest: 'f'.repeat(64) }, operation()),
    ).rejects.toMatchObject({ category: 'BINDING' });
    expect(replayBindingSchema.safeParse({ ...owner, model: 'different-model' }).success).toBe(
      false,
    );
    expect(
      (
        await fixture.admin.pool.query<{ status: string }>(
          'SELECT status FROM evaluation_replay.invocations WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.status,
    ).toBe('admitted');
  });
  it('enforces sequential turns, exact permits, one-way consumption and durable retirement', async () => {
    const { store, owner } = await started(),
      first = turn(),
      ticket = permit();
    await expect(store.issueTurn(owner, turn(2), operation())).rejects.toMatchObject({
      category: 'STATE',
    });
    await store.issueTurn(owner, first, operation());
    await store.claimTurn(owner, first, operation());
    await expect(store.claimTurn(owner, first, operation())).rejects.toMatchObject({
      category: 'STATE',
    });
    await store.prepareTurn(owner, first, ticket, operation());
    await expect(store.prepareTurn(owner, first, permit(), operation())).rejects.toMatchObject({
      category: 'STATE',
    });
    await expect(
      store.consumePermit(owner, first, { ...ticket, rawBodyDigest: 'f'.repeat(64) }, operation()),
    ).rejects.toMatchObject({ category: 'BINDING' });
    await store.consumePermit(owner, first, ticket, operation());
    await expect(store.consumePermit(owner, first, ticket, operation())).rejects.toMatchObject({
      category: 'STATE',
    });
    await expect(store.issueTurn(owner, turn(2), operation())).rejects.toMatchObject({
      category: 'STATE',
    });
    await store.retireTurn(owner, first, operation());
    const second = turn(2);
    await store.issueTurn(owner, second, operation());
    await store.claimTurn(owner, second, operation());
    await expect(store.prepareTurn(owner, second, ticket, operation())).rejects.toMatchObject({
      category: 'DUPLICATE',
    });
    await expect(
      store.prepareTurn(
        owner,
        second,
        { ...permit(), reservationId: ticket.reservationId },
        operation(),
      ),
    ).rejects.toMatchObject({ category: 'DUPLICATE' });
    await store.retireTurn(owner, second, operation());
    await store.closeInvocation(owner, 'success', operation());
    const row = (
      await fixture.admin.pool.query<{ consumed_at: Date | null; retired_at: Date | null }>(
        'SELECT consumed_at,retired_at FROM evaluation_replay.turns WHERE invocation_id=$1 AND turn_number=1',
        [owner.invocationId],
      )
    ).rows[0];
    expect(row?.consumed_at).not.toBeNull();
    expect(row?.retired_at).not.toBeNull();
    await expect(store.start(owner, operation())).rejects.toMatchObject({ category: 'STATE' });
  });
  it('rolls back the parent counter when a child insert fails', async () => {
    const a = await started(),
      b = await started(),
      shared = turn();
    await a.store.issueTurn(a.owner, shared, operation());
    await expect(b.store.issueTurn(b.owner, shared, operation())).rejects.toMatchObject({
      category: 'DUPLICATE',
    });
    expect(
      (
        await fixture.admin.pool.query<{ last_turn_number: number }>(
          'SELECT last_turn_number FROM evaluation_replay.invocations WHERE invocation_id=$1',
          [b.owner.invocationId],
        )
      ).rows[0]?.last_turn_number,
    ).toBe(0);
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.turns WHERE invocation_id=$1',
          [b.owner.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
  it('allows only one concurrent start and one concurrent permit consumer', async () => {
    const first = await fixture.open(),
      second = await fixture.open(),
      value = admission(),
      owner = binding(value),
      item = turn(),
      ticket = permit();
    await first.admit(value, operation());
    const starts = await Promise.allSettled([
      first.start(owner, operation()),
      second.start(owner, operation()),
    ]);
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(starts.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { category: 'STATE' },
    });
    await first.issueTurn(owner, item, operation());
    await first.claimTurn(owner, item, operation());
    await first.prepareTurn(owner, item, ticket, operation());
    const consumed = await Promise.allSettled([
      first.consumePermit(owner, item, ticket, operation()),
      second.consumePermit(owner, item, ticket, operation()),
    ]);
    expect(consumed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(consumed.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { category: 'STATE' },
    });
  });
  it('checks database wall time after waiting for a parent lock, and retains expired identifiers', async () => {
    const store = await fixture.open(),
      value = admission(800),
      owner = binding(value);
    await store.admit(value, operation());
    const holder = await fixture.admin.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT invocation_id FROM evaluation_replay.invocations WHERE invocation_id=$1 FOR UPDATE',
        [value.invocationId],
      );
      const pending = store.start(owner, operation()).then(
        () => 'accepted',
        (error) => (error instanceof ReplayError ? error.category : 'unknown'),
      );
      await waitForLock();
      // Explicit database clock barrier; no sleep or assumed scheduler delay.
      await waitFor(
        async () =>
          (
            await fixture.admin.pool.query<{ expired: boolean }>(
              'SELECT clock_timestamp()>=$1::timestamptz expired',
              [value.expiresAt],
            )
          ).rows[0]?.expired === true,
      );
      await holder.query('ROLLBACK');
      expect(await pending).toBe('EXPIRED');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const renewed = {
      ...value,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    await expect(store.admit(renewed, operation())).rejects.toMatchObject({
      category: 'DUPLICATE',
    });
    await store.closeInvocation(owner, 'failure', operation());
    expect(
      (
        await fixture.admin.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM evaluation_replay.identifiers WHERE invocation_id=$1',
          [value.invocationId],
        )
      ).rows[0]?.count,
    ).toBe(2);
  });
  it('bounds a database transaction timeout without retries', async () => {
    const holder = await fixture.admin.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(724681,1)');
      const config = replayConnection(fixture.configuration).connection;
      const startedAt = performance.now();
      await expect(
        replayTransaction(config, operation(), async (client) => {
          await client.query("SET LOCAL transaction_timeout='100ms'");
          await client.query('SELECT pg_advisory_xact_lock(724681,1)');
        }),
      ).rejects.toMatchObject({ category: 'TIMEOUT' });
      expect(performance.now() - startedAt).toBeLessThan(5000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
  it('rejects unavailable storage and caller cancellation without fallback', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned test endpoint.');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const url = new URL(fixture.configuration.connectionString);
    url.port = String(address.port);
    await expect(
      openReplayStore({ ...fixture.configuration, connectionString: url.href }, operation()),
    ).rejects.toMatchObject({ category: 'UNAVAILABLE' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      openReplayStore(fixture.configuration, { ...operation(), signal: cancelled.signal }),
    ).rejects.toMatchObject({ category: 'TIMEOUT' });
  });
  it.each(['systemIdentifier', 'databaseOid', 'marker'] as const)(
    'rejects incorrect trusted %s',
    async (key) => {
      const identity = {
        ...fixture.configuration.identity,
        [key]:
          key === 'databaseOid'
            ? fixture.configuration.identity.databaseOid + 1
            : key === 'marker'
              ? randomUUID()
              : '1',
      };
      await expect(
        openReplayStore({ ...fixture.configuration, identity }, operation()),
      ).rejects.toMatchObject({ category: 'IDENTITY' });
    },
  );
  it.each([
    ['UPDATE ON evaluation_replay.invocations', 'UPDATE ON evaluation_replay.invocations'],
    ['DELETE ON evaluation_replay.identifiers', 'DELETE ON evaluation_replay.identifiers'],
    ['TRUNCATE ON evaluation_replay.turns', 'TRUNCATE ON evaluation_replay.turns'],
    ['CREATE ON SCHEMA public', 'CREATE ON SCHEMA public'],
  ])('rejects excessive privileges: %s', async (grant, revoke) => {
    await fixture.admin.pool.query(`GRANT ${grant} TO "${fixture.role}"`);
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'PRIVILEGES' });
    } finally {
      await fixture.admin.pool.query(`REVOKE ${revoke} FROM "${fixture.role}"`);
      if (grant.startsWith('UPDATE'))
        await fixture.admin.pool.query(
          `GRANT UPDATE(status,started_at,closed_at,outcome,last_turn_number) ON evaluation_replay.invocations TO "${fixture.role}"`,
        );
    }
  });
  it('rejects inherited privilege escalation and missing column grants', async () => {
    await fixture.admin.pool.query(`GRANT pg_read_all_data TO "${fixture.role}"`);
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'PRIVILEGES' });
    } finally {
      await fixture.admin.pool.query(`REVOKE pg_read_all_data FROM "${fixture.role}"`);
    }
    await fixture.admin.pool.query(
      `REVOKE UPDATE(status) ON evaluation_replay.invocations FROM "${fixture.role}"`,
    );
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'PRIVILEGES' });
    } finally {
      await fixture.admin.pool.query(
        `GRANT UPDATE(status) ON evaluation_replay.invocations TO "${fixture.role}"`,
      );
    }
  });
  it('rejects administrative runtime credentials, read-only sessions and asynchronous durability', async () => {
    await expect(openReplayStore(fixture.migration, operation())).rejects.toMatchObject({
      category: 'PRIVILEGES',
    });
    for (const [setting, category] of [
      ['default_transaction_read_only', 'IDENTITY'],
      ['synchronous_commit', 'DURABILITY'],
    ] as const) {
      await fixture.admin.pool.query(
        `ALTER ROLE "${fixture.role}" SET ${setting}='${setting === 'synchronous_commit' ? 'off' : 'on'}'`,
      );
      try {
        await expect(fixture.open()).rejects.toMatchObject({ category });
      } finally {
        await fixture.admin.pool.query(`ALTER ROLE "${fixture.role}" RESET ${setting}`);
      }
    }
  });
  it('rejects catalog or migration ledger tampering before authorization', async () => {
    await fixture.admin.pool.query(
      'ALTER TABLE evaluation_replay.turns DISABLE TRIGGER replay_turn_guard',
    );
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'SCHEMA' });
    } finally {
      await fixture.admin.pool.query(
        'ALTER TABLE evaluation_replay.turns ENABLE TRIGGER replay_turn_guard',
      );
    }
    const original = (
      await fixture.admin.pool.query<{ hash: string }>(
        'SELECT hash FROM evaluation_replay_migrations.__drizzle_migrations',
      )
    ).rows[0]!.hash;
    await fixture.admin.pool.query(
      "UPDATE evaluation_replay_migrations.__drizzle_migrations SET hash='changed'",
    );
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'SCHEMA' });
      await expect(
        migrateReplayDatabase(fixture.migration, operation(30000)),
      ).rejects.toMatchObject({ category: 'SCHEMA' });
    } finally {
      await fixture.admin.pool.query(
        'UPDATE evaluation_replay_migrations.__drizzle_migrations SET hash=$1',
        [original],
      );
    }
  });
  it('enforces immutable bindings and permanent retention in PostgreSQL itself', async () => {
    const { store, owner } = await started(),
      item = turn();
    await store.issueTurn(owner, item, operation());
    await expect(
      fixture.runtime.pool.query(
        'UPDATE evaluation_replay.invocations SET approval_digest=$2 WHERE invocation_id=$1',
        [owner.invocationId, 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      fixture.admin.pool.query(
        'UPDATE evaluation_replay.invocations SET approval_digest=$2 WHERE invocation_id=$1',
        [owner.invocationId, 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      fixture.admin.pool.query(
        "UPDATE evaluation_replay.turns SET stage='consumed',consumed_at=clock_timestamp() WHERE invocation_id=$1",
        [owner.invocationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const table of ['invocations', 'identifiers', 'turns']) {
      await expect(
        fixture.runtime.pool.query(`DELETE FROM evaluation_replay.${table}`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        fixture.admin.pool.query(`DELETE FROM evaluation_replay.${table} WHERE invocation_id=$1`, [
          owner.invocationId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        fixture.admin.pool.query(`TRUNCATE evaluation_replay.${table} CASCADE`),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await store.retireTurn(owner, item, operation());
    await store.closeInvocation(owner, 'failure', operation());
    await expect(
      fixture.admin.pool.query(
        "UPDATE evaluation_replay.invocations SET status='running',closed_at=NULL,outcome=NULL WHERE invocation_id=$1",
        [owner.invocationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects lost COMMIT acknowledgement even when the durable claim exists', async () => {
    const proxy = await commitLossProxy(fixture.configuration.connectionString);
    let store: Awaited<ReturnType<typeof openReplayStore>> | undefined;
    const value = admission();
    await withTestResourceCleanup(async () => {
      store = await openReplayStore(
        { ...fixture.configuration, connectionString: proxy.connectionString },
        operation(),
      );
      proxy.arm();
      await expect(store.admit(value, operation())).rejects.toMatchObject({
        category: 'COMMIT_UNKNOWN',
      });
      expect(proxy.committed).toBe(true);
      expect(
        (
          await fixture.admin.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM evaluation_replay.invocations WHERE invocation_id=$1',
            [value.invocationId],
          )
        ).rows[0]?.count,
      ).toBe(1);
      const independent = await fixture.open();
      await expect(independent.admit(value, operation())).rejects.toMatchObject({
        category: 'DUPLICATE',
      });
    }, [
      {
        stage: 'store',
        run: async () => {
          await store?.close();
        },
      },
      { stage: 'proxy', run: () => proxy.close() },
    ]);
  });
  it('rolls back an interrupted migration while waiting for its bounded advisory lock', async () => {
    const owned = await createReplayFixture(parseTestDatabaseUrl(process.env), {
      beforeMigrate: async (admin, configuration) => {
        const holder = await admin.pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [0x42444556, 2]);
          const controller = new AbortController();
          const pending = migrateReplayDatabase(configuration, {
            ...operation(30000),
            signal: controller.signal,
          }).then(
            () => 'accepted',
            (error) => (error instanceof ReplayError ? error.category : 'unknown'),
          );
          await waitFor(
            async () =>
              (
                await admin.pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND application_name='beloveddev-evaluation-replay' AND wait_event_type='Lock') waiting",
                )
              ).rows[0]?.waiting === true,
          );
          controller.abort();
          expect(await pending).toBe('TIMEOUT');
          expect(
            (
              await admin.pool.query(
                "SELECT to_regnamespace('evaluation_replay')::text replay,to_regnamespace('evaluation_replay_migrations')::text ledger",
              )
            ).rows[0],
          ).toEqual({ replay: null, ledger: null });
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
        }
      },
    });
    await owned.close();
  });
  it('detects an altered operator marker without installing a replacement', async () => {
    await fixture.admin.pool.query(`COMMENT ON DATABASE "${fixture.name}" IS 'unexpected-marker'`);
    try {
      await expect(fixture.open()).rejects.toMatchObject({ category: 'IDENTITY' });
    } finally {
      await fixture.admin.pool.query(
        `COMMENT ON DATABASE "${fixture.name}" IS 'beloveddev.evaluation-replay:${fixture.configuration.identity.marker}'`,
      );
    }
  });
  it('preserves causal event times after a deterministic simulated backward clock step', async () => {
    const { store, owner } = await started(),
      item = turn(),
      ticket = permit();
    const setup = await fixture.admin.pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(
        'UPDATE evaluation_replay.invocations SET last_turn_number=1 WHERE invocation_id=$1',
        [owner.invocationId],
      );
      // Prior event is ahead of the current clock, modeling a step back without changing host time.
      await setup.query(
        `INSERT INTO evaluation_replay.turns(invocation_id,execution_id,turn_number,turn_id,
        request_digest,transcript_digest,tool_digest,runner_body_digest,digest_version,issued_at)
        VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '2 seconds')`,
        [
          owner.invocationId,
          owner.executionId,
          item.turnId,
          item.requestDigest,
          item.transcriptDigest,
          item.toolDigest,
          item.runnerBodyDigest,
          item.digestVersion,
        ],
      );
      await setup.query('COMMIT');
    } finally {
      await setup.query('ROLLBACK');
      setup.release();
    }
    await store.claimTurn(owner, item, operation());
    await store.prepareTurn(owner, item, ticket, operation());
    await store.consumePermit(owner, item, ticket, operation());
    await store.retireTurn(owner, item, operation());
    await store.closeInvocation(owner, 'success', operation());
    const result = await fixture.admin.pool.query<{ ordered: boolean }>(
      `SELECT t.issued_at<=t.claimed_at AND t.claimed_at<=t.prepared_at
      AND t.prepared_at<=t.consumed_at AND t.consumed_at<=t.retired_at AND t.retired_at<=i.closed_at ordered
      FROM evaluation_replay.turns t JOIN evaluation_replay.invocations i USING(invocation_id) WHERE t.invocation_id=$1`,
      [owner.invocationId],
    );
    expect(result.rows[0]?.ordered).toBe(true);
  });
  it('attempts independent fixture cleanup and preserves assertion plus cleanup failures', async () => {
    const owned = await createReplayFixture(parseTestDatabaseUrl(process.env)),
      store = await owned.open();
    const close = store.close.bind(store);
    vi.spyOn(store, 'close').mockRejectedValue(new Error('injected safe cleanup failure'));
    const held = await owned.admin.pool.connect();
    await held.query('BEGIN');
    try {
      await expect(
        withTestResourceCleanup(() => {
          throw new Error('original assertion');
        }, [{ stage: 'fixture', run: owned.close }]),
      ).rejects.toMatchObject({
        errors: [{ message: 'original assertion' }, { name: 'TestCleanupError' }],
      });
      expect(
        (
          await fixture.admin.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM pg_database WHERE datname=$1',
            [owned.name],
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(
        (
          await fixture.admin.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM pg_roles WHERE rolname=$1',
            [owned.role],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await close();
    }
  });
});
