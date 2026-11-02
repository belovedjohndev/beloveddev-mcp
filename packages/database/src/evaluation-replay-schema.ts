import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const replay = pgSchema('evaluation_replay');
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const replayInvocations = replay.table(
  'invocations',
  {
    invocationId: uuid('invocation_id').primaryKey(),
    approvalId: uuid('approval_id').notNull().unique(),
    executionId: uuid('execution_id').notNull().unique(),
    approvalDigest: text('approval_digest').notNull(),
    ownerKeyFingerprint: text('owner_key_fingerprint').notNull(),
    fixtureManifestDigest: text('fixture_manifest_digest').notNull(),
    scenarioSetDigest: text('scenario_set_digest').notNull(),
    scenarioId: text('scenario_id').notNull(),
    model: text('model').notNull(),
    compatibilityProfile: text('compatibility_profile').notNull(),
    planDigest: text('plan_digest').notNull(),
    issuedAt: at('issued_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    pricingVerifiedAt: at('pricing_verified_at').notNull(),
    admittedAt: at('admitted_at')
      .notNull()
      .default(sql`clock_timestamp()`),
    maxCalls: integer('max_calls').notNull(),
    maxInputTokensPerCall: integer('max_input_tokens_per_call').notNull(),
    maxOutputTokensPerCall: integer('max_output_tokens_per_call').notNull(),
    maxTotalTokens: integer('max_total_tokens').notNull(),
    maxPlannedCostMicroUsd: bigint('max_planned_cost_micro_usd', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('admitted'),
    startedAt: at('started_at'),
    closedAt: at('closed_at'),
    outcome: text('outcome'),
    lastTurnNumber: integer('last_turn_number').notNull().default(0),
  },
  (t) => [
    unique('replay_invocation_owner').on(t.invocationId, t.executionId),
    check(
      'replay_invocation_digests',
      sql`${t.approvalDigest} ~ '^[a-f0-9]{64}$' AND ${t.ownerKeyFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.fixtureManifestDigest} ~ '^[a-f0-9]{64}$' AND ${t.scenarioSetDigest} ~ '^[a-f0-9]{64}$' AND ${t.planDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'replay_invocation_model',
      sql`${t.model} = 'gpt-4.1-mini-2025-04-14' AND ${t.compatibilityProfile} = 'gpt41-mini-text-v1-2026-10-29'`,
    ),
    check(
      'replay_invocation_scenario',
      sql`${t.scenarioId} IN ('evidence_retrieval','opportunity_selection','score_interpretation','unavailable_information','tenant_boundary','mutation_refusal')`,
    ),
    check(
      'replay_invocation_times',
      sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + interval '15 minutes' AND ${t.expiresAt} <= timestamptz '2027-01-14 00:00:00+00' AND ${t.pricingVerifiedAt} <= ${t.issuedAt} AND ${t.admittedAt} >= ${t.issuedAt} AND ${t.admittedAt} < ${t.expiresAt} AND (${t.startedAt} IS NULL OR (${t.startedAt} >= ${t.admittedAt} AND ${t.startedAt} < ${t.expiresAt})) AND (${t.closedAt} IS NULL OR ${t.closedAt} >= ${t.admittedAt})`,
    ),
    check(
      'replay_invocation_limits',
      sql`${t.maxCalls} BETWEEN 1 AND 36 AND ${t.maxInputTokensPerCall} BETWEEN 1 AND 1000000 AND ${t.maxOutputTokensPerCall} BETWEEN 16 AND 512 AND ${t.maxTotalTokens} BETWEEN 1 AND 4096 AND ${t.maxPlannedCostMicroUsd} BETWEEN 1 AND 1000000 AND ${t.maxCalls}::bigint * (${t.maxInputTokensPerCall} + ${t.maxOutputTokensPerCall}) <= ${t.maxTotalTokens} AND ${t.lastTurnNumber} BETWEEN 0 AND least(${t.maxCalls}, 6)`,
    ),
    check(
      'replay_invocation_state',
      sql`(${t.status} = 'admitted' AND ${t.startedAt} IS NULL AND ${t.closedAt} IS NULL AND ${t.outcome} IS NULL AND ${t.lastTurnNumber} = 0) OR (${t.status} = 'running' AND ${t.startedAt} IS NOT NULL AND ${t.closedAt} IS NULL AND ${t.outcome} IS NULL) OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL AND ${t.outcome} IS NOT NULL AND ${t.outcome} IN ('success','failure','unknown'))`,
    ),
  ],
);
export const replayIdentifiers = replay.table('identifiers', {
  identifier: uuid('identifier').primaryKey(),
  invocationId: uuid('invocation_id')
    .notNull()
    .references(() => replayInvocations.invocationId, { onDelete: 'restrict' }),
});
export const replayTurns = replay.table(
  'turns',
  {
    invocationId: uuid('invocation_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    turnNumber: integer('turn_number').notNull(),
    turnId: uuid('turn_id').notNull().unique(),
    requestDigest: text('request_digest').notNull(),
    transcriptDigest: text('transcript_digest').notNull(),
    toolDigest: text('tool_digest').notNull(),
    runnerBodyDigest: text('runner_body_digest').notNull(),
    digestVersion: text('digest_version').notNull(),
    stage: text('stage').notNull().default('issued'),
    issuedAt: at('issued_at')
      .notNull()
      .default(sql`clock_timestamp()`),
    claimedAt: at('claimed_at'),
    preparedAt: at('prepared_at'),
    consumedAt: at('consumed_at'),
    retiredAt: at('retired_at'),
    permitId: uuid('permit_id').unique(),
    reservationId: uuid('reservation_id').unique(),
    rawBodyDigest: text('raw_body_digest'),
    outputCap: integer('output_cap'),
  },
  (t) => [
    primaryKey({ columns: [t.invocationId, t.turnNumber] }),
    foreignKey({
      name: 'replay_turn_owner',
      columns: [t.invocationId, t.executionId],
      foreignColumns: [replayInvocations.invocationId, replayInvocations.executionId],
    }).onDelete('restrict'),
    check('replay_turn_number', sql`${t.turnNumber} BETWEEN 1 AND 6`),
    check(
      'replay_turn_digests',
      sql`${t.requestDigest} ~ '^[a-f0-9]{64}$' AND ${t.transcriptDigest} ~ '^[a-f0-9]{64}$' AND ${t.toolDigest} ~ '^[a-f0-9]{64}$' AND ${t.runnerBodyDigest} ~ '^[a-f0-9]{64}$' AND ${t.digestVersion} = 'json-stringify-v1'`,
    ),
    check(
      'replay_turn_times',
      sql`(${t.claimedAt} IS NULL OR ${t.claimedAt} >= ${t.issuedAt}) AND (${t.preparedAt} IS NULL OR ${t.preparedAt} >= ${t.claimedAt}) AND (${t.consumedAt} IS NULL OR ${t.consumedAt} >= ${t.preparedAt}) AND (${t.retiredAt} IS NULL OR ${t.retiredAt} >= ${t.issuedAt})`,
    ),
    check(
      'replay_turn_state',
      sql`(${t.stage} = 'issued' AND ${t.claimedAt} IS NULL AND ${t.preparedAt} IS NULL AND ${t.consumedAt} IS NULL) OR (${t.stage} = 'claimed' AND ${t.claimedAt} IS NOT NULL AND ${t.preparedAt} IS NULL AND ${t.consumedAt} IS NULL) OR (${t.stage} = 'prepared' AND ${t.claimedAt} IS NOT NULL AND ${t.preparedAt} IS NOT NULL AND ${t.consumedAt} IS NULL) OR (${t.stage} = 'consumed' AND ${t.claimedAt} IS NOT NULL AND ${t.preparedAt} IS NOT NULL AND ${t.consumedAt} IS NOT NULL)`,
    ),
    check(
      'replay_turn_permit',
      sql`(${t.stage} IN ('issued','claimed') AND ${t.permitId} IS NULL AND ${t.reservationId} IS NULL AND ${t.rawBodyDigest} IS NULL AND ${t.outputCap} IS NULL) OR (${t.stage} IN ('prepared','consumed') AND ${t.permitId} IS NOT NULL AND ${t.reservationId} IS NOT NULL AND ${t.rawBodyDigest} IS NOT NULL AND ${t.rawBodyDigest} ~ '^[a-f0-9]{64}$' AND ${t.outputCap} IS NOT NULL AND ${t.outputCap} BETWEEN 16 AND 512)`,
    ),
  ],
);
