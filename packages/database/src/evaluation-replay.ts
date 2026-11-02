import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const replayBindingSchema = z.strictObject({
  invocationId: z.uuid(),
  approvalId: z.uuid(),
  executionId: z.uuid(),
  approvalDigest: digest,
  ownerKeyFingerprint: digest,
  fixtureManifestDigest: digest,
  scenarioSetDigest: digest,
  scenarioId: z.enum([
    'evidence_retrieval',
    'opportunity_selection',
    'score_interpretation',
    'unavailable_information',
    'tenant_boundary',
    'mutation_refusal',
  ]),
  model: z.literal('gpt-4.1-mini-2025-04-14'),
  compatibilityProfile: z.literal('gpt41-mini-text-v1-2026-10-29'),
  planDigest: digest,
});
export const replayAdmissionSchema = replayBindingSchema
  .extend({
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    pricingVerifiedAt: z.iso.datetime(),
    maxCalls: z.number().int().min(1).max(36),
    maxInputTokensPerCall: z.number().int().min(1).max(1_000_000),
    maxOutputTokensPerCall: z.number().int().min(16).max(512),
    maxTotalTokens: z.number().int().min(1).max(4096),
    maxPlannedCostMicroUsd: z.number().int().min(1).max(1_000_000),
  })
  .superRefine((value, context) => {
    const issued = Date.parse(value.issuedAt),
      expires = Date.parse(value.expiresAt);
    if (
      expires <= issued ||
      expires - issued > 900_000 ||
      Date.parse(value.pricingVerifiedAt) > issued ||
      expires > Date.parse('2027-01-14T00:00:00Z') ||
      value.maxCalls * (value.maxInputTokensPerCall + value.maxOutputTokensPerCall) >
        value.maxTotalTokens
    )
      context.addIssue({ code: 'custom', message: 'Invalid replay admission bounds.' });
  });
export const replayTurnSchema = z.strictObject({
  turnId: z.uuid(),
  turnNumber: z.number().int().min(1).max(6),
  requestDigest: digest,
  transcriptDigest: digest,
  toolDigest: digest,
  runnerBodyDigest: digest,
  digestVersion: z.literal('json-stringify-v1'),
});
export const replayPermitSchema = z.strictObject({
  permitId: z.uuid(),
  reservationId: z.uuid(),
  rawBodyDigest: digest,
  outputCap: z.number().int().min(16).max(512),
});
export const replayIdentitySchema = z.strictObject({
  systemIdentifier: z.string().regex(/^[1-9][0-9]{0,19}$/),
  databaseOid: z.number().int().positive().max(4_294_967_295),
  marker: z.uuid(),
});
export const replayOutcomeSchema = z.enum(['success', 'failure', 'unknown']);
export type ReplayBinding = Readonly<z.infer<typeof replayBindingSchema>>;
export type ReplayAdmission = Readonly<z.infer<typeof replayAdmissionSchema>>;
export type ReplayTurn = Readonly<z.infer<typeof replayTurnSchema>>;
export type ReplayPermit = Readonly<z.infer<typeof replayPermitSchema>>;
export type ReplayIdentity = Readonly<z.infer<typeof replayIdentitySchema>>;
export type ReplayDatabaseConfiguration = Readonly<{
  connectionString: string;
  tlsCa?: string;
  identity: ReplayIdentity;
}>;
export type ReplayOutcome = z.infer<typeof replayOutcomeSchema>;
/** Absolute monotonic caller deadline; storage never adds time to the execution budget. */
export type ReplayOperation = Readonly<{ deadlineAt: number; signal?: AbortSignal }>;
export type ReplayFailure =
  | 'VALIDATION'
  | 'DUPLICATE'
  | 'BINDING'
  | 'STATE'
  | 'EXPIRED'
  | 'IDENTITY'
  | 'SCHEMA'
  | 'PRIVILEGES'
  | 'DURABILITY'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'COMMIT_UNKNOWN'
  | 'CLEANUP';
export class ReplayError extends Error {
  constructor(readonly category: ReplayFailure) {
    super('Replay ledger operation was not authorized.');
    this.name = 'ReplayError';
  }
}
/** Persistence only. These operations do not verify signatures or mint live capabilities. */
export interface ReplayStore {
  admit(admission: ReplayAdmission, operation: ReplayOperation): Promise<void>;
  start(binding: ReplayBinding, operation: ReplayOperation): Promise<void>;
  issueTurn(binding: ReplayBinding, turn: ReplayTurn, operation: ReplayOperation): Promise<void>;
  claimTurn(binding: ReplayBinding, turn: ReplayTurn, operation: ReplayOperation): Promise<void>;
  prepareTurn(
    binding: ReplayBinding,
    turn: ReplayTurn,
    permit: ReplayPermit,
    operation: ReplayOperation,
  ): Promise<void>;
  consumePermit(
    binding: ReplayBinding,
    turn: ReplayTurn,
    permit: ReplayPermit,
    operation: ReplayOperation,
  ): Promise<void>;
  retireTurn(binding: ReplayBinding, turn: ReplayTurn, operation: ReplayOperation): Promise<void>;
  closeInvocation(
    binding: ReplayBinding,
    outcome: ReplayOutcome,
    operation: ReplayOperation,
  ): Promise<void>;
  close(): Promise<void>;
}
