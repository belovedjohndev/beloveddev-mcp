import { describe, expect, it } from 'vitest';
import {
  replayAdmissionSchema,
  replayBindingSchema,
  replayPermitSchema,
  replayTurnSchema,
  ReplayError,
} from '../src/evaluation-replay.js';
import {
  parseReplayMigrationEnvironment,
  replayConnection,
} from '../src/evaluation-replay-migrate.js';
import { replayFailure } from '../src/evaluation-replay-policy.js';
import { admission, binding, permit, turn } from './evaluation-replay-fixture.js';

describe('replay ledger boundary validation', () => {
  it('accepts bounded metadata without request payloads', () => {
    expect(replayAdmissionSchema.safeParse(admission()).success).toBe(true);
    expect(replayBindingSchema.safeParse(binding(admission())).success).toBe(true);
    expect(replayTurnSchema.safeParse(turn()).success).toBe(true);
    expect(replayPermitSchema.safeParse(permit()).success).toBe(true);
  });
  it.each(['prompt', 'response', 'password', 'tenantId', 'signature'])(
    'rejects unexpected %s rather than storing payloads',
    (field) => {
      expect(
        replayAdmissionSchema.safeParse({ ...admission(), [field]: 'private-value' }).success,
      ).toBe(false);
    },
  );
  it.each([
    { maxTotalTokens: 4097 },
    { maxCalls: 37 },
    { maxOutputTokensPerCall: 513 },
    { maxPlannedCostMicroUsd: 1000001 },
    { model: 'other-model' },
    { compatibilityProfile: 'other-profile' },
    { approvalDigest: 'bad' },
    { expiresAt: '2030-01-01T00:00:00Z' },
  ])('rejects invalid limits or bindings: %j', (change) => {
    expect(replayAdmissionSchema.safeParse({ ...admission(), ...change }).success).toBe(false);
  });
  it('rejects invalid lifetime, pricing ordering and a plan exceeding the token ceiling', () => {
    const base = admission();
    for (const change of [
      { expiresAt: base.issuedAt },
      { expiresAt: new Date(Date.parse(base.issuedAt) + 900001).toISOString() },
      { pricingVerifiedAt: base.expiresAt },
      { maxInputTokensPerCall: 4096 },
    ])
      expect(replayAdmissionSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });
  it('requires explicit evaluator migration credentials and identity', () => {
    expect(() =>
      parseReplayMigrationEnvironment({
        DATABASE_MIGRATION_URL: 'postgresql://user:private@localhost/db',
      }),
    ).toThrow(ReplayError);
    expect(() =>
      parseReplayMigrationEnvironment({
        EVALUATION_REPLAY_MIGRATION_URL: 'postgresql://user:private@localhost/db',
      }),
    ).toThrow(ReplayError);
  });
  it('preserves verified remote TLS policy and rejects URL security overrides safely', () => {
    const identity = { systemIdentifier: '123', databaseOid: 1, marker: admission().invocationId };
    for (const url of [
      'postgresql://user:private@remote.example/db',
      'postgresql://user:private@remote.example/db?sslmode=disable',
      'postgresql://user:private@localhost/db?sslmode=no-verify',
    ]) {
      expect(() => replayConnection({ connectionString: url, identity })).toThrow(
        'Replay ledger operation was not authorized.',
      );
    }
    const valid = replayConnection({
      connectionString: 'postgresql://user:private@remote.example/db?sslmode=verify-full',
      identity,
    });
    expect(valid.connection.ssl).toMatchObject({ rejectUnauthorized: true });
  });
  it('classifies unknown commits as failure without exposing driver messages', () => {
    const error = replayFailure(new Error('private-password-and-url'), true);
    expect(error.category).toBe('COMMIT_UNKNOWN');
    expect(JSON.stringify(error)).not.toContain('private');
    expect(error.message).not.toContain('private');
    expect(replayFailure({ code: '23505' }).category).toBe('DUPLICATE');
    expect(replayFailure({ code: '25P04' }).category).toBe('TIMEOUT');
  });
});
