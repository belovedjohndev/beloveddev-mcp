import { z } from 'zod';
import { AgentFailure } from './agent-evaluation.js';

const count = z.number().int().nonnegative().max(1_000_000);
const positive = z.number().int().min(1).max(1_000_000);
export const exactModelSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,90}-\d{4}-\d{2}-\d{2}$/);
const pricingSchema = z.strictObject({
  source: z.enum([
    'https://developers.openai.com/api/pricing',
    'https://developers.openai.com/api/docs/pricing',
    'https://openai.com/api/pricing/',
  ]),
  verifiedAt: z.iso.datetime(),
  inputMicroUsdPerMillion: z.number().int().min(1).max(1_000_000_000),
  cacheWriteMicroUsdPerMillion: z.number().int().min(1).max(1_000_000_000),
  outputMicroUsdPerMillion: z.number().int().min(1).max(1_000_000_000),
});
export const providerPlanSchema = z.strictObject({
  model: exactModelSchema,
  maxCalls: z.number().int().min(1).max(36),
  maxInputTokensPerCall: positive,
  maxOutputTokensPerCall: z.number().int().min(1).max(512),
  inputOverheadTokens: z.number().int().min(256).max(16384),
  maxTotalTokens: positive,
  maxPlannedCostMicroUsd: positive,
  pricing: pricingSchema,
});
/** Approval data for future review, not an executable network permission in C2A. */
export const liveRunAuthorizationSchema = providerPlanSchema
  .extend({
    invocationId: z.uuid(),
    syntheticDataOnly: z.literal(true),
    explicitlyApprovedByOwner: z.literal(true),
  })
  .strict();
export type ProviderPlan = z.infer<typeof providerPlanSchema>;
export const providerUsageSchema = z
  .strictObject({
    input_tokens: count,
    input_tokens_details: z.strictObject({
      cached_tokens: count,
      cache_write_tokens: count.optional(),
    }),
    output_tokens: count,
    output_tokens_details: z.strictObject({ reasoning_tokens: count }),
    total_tokens: count,
  })
  .superRefine((usage, context) => {
    if (
      usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
      usage.input_tokens_details.cached_tokens +
        (usage.input_tokens_details.cache_write_tokens ?? 0) >
        usage.input_tokens ||
      usage.output_tokens_details.reasoning_tokens > usage.output_tokens
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent provider usage.' });
  });
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
const ceilingCost = (tokens: number, rate: number) =>
  Number((BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n);
const cost = (plan: ProviderPlan, input: number, output: number) =>
  ceilingCost(
    input,
    Math.max(plan.pricing.inputMicroUsdPerMillion, plan.pricing.cacheWriteMicroUsdPerMillion),
  ) + ceilingCost(output, plan.pricing.outputMicroUsdPerMillion);

/** Invocation-owned conservative ledger. Reservations are never recycled. */
export class ProviderBudget {
  readonly plan: Readonly<ProviderPlan>;
  private readonly reservations = new WeakMap<
    object,
    { active: boolean; claimed: boolean; outputTokens: number }
  >();
  private calls = 0;
  private reservedTokens = 0;
  private reservedCostMicroUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private complete = true;
  private halted = false;
  constructor(input: unknown) {
    const result = providerPlanSchema.safeParse(input);
    if (!result.success) throw new AgentFailure('provider_configuration');
    this.plan = Object.freeze({ ...result.data, pricing: Object.freeze(result.data.pricing) });
    const tokens = this.plan.maxInputTokensPerCall + this.plan.maxOutputTokensPerCall;
    if (
      this.plan.maxCalls * tokens > this.plan.maxTotalTokens ||
      this.plan.maxCalls *
        cost(this.plan, this.plan.maxInputTokensPerCall, this.plan.maxOutputTokensPerCall) >
        this.plan.maxPlannedCostMicroUsd
    )
      throw new AgentFailure('provider_budget');
  }
  reserve(estimatedInputTokens: number, outputTokens: number) {
    const plan = this.plan;
    const tokens = plan.maxInputTokensPerCall + outputTokens;
    const amount = cost(plan, plan.maxInputTokensPerCall, outputTokens);
    if (
      this.halted ||
      !Number.isSafeInteger(estimatedInputTokens) ||
      estimatedInputTokens < 0 ||
      estimatedInputTokens + plan.inputOverheadTokens > plan.maxInputTokensPerCall ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 1 ||
      outputTokens > plan.maxOutputTokensPerCall ||
      this.calls >= plan.maxCalls ||
      this.reservedTokens + tokens > plan.maxTotalTokens ||
      this.reservedCostMicroUsd + amount > plan.maxPlannedCostMicroUsd
    )
      throw new AgentFailure('provider_budget');
    this.calls++;
    this.reservedTokens += tokens;
    this.reservedCostMicroUsd += amount;
    let settled = false;
    const state = { active: true, claimed: false, outputTokens };
    const reservation = Object.freeze({
      settle: (usage: ProviderUsage) => {
        if (settled) throw new AgentFailure('provider_budget');
        settled = true;
        state.active = false;
        this.inputTokens += usage.input_tokens;
        this.outputTokens += usage.output_tokens;
        if (
          usage.input_tokens > plan.maxInputTokensPerCall ||
          usage.output_tokens > outputTokens ||
          this.inputTokens + this.outputTokens > plan.maxTotalTokens
        ) {
          this.halted = true;
          throw new AgentFailure('provider_budget');
        }
      },
      unknown: () => {
        if (!settled) {
          settled = true;
          state.active = false;
          this.complete = false;
          this.halted = true;
        }
      },
    });
    this.reservations.set(reservation, state);
    return reservation;
  }
  claimReservation(reservation: object, outputTokens: number) {
    const state = this.reservations.get(reservation);
    if (
      !state ||
      !state.active ||
      state.claimed ||
      state.outputTokens !== outputTokens ||
      this.halted
    )
      throw new AgentFailure('provider_budget');
    state.claimed = true;
  }
  assertClaimedReservation(reservation: object) {
    const state = this.reservations.get(reservation);
    if (!state || !state.active || !state.claimed || this.halted)
      throw new AgentFailure('provider_budget');
  }
  markUnknown() {
    this.complete = false;
    this.halted = true;
  }
  snapshot() {
    return {
      callsReserved: this.calls,
      reservedTokens: this.reservedTokens,
      reservedCostMicroUsd: this.reservedCostMicroUsd,
      knownInputTokens: this.inputTokens,
      knownOutputTokens: this.outputTokens,
      usageStatus: this.complete ? ('known' as const) : ('unknown' as const),
    };
  }
}
