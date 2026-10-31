import { z } from 'zod';
import {
  actionSchema,
  AgentFailure,
  bounded,
  readOnlyTools,
  type ModelAdapter,
  type ModelRequest,
  type LiveTurnAuthorization,
  claimProviderTurn,
} from './agent-evaluation.js';
import { providerUsageSchema, type ProviderBudget } from './provider-budget.js';

import {
  jsonObject,
  serializeProviderRequest,
  wireActionSchema,
  formatSchema,
  responsesEndpoint,
} from './provider-wire-contract.js';
export { responsesEndpoint } from './provider-wire-contract.js';
import {
  assertLiveGrant,
  prepareLiveRequest,
  type LiveGrant,
  type LiveRequestPermit,
} from './provider-live-approval.js';
import { assertLiveInputEstimator, type LiveInputEstimator } from './provider-input-estimator.js';
import { assertNetworkTransport } from './openai-network-transport.js';

const modelRequestSchema = z.strictObject({
  responseSchema: jsonObject,
  tools: z
    .array(
      z.strictObject({
        name: z.enum(readOnlyTools),
        description: z.string(),
        inputSchema: jsonObject,
        outputSchema: jsonObject,
      }),
    )
    .length(7),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant', 'tool']),
        content: z.string().max(32768),
      }),
    )
    .min(1)
    .max(13),
  remainingTokens: z.number().int().min(1).max(4096),
  maxOutputTokens: z.number().int().min(1).max(512),
});
const responseSchema = z.strictObject({
  id: z.string().regex(/^resp_[a-zA-Z0-9_-]+$/),
  object: z.literal('response'),
  created_at: z.number().nonnegative(),
  model: z.string(),
  status: z.literal('completed'),
  error: z.null(),
  incomplete_details: z.null(),
  usage: providerUsageSchema,
  output: z
    .array(
      z.strictObject({
        id: z.string().regex(/^msg_[a-zA-Z0-9_-]+$/),
        type: z.literal('message'),
        role: z.literal('assistant'),
        status: z.literal('completed'),
        content: z
          .array(
            z.strictObject({
              type: z.literal('output_text'),
              text: z.string().max(8192),
              annotations: z.array(z.never()).length(0),
              logprobs: z.array(z.never()).length(0).optional(),
            }),
          )
          .length(1),
      }),
    )
    .length(1),
  completed_at: z.number().nonnegative().nullable().optional(),
  access_programs: z.null().optional(),
  background: z.literal(false).optional(),
  instructions: z.string().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  max_tool_calls: z.null().optional(),
  parallel_tool_calls: z.boolean().optional(),
  previous_response_id: z.null().optional(),
  reasoning: z.strictObject({ effort: z.null(), summary: z.null() }).nullable().optional(),
  store: z.literal(false).optional(),
  temperature: z.number().min(0).max(2).optional(),
  text: z
    .strictObject({ format: formatSchema, verbosity: z.enum(['low', 'medium', 'high']).optional() })
    .optional(),
  tool_choice: z.enum(['auto', 'none']).optional(),
  tools: z.array(z.never()).length(0).optional(),
  top_p: z.number().min(0).max(1).optional(),
  truncation: z.literal('disabled').optional(),
  user: z.null().optional(),
  metadata: z.strictObject({}).optional(),
  service_tier: z.literal('default').nullable().optional(),
  safety_identifier: z.null().optional(),
  prompt_cache_key: z.null().optional(),
});

export interface OpenAiHttpTransport {
  readonly mode: 'mock' | 'network';
  request(
    this: void,
    input: {
      readonly url: typeof responsesEndpoint;
      readonly method: 'POST';
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly redirect: 'error';
      readonly signal: AbortSignal;
      readonly permit?: LiveRequestPermit;
    },
  ): Promise<Response>;
  close(this: void, signal: AbortSignal): Promise<void>;
}
export interface MockInputEstimator {
  readonly mode: 'mock';
  readonly model: string;
  estimate(serializedRequest: string): number;
}
const configSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).max(5000),
  maxResponseBytes: z.number().int().min(1).max(65536),
});

