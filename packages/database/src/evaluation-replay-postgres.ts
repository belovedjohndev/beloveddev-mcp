import type { z } from 'zod';
import type { Client } from 'pg';
import {
  ReplayError,
  replayAdmissionSchema,
  replayBindingSchema,
  replayTurnSchema,
  replayPermitSchema,
  replayOutcomeSchema,
  type ReplayDatabaseConfiguration,
  type ReplayAdmission,
  type ReplayBinding,
  type ReplayTurn,
  type ReplayPermit,
  type ReplayOutcome,
  type ReplayOperation,
  type ReplayStore,
} from './evaluation-replay.js';
import {
  replayConnection,
  replayTransaction,
  verifyReplayIdentity,
  verifyReplayPrivileges,
  verifyReplaySchema,
} from './evaluation-replay-policy.js';

const bindingColumns = {
  invocationId: 'invocation_id',
  approvalId: 'approval_id',
  executionId: 'execution_id',
  approvalDigest: 'approval_digest',
  ownerKeyFingerprint: 'owner_key_fingerprint',
  fixtureManifestDigest: 'fixture_manifest_digest',
  scenarioSetDigest: 'scenario_set_digest',
  scenarioId: 'scenario_id',
  model: 'model',
  compatibilityProfile: 'compatibility_profile',
  planDigest: 'plan_digest',
} satisfies Record<keyof ReplayBinding, string>;
const turnColumns = {
  turnId: 'turn_id',
  turnNumber: 'turn_number',
  requestDigest: 'request_digest',
  transcriptDigest: 'transcript_digest',
  toolDigest: 'tool_digest',
  runnerBodyDigest: 'runner_body_digest',
  digestVersion: 'digest_version',
} satisfies Record<keyof ReplayTurn, string>;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ReplayError('VALIDATION');
  return result.data;
}
function matches<T extends object>(
  columns: Record<keyof T, string>,
  expected: T,
  row: Record<string, unknown>,
) {
  for (const key of Object.keys(columns) as (keyof T)[]) {
    const value = row[columns[key]];
    const wanted = expected[key];
    const uuid = columns[key].endsWith('_id');
    if (uuid && typeof value === 'string' && typeof wanted === 'string') {
      if (value !== wanted.toLowerCase()) throw new ReplayError('BINDING');
    } else if (value !== wanted) throw new ReplayError('BINDING');
  }
}
function one(result: { rowCount: number | null }, category: 'STATE' | 'DUPLICATE' = 'STATE') {
  if (result.rowCount !== 1) throw new ReplayError(category);
}
async function fresh(client: Client, invocationId: string) {
  const result = await client.query<{ valid: boolean }>(
    `SELECT clock_timestamp() >= issued_at AND clock_timestamp() < expires_at
    AND pricing_verified_at <= clock_timestamp() AND pricing_verified_at >= clock_timestamp()-interval '24 hours' valid
    FROM evaluation_replay.invocations WHERE invocation_id=$1`,
    [invocationId],
  );
  if (result.rowCount !== 1 || result.rows[0]?.valid !== true) throw new ReplayError('EXPIRED');
}
class PostgresReplayStore implements ReplayStore {
  private readonly configuration;
  private readonly active = new Map<AbortController, Promise<void>>();
  private closing: Promise<void> | undefined;
  constructor(configuration: ReplayDatabaseConfiguration) {
    this.configuration = replayConnection(configuration);
  }
  private session(
    operation: ReplayOperation,
    work: (client: Client) => Promise<void>,
  ): Promise<void> {
    if (this.closing) return Promise.reject(new ReplayError('STATE'));
    if (this.active.size >= 2) return Promise.reject(new ReplayError('TIMEOUT'));
    const controller = new AbortController();
    const signal = operation.signal
      ? AbortSignal.any([controller.signal, operation.signal])
      : controller.signal;
    const task = replayTransaction(
      this.configuration.connection,
      { deadlineAt: operation.deadlineAt, signal },
      async (client) => {
        const { identity, database, user } = this.configuration;
        await verifyReplayIdentity(client, identity, database, user);
        await verifyReplaySchema(client);
        await verifyReplayPrivileges(client);
        await work(client);
      },
    ).finally(() => {
      this.active.delete(controller);
    });
    this.active.set(controller, task);
    return task;
  }
  initialize(operation: ReplayOperation) {
    return this.session(operation, () => Promise.resolve());
  }
  private execute(
    input: ReplayBinding,
    operation: ReplayOperation,
    work: (client: Client, root: Record<string, unknown>, binding: ReplayBinding) => Promise<void>,
    needsFresh = true,
  ) {
    const binding = parse(replayBindingSchema, input);
    return this.session(operation, async (client) => {
      const found = await client.query<Record<string, unknown>>(
        'SELECT * FROM evaluation_replay.invocations WHERE invocation_id=$1 FOR UPDATE',
        [binding.invocationId],
      );
      const root = found.rows[0];
      if (!root) throw new ReplayError('BINDING');
      matches(bindingColumns, binding, root);
      if (root['status'] === 'closed') throw new ReplayError('STATE');
      if (needsFresh) await fresh(client, binding.invocationId);
      await work(client, root, binding);
      if (needsFresh) await fresh(client, binding.invocationId);
    });
  }
  async admit(input: ReplayAdmission, operation: ReplayOperation): Promise<void> {
    const admission = parse(replayAdmissionSchema, input);
    await this.session(operation, async (client) => {
      const valid = await client.query<{ valid: boolean }>(
        `SELECT clock_timestamp() >= $1::timestamptz AND clock_timestamp() < $2::timestamptz
        AND $3::timestamptz <= clock_timestamp() AND $3::timestamptz >= clock_timestamp()-interval '24 hours' valid`,
        [admission.issuedAt, admission.expiresAt, admission.pricingVerifiedAt],
      );
      if (valid.rows[0]?.valid !== true) throw new ReplayError('EXPIRED');
      const columns = {
        ...bindingColumns,
        issuedAt: 'issued_at',
        expiresAt: 'expires_at',
        pricingVerifiedAt: 'pricing_verified_at',
        maxCalls: 'max_calls',
        maxInputTokensPerCall: 'max_input_tokens_per_call',
        maxOutputTokensPerCall: 'max_output_tokens_per_call',
        maxTotalTokens: 'max_total_tokens',
        maxPlannedCostMicroUsd: 'max_planned_cost_micro_usd',
      } satisfies Record<keyof ReplayAdmission, string>;
      const keys = Object.keys(columns) as (keyof ReplayAdmission)[];
      one(
        await client.query(
          `INSERT INTO evaluation_replay.invocations (${keys.map((k) => columns[k]).join(',')})
        VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT DO NOTHING RETURNING invocation_id`,
          keys.map((k) => admission[k]),
        ),
        'DUPLICATE',
      );
      const identifiers = [
        ...new Set([admission.invocationId.toLowerCase(), admission.approvalId.toLowerCase()]),
      ].sort();
      for (const identifier of identifiers)
        one(
          await client.query(
            `INSERT INTO evaluation_replay.identifiers(identifier,invocation_id)
        VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING identifier`,
            [identifier, admission.invocationId],
          ),
          'DUPLICATE',
        );
      await fresh(client, admission.invocationId);
    });
  }
  start(binding: ReplayBinding, operation: ReplayOperation) {
    return this.execute(binding, operation, async (client, _root, b) => {
      one(
        await client.query(
          `UPDATE evaluation_replay.invocations SET status='running',started_at=greatest(clock_timestamp(),admitted_at)
        WHERE invocation_id=$1 AND status='admitted' AND started_at IS NULL`,
          [b.invocationId],
        ),
      );
    });
  }
  issueTurn(binding: ReplayBinding, input: ReplayTurn, operation: ReplayOperation) {
    const turn = parse(replayTurnSchema, input);
    return this.execute(binding, operation, async (client, root, b) => {
      if (
        root['status'] !== 'running' ||
        root['last_turn_number'] !== turn.turnNumber - 1 ||
        typeof root['max_calls'] !== 'number' ||
        turn.turnNumber > root['max_calls']
      )
        throw new ReplayError('STATE');
      one(
        await client.query(
          `UPDATE evaluation_replay.invocations SET last_turn_number=$2
        WHERE invocation_id=$1 AND last_turn_number=$2-1 AND status='running'`,
          [b.invocationId, turn.turnNumber],
        ),
      );
      const keys = Object.keys(turnColumns) as (keyof ReplayTurn)[];
      one(
        await client.query(
          `INSERT INTO evaluation_replay.turns(invocation_id,execution_id,issued_at,${keys.map((k) => turnColumns[k]).join(',')})
        VALUES ($1,$2,greatest(clock_timestamp(),(SELECT started_at FROM evaluation_replay.invocations WHERE invocation_id=$1)),${keys.map((_, i) => '$' + (i + 3)).join(',')})`,
          [b.invocationId, b.executionId, ...keys.map((k) => turn[k])],
        ),
      );
    });
  }
  private async lockedTurn(client: Client, binding: ReplayBinding, turn: ReplayTurn) {
    const result = await client.query<Record<string, unknown>>(
      'SELECT * FROM evaluation_replay.turns WHERE invocation_id=$1 AND turn_number=$2 FOR UPDATE',
      [binding.invocationId, turn.turnNumber],
    );
    const row = result.rows[0];
    if (!row || row['execution_id'] !== binding.executionId.toLowerCase())
      throw new ReplayError('BINDING');
    matches(turnColumns, turn, row);
    if (row['retired_at'] !== null) throw new ReplayError('STATE');
    return row;
  }
  claimTurn(binding: ReplayBinding, input: ReplayTurn, operation: ReplayOperation) {
    const turn = parse(replayTurnSchema, input);
    return this.execute(binding, operation, async (client, root, b) => {
      if (root['status'] !== 'running') throw new ReplayError('STATE');
      await this.lockedTurn(client, b, turn);
      one(
        await client.query(
          `UPDATE evaluation_replay.turns SET stage='claimed',claimed_at=greatest(clock_timestamp(),issued_at)
        WHERE invocation_id=$1 AND turn_number=$2 AND stage='issued' AND retired_at IS NULL`,
          [b.invocationId, turn.turnNumber],
        ),
      );
    });
  }
  prepareTurn(
    binding: ReplayBinding,
    input: ReplayTurn,
    supplied: ReplayPermit,
    operation: ReplayOperation,
  ) {
    const turn = parse(replayTurnSchema, input),
      permit = parse(replayPermitSchema, supplied);
    return this.execute(binding, operation, async (client, root, b) => {
      if (
        root['status'] !== 'running' ||
        typeof root['max_output_tokens_per_call'] !== 'number' ||
        permit.outputCap > root['max_output_tokens_per_call']
      )
        throw new ReplayError('STATE');
      await this.lockedTurn(client, b, turn);
      one(
        await client.query(
          `UPDATE evaluation_replay.turns SET stage='prepared',prepared_at=greatest(clock_timestamp(),claimed_at),
        permit_id=$3,reservation_id=$4,raw_body_digest=$5,output_cap=$6
        WHERE invocation_id=$1 AND turn_number=$2 AND stage='claimed' AND retired_at IS NULL`,
          [
            b.invocationId,
            turn.turnNumber,
            permit.permitId,
            permit.reservationId,
            permit.rawBodyDigest,
            permit.outputCap,
          ],
        ),
      );
    });
  }
  consumePermit(
    binding: ReplayBinding,
    input: ReplayTurn,
    supplied: ReplayPermit,
    operation: ReplayOperation,
  ) {
    const turn = parse(replayTurnSchema, input),
      permit = parse(replayPermitSchema, supplied);
    return this.execute(binding, operation, async (client, root, b) => {
      if (root['status'] !== 'running') throw new ReplayError('STATE');
      const row = await this.lockedTurn(client, b, turn);
      matches(
        {
          permitId: 'permit_id',
          reservationId: 'reservation_id',
          rawBodyDigest: 'raw_body_digest',
          outputCap: 'output_cap',
        },
        permit,
        row,
      );
      one(
        await client.query(
          `UPDATE evaluation_replay.turns SET stage='consumed',consumed_at=greatest(clock_timestamp(),prepared_at)
        WHERE invocation_id=$1 AND turn_number=$2 AND stage='prepared' AND permit_id=$3 AND reservation_id=$4
        AND raw_body_digest=$5 AND output_cap=$6 AND retired_at IS NULL`,
          [
            b.invocationId,
            turn.turnNumber,
            permit.permitId,
            permit.reservationId,
            permit.rawBodyDigest,
            permit.outputCap,
          ],
        ),
      );
    });
  }
  retireTurn(binding: ReplayBinding, input: ReplayTurn, operation: ReplayOperation) {
    const turn = parse(replayTurnSchema, input);
    return this.execute(
      binding,
      operation,
      async (client, _root, b) => {
        await this.lockedTurn(client, b, turn);
        one(
          await client.query(
            `UPDATE evaluation_replay.turns SET retired_at=greatest(clock_timestamp(),issued_at,claimed_at,prepared_at,consumed_at)
        WHERE invocation_id=$1 AND turn_number=$2 AND retired_at IS NULL`,
            [b.invocationId, turn.turnNumber],
          ),
        );
      },
      false,
    );
  }
  closeInvocation(binding: ReplayBinding, supplied: ReplayOutcome, operation: ReplayOperation) {
    const outcome = parse(replayOutcomeSchema, supplied);
    return this.execute(
      binding,
      operation,
      async (client, _root, b) => {
        one(
          await client.query(
            `UPDATE evaluation_replay.invocations SET status='closed',closed_at=greatest(clock_timestamp(),admitted_at,started_at,(SELECT max(retired_at) FROM evaluation_replay.turns WHERE invocation_id=$1)),outcome=$2
        WHERE invocation_id=$1 AND status IN ('admitted','running')`,
            [b.invocationId, outcome],
          ),
        );
      },
      false,
    );
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      const tasks = [...this.active.values()];
      for (const controller of this.active.keys()) controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.allSettled(tasks),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ReplayError('CLEANUP')), 5000);
          }),
        ]);
        if (
          results.some(
            (r) =>
              r.status === 'rejected' &&
              r.reason instanceof ReplayError &&
              r.reason.category === 'CLEANUP',
          )
        )
          throw new ReplayError('CLEANUP');
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closing;
  }
}
/** Explicit offline storage construction; no provider import or capability issuance. */
export async function openReplayStore(
  configuration: ReplayDatabaseConfiguration,
  operation: ReplayOperation,
): Promise<ReplayStore> {
  const store = new PostgresReplayStore(configuration);
  try {
    await store.initialize(operation);
    return store;
  } catch (error: unknown) {
    try {
      await store.close();
    } catch {
      throw new ReplayError('CLEANUP');
    }
    throw error;
  }
}
