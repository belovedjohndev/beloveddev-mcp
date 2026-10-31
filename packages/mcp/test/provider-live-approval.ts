import { createHash, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  AgentFailure,
  scenarioIds,
  prepareAuthorizedTurn,
  consumePreparedTurn,
  type LiveTurnAuthorization,
} from './agent-evaluation.js';
import {
  fixtureApprovalBinding,
  type SyntheticAgentFixture,
  type AgentScenarioId,
} from './evaluation-fixture.js';
import { isDeepStrictEqual } from 'node:util';
import {
  liveRunAuthorizationSchema,
  providerPlanSchema,
  ProviderBudget,
} from './provider-budget.js';
import {
  createLiveInputEstimator,
  liveCompatibilityProfile,
  liveModel,
  modelShutdown,
  type LiveInputEstimator,
} from './provider-input-estimator.js';

export const signedApprovalSchema = z.strictObject({
  approval: liveRunAuthorizationSchema
    .extend({
      model: z.literal(liveModel),
      compatibilityProfile: z.literal(liveCompatibilityProfile),
      approvalId: z.uuid(),
      fixtureManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      scenarioSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
      scenarioInventory: z.tuple([z.enum(scenarioIds)]),
      ownerKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      reviewReference: z.string().trim().min(1).max(200),
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type SignedApproval = z.infer<typeof signedApprovalSchema>;
const grantBrand: unique symbol = Symbol('live-evaluation-grant');
export interface LiveGrant {
  readonly [grantBrand]: true;
}
const permitBrand: unique symbol = Symbol('live-request-permit');
export interface LiveRequestPermit {
  readonly [permitBrand]: true;
}
type GrantState = {
  invocationId: string;
  approvalId: string;
  issued: number;
  expires: number;
  monotonicStart: number;
  remainingLifetime: number;
  verifiedPricing: number;
  revoked: boolean;
  executionStarted: boolean;
  fixture: SyntheticAgentFixture;
  scenarioId: AgentScenarioId;
  binding: ReturnType<typeof fixtureApprovalBinding>;
  budget: ProviderBudget;
  estimator: LiveInputEstimator;
};
const grants = new WeakMap<object, GrantState>();
const permits = new WeakMap<
  object,
  {
    grant: LiveGrant;
    invocationId: string;
    turn: LiveTurnAuthorization | undefined;
    digest: string;
    used: boolean;
    reservation: object;
  }
>();
const issuedApprovals = new Set<string>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const ownerKeyFingerprint = (key: KeyObject) => {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
    throw new AgentFailure('approval_invalid');
  return hash(key.export({ type: 'spki', format: 'der' }));
};
export function approvalSigningBytes(input: unknown): Buffer {
  const parsed = signedApprovalSchema.shape.approval.safeParse(input);
  if (!parsed.success) throw new AgentFailure('approval_invalid');
  return Buffer.from(JSON.stringify(parsed.data));
}
function stateFor(grant: LiveGrant): GrantState {
  const state = grants.get(grant);
  if (!state || state.revoked) throw new AgentFailure('approval_invalid');
  return state;
}
function checkFresh(state: GrantState) {
  const now = Date.now();
  if (
    now < state.issued ||
    now >= state.expires ||
    now >= modelShutdown ||
    performance.now() - state.monotonicStart >= state.remainingLifetime ||
    now - state.verifiedPricing > 86400000 ||
    state.verifiedPricing > now
  )
    throw new AgentFailure('approval_expired');
}
/** Verify externally trusted owner provenance. No key/document/env-file loading occurs here. */
export function verifyLiveApproval(
  input: unknown,
  trustedOwnerKey: KeyObject,
  invocationId: string,
  fixture?: SyntheticAgentFixture,
): LiveGrant {
  const parsed = signedApprovalSchema.safeParse(input);
  if (!parsed.success) throw new AgentFailure('approval_invalid');
  const { approval, signature } = parsed.data;
  if (
    approval.invocationId !== invocationId ||
    ownerKeyFingerprint(trustedOwnerKey) !== approval.ownerKeyFingerprint
  )
    throw new AgentFailure('approval_mismatch');
  const bytes = Buffer.from(signature, 'base64');
  if (
    bytes.length !== 64 ||
    bytes.toString('base64') !== signature ||
    !verify(null, approvalSigningBytes(approval), trustedOwnerKey, bytes)
  )
    throw new AgentFailure('approval_invalid');
  const issued = Date.parse(approval.issuedAt),
    expires = Date.parse(approval.expiresAt),
    verifiedPricing = Date.parse(approval.pricing.verifiedAt);
  if (expires <= issued || expires - issued > 900000 || verifiedPricing > issued)
    throw new AgentFailure('approval_invalid');
  if (
    approval.pricing.source !== 'https://developers.openai.com/api/docs/pricing' ||
    approval.pricing.inputMicroUsdPerMillion < 400000 ||
    approval.pricing.cacheWriteMicroUsdPerMillion < 400000 ||
    approval.pricing.outputMicroUsdPerMillion < 1600000 ||
    approval.inputOverheadTokens < 1024 ||
    approval.maxOutputTokensPerCall < 16
  )
    throw new AgentFailure('approval_invalid');
  if (!fixture) throw new AgentFailure('approval_invalid');
  const scenarioId = approval.scenarioInventory[0];
  const binding = fixtureApprovalBinding(fixture, scenarioId);
  if (
    !isDeepStrictEqual(binding, {
      fixtureManifestDigest: approval.fixtureManifestDigest,
      scenarioSetDigest: approval.scenarioSetDigest,
      scenarioInventory: approval.scenarioInventory,
    })
  )
    throw new AgentFailure('approval_mismatch');
  const plan = providerPlanSchema.parse(
    Object.fromEntries(
      Object.keys(providerPlanSchema.shape).map((key) => [key, Reflect.get(approval, key)]),
    ),
  );
  const state: GrantState = {
    invocationId,
    approvalId: approval.approvalId,
    issued,
    expires,
    verifiedPricing,
    monotonicStart: performance.now(),
    remainingLifetime: Math.max(0, expires - Date.now()),
    revoked: false,
    executionStarted: false,
    fixture,
    scenarioId,
    binding,
    budget: new ProviderBudget(plan),
    estimator: createLiveInputEstimator(plan.model),
  };
  checkFresh(state);
  if (issuedApprovals.has(approval.approvalId) || issuedApprovals.has(invocationId))
    throw new AgentFailure('approval_invalid');
  issuedApprovals.add(approval.approvalId);
  issuedApprovals.add(invocationId);
  const grant: LiveGrant = Object.freeze({ [grantBrand]: true as const });
  grants.set(grant, state);
  return grant;
}
/** Must run before credentials and before every native request. Environment flags cannot grant access. */
export function assertLiveGrant(
  grant: LiveGrant,
  invocationId: string,
  budget?: ProviderBudget,
): void {
  if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined)
    throw new AgentFailure('network_forbidden');
  const state = stateFor(grant);
  checkFresh(state);
  if (!isDeepStrictEqual(fixtureApprovalBinding(state.fixture, state.scenarioId), state.binding))
    throw new AgentFailure('approval_mismatch');
  if (state.invocationId !== invocationId || (budget !== undefined && state.budget !== budget))
    throw new AgentFailure('approval_mismatch');
}
export function approvedBudget(grant: LiveGrant, invocationId: string): ProviderBudget {
  assertLiveGrant(grant, invocationId);
  return stateFor(grant).budget;
}
export function revokeLiveGrant(grant: LiveGrant): void {
  const state = grants.get(grant);
  if (!state) throw new AgentFailure('approval_invalid');
  state.revoked = true;
}
export function prepareLiveRequest(
  grant: LiveGrant,
  invocationId: string,
  budget: ProviderBudget,
  reservation: object,
  body: string,
  turn?: LiveTurnAuthorization,
): LiveRequestPermit {
  assertLiveGrant(grant, invocationId, budget);
  prepareAuthorizedTurn(turn, grant, invocationId, body);
  if (Buffer.byteLength(body) > 131072) throw new AgentFailure('request_size_limit');
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new AgentFailure('provider_configuration');
  }
  // Only approval-owned fields are projected here; transport validates the full request schema.
  const fields = z
    .object({ model: z.literal(liveModel), max_output_tokens: z.number().int().min(16).max(512) })
    .safeParse(decoded);
  if (!fields.success || fields.data.max_output_tokens > budget.plan.maxOutputTokensPerCall)
    throw new AgentFailure('approval_mismatch');
  const estimate = stateFor(grant).estimator.estimate(body);
  if (estimate + budget.plan.inputOverheadTokens > budget.plan.maxInputTokensPerCall)
    throw new AgentFailure('provider_budget');
  budget.claimReservation(reservation, fields.data.max_output_tokens);
  const permit: LiveRequestPermit = Object.freeze({ [permitBrand]: true as const });
  permits.set(permit, { grant, invocationId, turn, digest: hash(body), used: false, reservation });
  return permit;
}
export function consumeLiveRequest(
  grant: LiveGrant,
  invocationId: string,
  permit: LiveRequestPermit | undefined,
  body: string,
): void {
  assertLiveGrant(grant, invocationId);
  const state = permit ? permits.get(permit) : undefined;
  if (
    !state ||
    state.used ||
    state.grant !== grant ||
    state.invocationId !== invocationId ||
    state.digest !== hash(body)
  )
    throw new AgentFailure('approval_invalid');
  stateFor(grant).budget.assertClaimedReservation(state.reservation);
  consumePreparedTurn(state.turn, grant, invocationId, body);
  state.used = true;
}

/** One signed approval owns exactly one scenario execution. */
export function claimLiveExecution(
  grant: LiveGrant,
  invocationId: string,
  fixture: SyntheticAgentFixture,
  scenarioId: AgentScenarioId,
): void {
  assertLiveGrant(grant, invocationId);
  const state = stateFor(grant);
  if (state.executionStarted || state.fixture !== fixture || state.scenarioId !== scenarioId)
    throw new AgentFailure('approval_mismatch');
  state.executionStarted = true;
}

/** Resolve cleanup ownership even when approval freshness or caller arguments fail. */
export function ownedLiveFixture(grant: LiveGrant): SyntheticAgentFixture {
  return stateFor(grant).fixture;
}