/** Mock path remains default; the network path requires trusted invocation approval. */
export class OpenAiProvider implements ModelAdapter {
  readonly mode: 'provider_mock' | 'live';
  private readonly config: z.infer<typeof configSchema>;
  private closing: Promise<void> | undefined;
  private active: AbortController | undefined;
  private failed = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private completeUsage = true;
  constructor(
    private readonly transport: OpenAiHttpTransport,
    private readonly budget: ProviderBudget,
    private readonly credential: () => string,
    private readonly estimator: MockInputEstimator | LiveInputEstimator,
    config: unknown = { timeoutMs: 5000, maxResponseBytes: 65536 },
    private readonly live?: { grant: LiveGrant; invocationId: string },
  ) {
    this.mode = transport.mode === 'mock' ? 'provider_mock' : 'live';
    if (this.mode === 'live') {
      if (!live) throw new AgentFailure('live_disabled');
      assertLiveGrant(live.grant, live.invocationId, budget);
      assertNetworkTransport(transport, live.grant, live.invocationId);
      assertLiveInputEstimator(estimator, budget.plan.model);
    } else if (live || estimator.mode !== 'mock' || estimator.model !== budget.plan.model)
      throw new AgentFailure('provider_configuration');
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new AgentFailure('provider_configuration');
    this.config = parsed.data;
  }
  usageSnapshot() {
    return {
      kind: 'provider_reported' as const,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      complete: this.completeUsage,
    };
  }
  async complete(request: ModelRequest, signal: AbortSignal, turn?: LiveTurnAuthorization) {
    // Recheck mode: environment changes or mutable transport objects cannot enable networking.
    if (this.mode === 'live') {
      if (!this.live || this.transport.mode !== 'network') throw new AgentFailure('live_disabled');
      assertLiveGrant(this.live.grant, this.live.invocationId, this.budget);
      assertNetworkTransport(this.transport, this.live.grant, this.live.invocationId);
      assertLiveInputEstimator(this.estimator, this.budget.plan.model);
      claimProviderTurn(
        turn,
        this.live.grant,
        this.live.invocationId,
        this,
        this.budget.plan.model,
        request,
      );
    } else if (this.transport.mode !== 'mock') throw new AgentFailure('live_disabled');
    if (this.closing || this.active || this.failed) throw new AgentFailure('provider_failure');
    const parsed = modelRequestSchema.safeParse(request);
    if (!parsed.success || new Set(parsed.data.tools.map((t) => t.name)).size !== 7)
      throw new AgentFailure('provider_configuration');
    const input = parsed.data;
    const outputCap = Math.min(
      input.maxOutputTokens,
      this.budget.plan.maxOutputTokensPerCall,
      input.remainingTokens - this.budget.plan.maxInputTokensPerCall,
    );
    if (outputCap < (this.mode === 'live' ? 16 : 1)) throw new AgentFailure('provider_budget');
    const body = serializeProviderRequest(this.budget.plan.model, input, outputCap);
    if (Buffer.byteLength(body) > 131072) throw new AgentFailure('request_size_limit');
    let estimatedInputTokens: number;
    try {
      estimatedInputTokens = this.estimator.estimate(body);
    } catch {
      throw new AgentFailure('provider_configuration');
    }
    if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0)
      throw new AgentFailure('provider_configuration');
    if (
      estimatedInputTokens + this.budget.plan.inputOverheadTokens + outputCap >
      input.remainingTokens
    )
      throw new AgentFailure('provider_budget');
    const reservation = this.budget.reserve(estimatedInputTokens, outputCap);
    let known = false;
    this.active = new AbortController();
    const onAbort = () => this.active?.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) this.active.abort();
    try {
      return await bounded(
        async (s) => {
          if (s.aborted) throw new AgentFailure('model_timeout');
          const permit = this.live
            ? prepareLiveRequest(
                this.live.grant,
                this.live.invocationId,
                this.budget,
                reservation,
                body,
                turn,
              )
            : undefined;
          let key: string;
          try {
            key = this.credential();
          } catch {
            throw new AgentFailure('provider_configuration');
          }
          if (typeof key !== 'string' || !key || key.length > 4096 || /[\r\n]/.test(key))
            throw new AgentFailure('provider_configuration');
          const response = await this.transport
            .request({
              url: responsesEndpoint,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                authorization: 'Bearer ' + key,
              },
              body,
              redirect: 'error',
              signal: s,
              ...(permit ? { permit } : {}),
            })
            .then(async (response) => {
              if (s.aborted) {
                await response.body?.cancel().catch(() => {});
                throw new AgentFailure('model_timeout');
              }
              return response;
            });
          if (response.redirected || (response.url !== '' && response.url !== responsesEndpoint)) {
            await response.body?.cancel();
            throw new AgentFailure('provider_invalid_response');
          }
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 401 || response.status === 403)
              throw new AgentFailure('provider_authentication');
            if (response.status === 429) throw new AgentFailure('provider_rate_limited');
            if (response.status >= 500) throw new AgentFailure('provider_service_failure');
            throw new AgentFailure('provider_invalid_response');
          }
          if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
            await response.body?.cancel();
            throw new AgentFailure('provider_invalid_response');
          }
          const raw = await this.readResponse(response, s);
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw);
          } catch {
            throw new AgentFailure('provider_invalid_response');
          }
          const usage = providerUsageSchema.safeParse(
            typeof decoded === 'object' && decoded !== null
              ? Reflect.get(decoded, 'usage')
              : undefined,
          );
          if (!usage.success) throw new AgentFailure('provider_usage_unknown');
          known = true;
          this.inputTokens += usage.data.input_tokens;
          this.outputTokens += usage.data.output_tokens;
          reservation.settle(usage.data);
          if (usage.data.total_tokens > input.remainingTokens)
            throw new AgentFailure('provider_budget');
          const envelope = responseSchema.safeParse(decoded);
          if (
            !envelope.success ||
            envelope.data.model !== this.budget.plan.model ||
            (envelope.data.max_output_tokens != null &&
              envelope.data.max_output_tokens !== outputCap)
          )
            throw new AgentFailure('provider_invalid_response');
          const text = envelope.data.output[0]?.content[0]?.text;
          if (text === undefined || Buffer.byteLength(text) > 8192)
            throw new AgentFailure('provider_invalid_response');
          let action: z.infer<typeof actionSchema>;
          try {
            const wire = wireActionSchema.parse(JSON.parse(text)).action;
            action = actionSchema.parse(
              wire.type === 'tool_call'
                ? {
                    type: wire.type,
                    name: wire.name,
                    arguments: JSON.parse(wire.argumentsJson) as unknown,
                  }
                : wire,
            );
          } catch {
            throw new AgentFailure('malformed_model_response');
          }
          return {
            output: JSON.stringify(action),
            usage: {
              kind: 'provider_reported' as const,
              inputTokens: usage.data.input_tokens,
              outputTokens: usage.data.output_tokens,
            },
          };
        },
        this.config.timeoutMs,
        'model_timeout',
        this.active.signal,
      );
    } catch (error: unknown) {
      this.failed = true;
      if (
        error instanceof AgentFailure &&
        (error.code === 'model_timeout' || error.code === 'execution_timeout')
      ) {
        this.completeUsage = false;
        this.budget.markUnknown();
      }
      if (!known) {
        this.completeUsage = false;
        reservation.unknown();
      }
      throw error instanceof AgentFailure ? error : new AgentFailure('provider_failure');
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.active = undefined;
    }
  }
  private async readResponse(response: Response, signal: AbortSignal) {
    const length = response.headers.get('content-length');
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > this.config.maxResponseBytes)
    ) {
      await response.body?.cancel();
      throw new AgentFailure('provider_response_limit');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AgentFailure('provider_invalid_response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw new AgentFailure('model_timeout');
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        const checked = z.instanceof(Uint8Array).safeParse(value);
        if (!checked.success) throw new AgentFailure('provider_invalid_response');
        bytes += checked.data.byteLength;
        if (bytes > this.config.maxResponseBytes) throw new AgentFailure('provider_response_limit');
        chunks.push(checked.data);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      signal.removeEventListener('abort', abort);
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  close() {
    this.active?.abort();
    this.closing ??= bounded((s) => this.transport.close(s), 5000, 'cleanup_failed').catch(() => {
      throw new AgentFailure('cleanup_failed');
    });
    return this.closing;
  }
}
