import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolSchemas } from '../src/schemas.js';
import {
  actionSchema,
  aggregateAgentReports,
  failedAgentReport,
  readOnlyTools,
  runAgentScenario,
  type ModelRequest,
} from './agent-evaluation.js';
import { agentScenarios } from './agent-evaluation-scenarios.js';
import { McpToolGateway } from './agent-tool-gateway.js';
import { OpenAiProvider, responsesEndpoint, type OpenAiHttpTransport } from './openai-provider.js';
import {
  liveRunAuthorizationSchema,
  ProviderBudget,
  providerUsageSchema,
} from './provider-budget.js';
import { providerControlReport } from './provider-evaluation-report.js';

const id = '11111111-1111-4111-8111-111111111111';
const model = 'mock-model-2026-01-01';
const plan = {
  model,
  maxCalls: 3,
  maxInputTokensPerCall: 800,
  maxOutputTokensPerCall: 512,
  inputOverheadTokens: 256,
  maxTotalTokens: 4096,
  maxPlannedCostMicroUsd: 10000,
  pricing: {
    source: 'https://developers.openai.com/api/pricing',
    verifiedAt: '2026-10-29T00:00:00Z',
    inputMicroUsdPerMillion: 100,
    cacheWriteMicroUsdPerMillion: 200,
    outputMicroUsdPerMillion: 300,
  },
};
const estimator = { mode: 'mock' as const, model, estimate: () => 100 };
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 150,
};
const absent = {
  availability: 'unavailable',
  projectIds: [],
  evidenceIds: [],
  opportunityIds: [],
  overallScore: null,
  recommendation: null,
  riskCodes: [],
  concernCodes: [],
  errorCodes: ['NOT_FOUND'],
};
const call = {
  type: 'tool_call',
  name: 'get_project',
  argumentsJson: JSON.stringify({ projectId: id }),
};
const final = { type: 'final', claims: absent };
const scenarios = agentScenarios({
  projectId: id,
  evidenceId: id,
  opportunityId: id,
  riskOpportunityId: '22222222-2222-4222-8222-222222222222',
  missingProjectId: id,
  foreignProjectId: id,
});
const missing = scenarios.find((s) => s.id === 'unavailable_information')!;
const resources: { close: () => Promise<void> }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden provider network request.'));
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const resource of resources.splice(0)) await resource.close();
});
const request: ModelRequest = {
  responseSchema: z.toJSONSchema(actionSchema),
  tools: readOnlyTools.map((name) => ({
    name,
    description: 'Synthetic control',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  })),
  messages: [{ role: 'user', content: 'Retrieve the synthetic project.' }],
  remainingTokens: 4096,
  maxOutputTokens: 512,
};
function envelope(action: unknown = call) {
  return {
    id: 'resp_mock',
    object: 'response',
    created_at: 0,
    model,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: JSON.stringify({ action }), annotations: [], logprobs: [] },
        ],
      },
    ],
    usage,
  };
}
function response(body: unknown = envelope(), status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function control(responses: Response[] = [response()]) {
  const credential = vi.fn(() => randomUUID());
  const transport: OpenAiHttpTransport = {
    mode: 'mock',
    request: vi.fn(() => Promise.resolve(responses.shift() ?? response())),
    close: vi.fn(() => Promise.resolve()),
  };
  const budget = new ProviderBudget(plan);
  const adapter = new OpenAiProvider(transport, budget, credential, estimator);
  return { adapter, transport, budget, credential };
}
async function gateway() {
  const server = new McpServer({ name: 'mock-provider-controls', version: '1' });
  const unexpected = vi.fn(() => Promise.reject(new Error('Unexpected tool execution.')));
  const callback = vi.fn(() =>
    Promise.resolve({
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'The requested resource was not found.',
              requestId: id,
            },
          }),
        },
      ],
    }),
  );
  const annotations = { readOnlyHint: true };
  server.registerTool(
    'get_profile',
    {
      inputSchema: toolSchemas.get_profile.input,
      outputSchema: toolSchemas.get_profile.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'list_projects',
    {
      inputSchema: toolSchemas.list_projects.input,
      outputSchema: toolSchemas.list_projects.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'get_project',
    {
      inputSchema: toolSchemas.get_project.input,
      outputSchema: toolSchemas.get_project.output,
      annotations,
    },
    callback,
  );
  server.registerTool(
    'get_blockers',
    {
      inputSchema: toolSchemas.get_blockers.input,
      outputSchema: toolSchemas.get_blockers.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'search_project_evidence',
    {
      inputSchema: toolSchemas.search_project_evidence.input,
      outputSchema: toolSchemas.search_project_evidence.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'list_opportunities',
    {
      inputSchema: toolSchemas.list_opportunities.input,
      outputSchema: toolSchemas.list_opportunities.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'evaluate_opportunity',
    {
      inputSchema: toolSchemas.evaluate_opportunity.input,
      outputSchema: toolSchemas.evaluate_opportunity.output,
      annotations,
    },
    unexpected,
  );
  server.registerTool(
    'create_project_note',
    {
      inputSchema: toolSchemas.create_project_note.input,
      outputSchema: toolSchemas.create_project_note.output,
      annotations: { readOnlyHint: false },
    },
    unexpected,
  );
  const client = new Client({ name: 'provider-test-client', version: '1' }, { listMaxPages: 1 });
  resources.push(client, server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { gateway: new McpToolGateway(client), client, callback, unexpected };
}

describe('mock OpenAI Responses boundary', () => {
  it('normalizes an allowed selection and reports provider fields without claiming live usage', async () => {
    const c = control();
    const reply = await c.adapter.complete(request, new AbortController().signal);
    expect(actionSchema.parse(JSON.parse(reply.output))).toEqual({
      type: 'tool_call',
      name: 'get_project',
      arguments: { projectId: id },
    });
    expect(reply.usage).toEqual({ kind: 'provider_reported', inputTokens: 100, outputTokens: 50 });
    expect(c.budget.snapshot()).toMatchObject({ callsReserved: 1, usageStatus: 'known' });
    await c.adapter.close();
  });
  it('runs through the real SDK gateway and independent unavailable-information oracle', async () => {
    const g = await gateway();
    const c = control([response(envelope(call)), response(envelope(final))]);
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({
      status: 'passed',
      usage: { kind: 'provider_reported', inputTokens: 200, outputTokens: 100, complete: true },
      selectedTools: ['get_project'],
      dispatchedTools: ['get_project'],
      executedTools: ['get_project'],
    });
    expect(g.callback).toHaveBeenCalledOnce();
    expect(g.unexpected).not.toHaveBeenCalled();
    const offline = aggregateAgentReports([{ name: missing.id, state: 'passed', report: result }]);
    expect(offline.status).toBe('failed');
  });
  it('normalizes structured final claims but does not judge them', async () => {
    const g = await gateway();
    const c = control([
      response(envelope({ ...final, claims: { ...absent, availability: 'available' } })),
    ]);
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result.failure).toBe('incorrect_outcome');
    expect(g.callback).not.toHaveBeenCalled();
  });
  it.each([
    ['create_project_note', {}, 'write_tool_blocked'],
    ['unknown-private-tool', {}, 'unknown_tool'],
    ['get_project', { projectId: 'invalid' }, 'invalid_arguments'],
    ['get_project', { projectId: id, tenantId: id }, 'invalid_arguments'],
  ] as const)('rejects %s through the sole gateway path', async (name, args, failure) => {
    const g = await gateway();
    const dispatch = vi.spyOn(g.client, 'callTool');
    const c = control([
      response(envelope({ type: 'tool_call', name, argumentsJson: JSON.stringify(args) })),
    ]);
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({
      status: 'failed',
      failure,
      dispatchedTools: [],
      executedTools: [],
      refusedWithoutToolCall: false,
    });
    expect(result.selectedTools).toHaveLength(1);
    expect(result.rejectedTools).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(g.unexpected).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('unknown-private-tool');
  });
  it('preserves zero-call refusal and never mutates through the SDK', async () => {
    const g = await gateway();
    const c = control([
      response(
        envelope({ type: 'final', claims: { ...absent, availability: 'refused', errorCodes: [] } }),
      ),
    ]);
    const result = await runAgentScenario(
      scenarios.find((s) => s.id === 'mutation_refusal'),
      c.adapter,
      g.gateway,
    );
    expect(result).toMatchObject({
      status: 'passed',
      refusedWithoutToolCall: true,
      selectedTools: [],
      executedTools: [],
    });
    expect(g.unexpected).not.toHaveBeenCalled();
  });
  it('uses a fixed endpoint, compatible root schema and private header-only credential', async () => {
    const c = control();
    const key = randomUUID();
    c.credential.mockReturnValue(key);
    await c.adapter.complete(request, new AbortController().signal);
    const sent = vi.mocked(c.transport.request).mock.calls[0]?.[0];
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({
      url: responsesEndpoint,
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer ' + key },
    });
    const body = JSON.parse(sent!.body) as {
      tools: unknown[];
      text: {
        format: { schema: { type: string; additionalProperties: boolean; anyOf?: unknown } };
      };
    };
    expect(body).toMatchObject({
      store: false,
      stream: false,
      background: false,
      truncation: 'disabled',
      service_tier: 'default',
      tools: [],
    });
    expect(body.text.format.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(body.text.format.schema.anyOf).toBeUndefined();
    expect(sent!.body).not.toContain(key);
    expect(sent!.body).not.toContain('expectedClaims');
    expect(sent!.body).not.toContain('tenantId');
    await c.adapter.close();
  });
  it.each([401, 403, 429, 500, 503, 400])(
    'classifies HTTP %s safely without reading or retrying the error body',
    async (status) => {
      const g = await gateway();
      const c = control([response({ private: 'private-response-sentinel' }, status)]);
      const result = await runAgentScenario(missing, c.adapter, g.gateway);
      expect(result.failure).toBe(
        status === 401 || status === 403
          ? 'provider_authentication'
          : status === 429
            ? 'provider_rate_limited'
            : status >= 500
              ? 'provider_service_failure'
              : 'provider_invalid_response',
      );
      expect(result.usage.complete).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private-response-sentinel');
      expect(c.transport.request).toHaveBeenCalledOnce();
      expect(() => c.budget.reserve(100, 50)).toThrow('provider_budget');
    },
  );
  it.each([
    [
      'unexpected top-level field',
      { ...envelope(), extra: true },
      'provider_invalid_response',
      true,
    ],
    [
      'wrong model',
      { ...envelope(), model: 'other-model-2026-01-01' },
      'provider_invalid_response',
      true,
    ],
    [
      'incomplete response',
      { ...envelope(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      'provider_invalid_response',
      true,
    ],
    [
      'unexpected output type',
      { ...envelope(), output: [{ type: 'function_call', name: 'get_project', arguments: '{}' }] },
      'provider_invalid_response',
      true,
    ],
    [
      'refusal content',
      {
        ...envelope(),
        output: [
          {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'private-refusal-sentinel' }],
          },
        ],
      },
      'provider_invalid_response',
      true,
    ],
    ['missing output', { ...envelope(), output: [] }, 'provider_invalid_response', true],
    ['missing usage', { ...envelope(), usage: null }, 'provider_usage_unknown', false],
    [
      'negative usage',
      { ...envelope(), usage: { ...usage, input_tokens: -1 } },
      'provider_usage_unknown',
      false,
    ],
    [
      'fractional usage',
      { ...envelope(), usage: { ...usage, output_tokens: 1.5 } },
      'provider_usage_unknown',
      false,
    ],
    [
      'wrong total',
      { ...envelope(), usage: { ...usage, total_tokens: 1 } },
      'provider_usage_unknown',
      false,
    ],
    [
      'unknown usage field',
      { ...envelope(), usage: { ...usage, secret: true } },
      'provider_usage_unknown',
      false,
    ],
    [
      'unknown nested usage field',
      {
        ...envelope(),
        usage: { ...usage, input_tokens_details: { cached_tokens: 0, secret: true } },
      },
      'provider_usage_unknown',
      false,
    ],
    [
      'invalid argument JSON',
      envelope({ type: 'tool_call', name: 'get_project', argumentsJson: '{broken' }),
      'malformed_model_response',
      true,
    ],
    ['extra action field', envelope({ ...call, extra: true }), 'malformed_model_response', true],
  ] as const)(
    'rejects %s without leaking raw responses',
    async (_label, body, failure, complete) => {
      const g = await gateway();
      const c = control([response(body)]);
      const result = await runAgentScenario(missing, c.adapter, g.gateway);
      expect(result).toMatchObject({
        status: 'failed',
        failure,
        usage: { complete },
        dispatchedTools: [],
      });
      expect(c.transport.request).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain('private-refusal-sentinel');
    },
  );
  it('rejects invalid outer action JSON after retaining valid usage', async () => {
    const body = envelope();
    body.output[0]!.content[0]!.text = '{broken';
    const g = await gateway();
    const c = control([response(body)]);
    const report = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(report).toMatchObject({
      failure: 'malformed_model_response',
      usage: { inputTokens: 100, outputTokens: 50, complete: true },
      dispatchedTools: [],
    });
  });
  it('accounts valid usage before rejecting a malformed action', async () => {
    const g = await gateway();
    const c = control([response(envelope({ type: 'nonsense' }))]);
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({
      failure: 'malformed_model_response',
      usage: { kind: 'provider_reported', inputTokens: 100, outputTokens: 50, complete: true },
    });
  });
  it('rejects output token overruns while retaining actual reported counts', async () => {
    const g = await gateway();
    const c = control([
      response({ ...envelope(), usage: { ...usage, output_tokens: 513, total_tokens: 613 } }),
    ]);
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({
      failure: 'provider_budget',
      usage: { inputTokens: 100, outputTokens: 513, complete: true },
    });
    expect(result.dispatchedTools).toEqual([]);
  });
  it('retains aggregate known counters when the final call overruns the invocation', async () => {
    const g = await gateway();
    const c = control([
      response(envelope(call)),
      response(envelope(call)),
      response({
        ...envelope(final),
        usage: { ...usage, input_tokens: 999900, total_tokens: 999950 },
      }),
    ]);
    const report = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(report).toMatchObject({
      status: 'failed',
      failure: 'provider_budget',
      usage: { kind: 'provider_reported', inputTokens: 1000100, outputTokens: 150, complete: true },
    });
    expect(report.executedTools).toEqual(['get_project', 'get_project']);
  });
  it('reserves aggregate tokens and conservative cost before HTTP and never refunds', async () => {
    expect(() => new ProviderBudget({ ...plan, maxTotalTokens: 1 })).toThrow('provider_budget');
    expect(() => new ProviderBudget({ ...plan, maxPlannedCostMicroUsd: 1 })).toThrow(
      'provider_budget',
    );
    const c = control();
    await c.adapter.complete(request, new AbortController().signal);
    await c.adapter.complete(request, new AbortController().signal);
    await c.adapter.complete(request, new AbortController().signal);
    const snapshot = c.budget.snapshot();
    expect(snapshot.callsReserved).toBe(3);
    expect(snapshot.reservedTokens).toBe(3936);
    expect(snapshot.reservedCostMicroUsd).toBeGreaterThan(0);
    await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow(
      'provider_budget',
    );
    expect(c.transport.request).toHaveBeenCalledTimes(3);
    await c.adapter.close();
  });
  it('rejects an underestimated input allowance, low remaining tokens and malformed estimates before HTTP', async () => {
    const c = control();
    const excessive = new OpenAiProvider(c.transport, c.budget, c.credential, {
      ...estimator,
      estimate: () => 10000,
    });
    await expect(excessive.complete(request, new AbortController().signal)).rejects.toThrow(
      'provider_budget',
    );
    const invalid = new OpenAiProvider(c.transport, c.budget, c.credential, {
      ...estimator,
      estimate: () => NaN,
    });
    await expect(invalid.complete(request, new AbortController().signal)).rejects.toThrow(
      'provider_configuration',
    );
    await expect(
      c.adapter.complete({ ...request, remainingTokens: 100 }, new AbortController().signal),
    ).rejects.toThrow('provider_budget');
    expect(c.transport.request).not.toHaveBeenCalled();
    expect(c.credential).not.toHaveBeenCalled();
    await c.adapter.close();
  });
  it('fails safely on provider/network error and treats consumption as unknown', async () => {
    const g = await gateway();
    const c = control();
    vi.mocked(c.transport.request).mockRejectedValue(
      new Error('postgresql://private-provider-sentinel'),
    );
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({ failure: 'provider_failure', usage: { complete: false } });
    expect(JSON.stringify(result)).not.toContain('private-provider-sentinel');
    expect(c.budget.snapshot().usageStatus).toBe('unknown');
  });
  it('times out stalled HTTP, propagates abort and preserves unknown usage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const c = control();
    let signal: AbortSignal | undefined;
    vi.mocked(c.transport.request).mockImplementation((input) => {
      signal = input.signal;
      return new Promise(() => {});
    });
    const pending = c.adapter.complete(request, new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow('model_timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(c.adapter.usageSnapshot().complete).toBe(false);
    await c.adapter.close();
  });
  it('cancels a late HTTP response without recovering an unknown reservation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const c = control();
    let deliver: ((r: Response) => void) | undefined;
    vi.mocked(c.transport.request).mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const assertion = expect(
      c.adapter.complete(request, new AbortController().signal),
    ).rejects.toThrow('model_timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    const late = response();
    deliver?.(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.body?.locked).toBe(false);
    expect(c.budget.snapshot().usageStatus).toBe('unknown');
    await c.adapter.close();
  });
  it('bounds a stalled response body and cancels the reader', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cancel = vi.fn();
    const c = control([
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const pending = expect(
      c.adapter.complete(request, new AbortController().signal),
    ).rejects.toThrow('model_timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(c.adapter.usageSnapshot().complete).toBe(false);
    await c.adapter.close();
  });
  it('propagates caller cancellation without another request', async () => {
    const c = control();
    const abort = new AbortController();
    abort.abort();
    await expect(c.adapter.complete(request, abort.signal)).rejects.toThrow();
    expect(c.transport.request).not.toHaveBeenCalled();
    await c.adapter.close();
  });
  it.each([
    new Response('{truncated', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
    }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('private-interruption'));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  ])('fails closed on truncated, incompatible, oversized or interrupted HTTP', async (response) => {
    const c = control([response]);
    await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow();
    expect(c.adapter.usageSnapshot().complete).toBe(false);
    await c.adapter.close();
  });
  it('attempts gateway cleanup even when provider transport cleanup fails', async () => {
    const g = await gateway();
    const c = control([response(envelope(call)), response(envelope(final))]);
    vi.mocked(c.transport.close).mockRejectedValue(new Error('private-cleanup-sentinel'));
    const close = vi.spyOn(g.gateway, 'close');
    const result = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(result).toMatchObject({
      status: 'failed',
      failure: 'cleanup_failed',
      cleanup: 'failed',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private-cleanup-sentinel');
  });
  it('closes idempotently and rejects requests after cleanup', async () => {
    const c = control();
    await Promise.all([c.adapter.close(), c.adapter.close()]);
    expect(c.transport.close).toHaveBeenCalledOnce();
    await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow(
      'provider_failure',
    );
  });
  it('rejects network transports before credentials even with CI/live flags and a key present', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('ALLOW_LIVE_MODEL', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'not-a-real-key');
    const c = control();
    expect(
      () =>
        new OpenAiProvider({ ...c.transport, mode: 'network' }, c.budget, c.credential, estimator),
    ).toThrow('live_disabled');
    expect(c.credential).not.toHaveBeenCalled();
    expect(c.transport.request).not.toHaveBeenCalled();
  });
  it('rechecks transport identity and never accepts an alternate endpoint in configuration', async () => {
    const c = control();
    Object.defineProperty(c.transport, 'mode', { value: 'network' });
    await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow(
      'live_disabled',
    );
    expect(
      () =>
        new OpenAiProvider({ ...c.transport, mode: 'mock' }, c.budget, c.credential, estimator, {
          timeoutMs: 100,
          maxResponseBytes: 65536,
          baseURL: 'https://invalid.example',
        }),
    ).toThrow('provider_configuration');
    expect(c.transport.request).not.toHaveBeenCalled();
  });
  it('requires exact model, explicit owner authorization data and externally reviewed pricing', () => {
    expect(() => new ProviderBudget({ ...plan, model: 'latest' })).toThrow(
      'provider_configuration',
    );
    expect(
      liveRunAuthorizationSchema.safeParse({
        ...plan,
        invocationId: randomUUID(),
        syntheticDataOnly: true,
        explicitlyApprovedByOwner: true,
      }).success,
    ).toBe(true);
    expect(
      liveRunAuthorizationSchema.safeParse({
        ...plan,
        invocationId: randomUUID(),
        syntheticDataOnly: true,
      }).success,
    ).toBe(false);
    expect(
      () =>
        new ProviderBudget({
          ...plan,
          pricing: { ...plan.pricing, source: 'https://invalid.example' },
        }),
    ).toThrow('provider_configuration');
    expect(
      providerUsageSchema.safeParse({ ...usage, input_tokens_details: { cached_tokens: 101 } })
        .success,
    ).toBe(false);
  });
  it('retains late known counters while marking usage incomplete and halting the ledger', async () => {
    const c = control();
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(6000);
    await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow(
      'model_timeout',
    );
    expect(c.adapter.usageSnapshot()).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      complete: false,
    });
    expect(c.budget.snapshot().usageStatus).toBe('unknown');
    clock.mockRestore();
    await c.adapter.close();
  });
  it('contains failed usage-snapshot handling and still closes both resources', async () => {
    const g = await gateway();
    const c = control([response(envelope(call)), response(envelope(final))]);
    vi.spyOn(c.adapter, 'usageSnapshot').mockImplementation(() => {
      throw new Error('private-snapshot-sentinel');
    });
    const closed = vi.spyOn(g.gateway, 'close');
    const report = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(report).toMatchObject({
      status: 'failed',
      failure: 'provider_usage_unknown',
      usage: { complete: false },
    });
    expect(closed).toHaveBeenCalledOnce();
    expect(c.transport.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain('private-snapshot-sentinel');
  });
  it('bounds stalled provider cleanup and propagates its abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const c = control();
    let signal: AbortSignal | undefined;
    vi.mocked(c.transport.close).mockImplementation((s) => {
      signal = s;
      return new Promise(() => {});
    });
    const assertion = expect(c.adapter.close()).rejects.toThrow('cleanup_failed');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it('rejects oversized requests and reports an actual input overrun without dispatch', async () => {
    const c = control();
    await expect(
      c.adapter.complete(
        {
          ...request,
          tools: request.tools.map((t) => ({ ...t, description: 'x'.repeat(200000) })),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('provider_configuration');
    expect(c.transport.request).not.toHaveBeenCalled();
    const g = await gateway();
    const d = control([
      response({ ...envelope(), usage: { ...usage, input_tokens: 801, total_tokens: 851 } }),
    ]);
    const report = await runAgentScenario(missing, d.adapter, g.gateway);
    expect(report).toMatchObject({
      status: 'failed',
      failure: 'provider_budget',
      usage: { inputTokens: 801, outputTokens: 50, complete: true },
      dispatchedTools: [],
    });
    await c.adapter.close();
  });
  it('reports only safe control counts and fails missing, skipped or unsuccessful controls', () => {
    const passed = providerControlReport(['passed'], false);
    expect(passed).toMatchObject({
      status: 'passed',
      kind: 'mock_openai_provider_contract_validation',
      usageProvenance: 'mock_http_fields',
    });
    expect(providerControlReport([], false).status).toBe('failed');
    expect(providerControlReport(['skipped'], false).status).toBe('failed');
    expect(providerControlReport(['failed'], false).status).toBe('failed');
    expect(providerControlReport(['passed'], true).status).toBe('failed');
    expect(JSON.stringify(providerControlReport(['private-error-sentinel'], true))).not.toContain(
      'private-error-sentinel',
    );
    const report = failedAgentReport('unavailable_information', 'provider_usage_unknown');
    report.usage.kind = 'provider_reported';
    report.usage.complete = false;
    expect(JSON.stringify(report)).not.toContain('postgresql://');
  });
});
