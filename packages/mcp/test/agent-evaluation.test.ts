import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolSchemas } from '../src/schemas.js';
import { agentScenarios } from './agent-evaluation-scenarios.js';
import { McpToolGateway } from './agent-tool-gateway.js';
import {
  aggregateAgentReports,
  bounded,
  defaultAgentLimits,
  failedAgentReport,
  offlineModel,
  runAgentScenario,
  scenarioIds,
  validateAgentScenarios,
  type ModelAdapter,
} from './agent-evaluation.js';

const id = '11111111-1111-4111-8111-111111111111';
const fixtureIds = {
  projectId: id,
  evidenceId: id,
  opportunityId: id,
  riskOpportunityId: '22222222-2222-4222-8222-222222222222',
  missingProjectId: id,
  foreignProjectId: id,
};
const definitions = agentScenarios(fixtureIds);
const missing = definitions.find((scenario) => scenario.id === 'unavailable_information')!;
// Independent offline response literals, not copied from scenario.expectedClaims.
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
const call = { type: 'tool_call', name: 'get_project', arguments: { projectId: id } };
const final = { type: 'final', claims: absent };
const resources: { close: () => Promise<void> }[] = [];
async function clocked<T>(start: () => Promise<T>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const pending = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const resource of resources.splice(0)) await resource.close();
});

async function gateway() {
  const server = new McpServer({ name: 'offline-gateway-control', version: '1' });
  const unexpected = () => Promise.reject(new Error('Unexpected control tool.'));
  const annotations = { readOnlyHint: true };
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
    () =>
      Promise.resolve({
        content: [
          { type: 'text', text: JSON.stringify({ opportunities: [], meta: { requestId: id } }) },
        ],
        structuredContent: { opportunities: [], meta: { requestId: id } },
      }),
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
  const client = new Client({ name: 'offline-unit-control', version: '1' }, { listMaxPages: 1 });
  resources.push(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { gateway: new McpToolGateway(client), client, server, callback };
}

describe('offline agent boundary', () => {
  it('dispatches a selected allowed read through the SDK and handles the safe error', async () => {
    const g = await gateway();
    const report = await runAgentScenario(missing, offlineModel([call, final]), g.gateway);
    expect(report.status).toBe('passed');
    expect(report.selectedTools).toEqual(['get_project']);
    expect(report.rejectedTools).toEqual([]);
    expect(report.dispatchedTools).toEqual(['get_project']);
    expect(report.executedTools).toEqual(['get_project']);
    expect(g.callback).toHaveBeenCalledOnce();
  });
  it('validates a successful structured MCP response', async () => {
    const g = await gateway();
    const claims = { ...absent, availability: 'available', errorCodes: [] };
    const scenario = { ...definitions[1], expectedClaims: claims };
    const report = await runAgentScenario(
      scenario,
      offlineModel([
        { type: 'tool_call', name: 'list_opportunities', arguments: {} },
        { type: 'final', claims },
      ]),
      g.gateway,
    );
    expect(report.status).toBe('passed');
    expect(report.executedTools).toEqual(['list_opportunities']);
  });
  it.each([
    ['write_tool_blocked', 'create_project_note', {}],
    ['unknown_tool', 'private-key-sentinel', {}],
    ['invalid_arguments', 'get_project', { projectId: 'invalid' }],
    ['invalid_arguments', 'get_project', { projectId: id, tenantId: id }],
  ] as const)('rejects %s before MCP dispatch', async (failure, name, args) => {
    const g = await gateway();
    const dispatch = vi.spyOn(g.client, 'callTool');
    const report = await runAgentScenario(
      missing,
      offlineModel([{ type: 'tool_call', name, arguments: args }]),
      g.gateway,
    );
    expect(report.failure).toBe(failure);
    expect(report.rejectedTools).toHaveLength(1);
    expect(report.executedTools).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(g.callback).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('private-key-sentinel');
  });
  it('does not count a blocked write as independent refusal', async () => {
    const g = await gateway();
    const report = await runAgentScenario(
      definitions[5],
      offlineModel([
        { type: 'tool_call', name: 'create_project_note', arguments: {} },
        { type: 'final', claims: { ...absent, availability: 'refused', errorCodes: [] } },
      ]),
      g.gateway,
    );
    expect(report.status).toBe('failed');
    expect(report.selectedTools).toEqual(['create_project_note']);
    expect(report.refusedWithoutToolCall).toBe(false);
    expect(report.turns).toBe(1);
  });
  it('accepts an offline simulated refusal without selecting a tool', async () => {
    const g = await gateway();
    const report = await runAgentScenario(
      definitions[5],
      offlineModel([
        { type: 'final', claims: { ...absent, availability: 'refused', errorCodes: [] } },
      ]),
      g.gateway,
    );
    expect(report.status).toBe('passed');
    expect(report.refusedWithoutToolCall).toBe(true);
    expect(report.selectedTools).toEqual([]);
  });
  it('does not expose oracles, environment or write descriptors to the adapter', async () => {
    const g = await gateway();
    const model = offlineModel([call, final]);
    const original = model.complete.bind(model);
    vi.stubEnv('M9_C1_PRIVATE_SETTING', 'private-setting-sentinel');
    model.complete = vi.fn<ModelAdapter['complete']>((request, signal) => {
      expect(Object.keys(request).sort()).toEqual([
        'maxOutputTokens',
        'messages',
        'remainingTokens',
        'responseSchema',
        'tools',
      ]);
      expect(request.tools.map((tool) => tool.name)).not.toContain('create_project_note');
      expect(JSON.stringify(request)).not.toMatch(
        /expectedClaims|RequestContext|private-setting-sentinel|TEST_DATABASE_URL/,
      );
      return original(request, signal);
    });
    expect((await runAgentScenario(missing, model, g.gateway)).status).toBe('passed');
  });
  it('rejects live adapters even when a CI environment requests live execution', async () => {
    const g = await gateway();
    vi.stubEnv('CI', 'true');
    vi.stubEnv('ALLOW_LIVE_MODEL', 'true');
    const complete = vi.fn<ModelAdapter['complete']>();
    const close = vi.fn(() => Promise.resolve());
    const report = await runAgentScenario(missing, { mode: 'live', complete, close }, g.gateway);
    expect(report.failure).toBe('live_disabled');
    expect(complete).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([
    ['tool_call_limit', { maxToolCalls: 1 }, [call, call]],
    ['turn_limit', { maxTurns: 1 }, [call]],
    ['token_budget', { maxTokens: 63 }, [call]],
    ['model_response_limit', { maxModelResponseBytes: 1 }, [call]],
    ['request_size_limit', { maxRequestBytes: 1 }, [call]],
    ['tool_response_limit', { maxToolResponseBytes: 1 }, [call]],
  ] as const)('enforces %s', async (failure, limits, actions) => {
    const g = await gateway();
    const report = await runAgentScenario(missing, offlineModel(actions), g.gateway, {
      ...defaultAgentLimits,
      ...limits,
    });
    expect(report.failure).toBe(failure);
    expect(report.status).toBe('failed');
  });
  it.each(['model_timeout', 'execution_timeout'] as const)(
    'bounds %s and marks usage incomplete',
    async (failure) => {
      const g = await gateway();
      const tools = await g.gateway.discover(new AbortController().signal);
      vi.spyOn(g.gateway, 'discover').mockResolvedValue(tools);
      const model = offlineModel([]);
      let signal: AbortSignal | undefined;
      model.complete = (_request, s) => {
        signal = s;
        return new Promise(() => {});
      };
      const limits =
        failure === 'model_timeout' ? { modelTimeoutMs: 10 } : { executionTimeoutMs: 10 };
      const report = await clocked(() =>
        runAgentScenario(missing, model, g.gateway, { ...defaultAgentLimits, ...limits }),
      );
      expect(report.failure).toBe(failure);
      expect(report.usage.complete).toBe(false);
      expect(signal?.aborted).toBe(true);
    },
  );
  it('bounds an unavailable tool response', async () => {
    const g = await gateway();
    const tools = await g.gateway.discover(new AbortController().signal);
    vi.spyOn(g.gateway, 'discover').mockResolvedValue(tools);
    vi.spyOn(g.client, 'callTool').mockImplementation(() => new Promise(() => {}));
    const report = await clocked(() =>
      runAgentScenario(missing, offlineModel([call]), g.gateway, {
        ...defaultAgentLimits,
        toolTimeoutMs: 10,
      }),
    );
    expect(report.failure).toBe('tool_timeout');
    expect(report.dispatchedTools).toEqual(['get_project']);
    expect(report.executedTools).toEqual([]);
  });
  it('bounds stalled discovery without calling the adapter', async () => {
    const g = await gateway();
    vi.spyOn(g.gateway, 'discover').mockImplementation(() => new Promise(() => {}));
    const model = offlineModel([]);
    const complete = vi.spyOn(model, 'complete');
    const report = await clocked(() =>
      runAgentScenario(missing, model, g.gateway, { ...defaultAgentLimits, toolTimeoutMs: 10 }),
    );
    expect(report.failure).toBe('tool_timeout');
    expect(report.turns).toBe(0);
    expect(report.usage.complete).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });
  it('fails safely on provider failure with unknown usage', async () => {
    const g = await gateway();
    const model = offlineModel([]);
    model.complete = () => Promise.reject(new Error('postgresql://private-secret'));
    const report = await runAgentScenario(missing, model, g.gateway);
    expect(report.failure).toBe('provider_failure');
    expect(report.usage.complete).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private-secret');
  });
  it('fails on an unavailable MCP service', async () => {
    const g = await gateway();
    vi.spyOn(g.client, 'callTool').mockRejectedValue(new Error('private-service-secret'));
    const report = await runAgentScenario(missing, offlineModel([call]), g.gateway);
    expect(report.failure).toBe('service_unavailable');
    expect(report.executedTools).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('private-service-secret');
  });
  it.each([
    { type: 'final' },
    { type: 'final', claims: { ...absent, unsupportedFact: 'invented' } },
  ])('rejects malformed/incomplete model actions', async (action) => {
    const g = await gateway();
    expect((await runAgentScenario(missing, offlineModel([action]), g.gateway)).failure).toBe(
      'malformed_model_response',
    );
  });
  it('rejects missing usage instead of assuming zero consumption', async () => {
    const g = await gateway();
    const model = offlineModel([]);
    model.complete = () =>
      Promise.resolve({ output: JSON.stringify(final) } as Awaited<
        ReturnType<ModelAdapter['complete']>
      >);
    const report = await runAgentScenario(missing, model, g.gateway);
    expect(report.failure).toBe('malformed_model_response');
    expect(report.usage.complete).toBe(false);
  });
  it('rejects false structured claims after the required tool executes', async () => {
    const g = await gateway();
    const report = await runAgentScenario(
      missing,
      offlineModel([call, { type: 'final', claims: { ...absent, overallScore: 99 } }]),
      g.gateway,
    );
    expect(report.failure).toBe('incorrect_outcome');
    expect(report.executedTools).toEqual(['get_project']);
  });
  it('rejects guessed fixture facts unsupported by a completed tool result', async () => {
    const g = await gateway();
    const claims = {
      ...absent,
      availability: 'available',
      errorCodes: [],
      opportunityIds: [fixtureIds.opportunityId, fixtureIds.riskOpportunityId],
    };
    const report = await runAgentScenario(
      definitions[1],
      offlineModel([
        { type: 'tool_call', name: 'list_opportunities', arguments: {} },
        { type: 'final', claims },
      ]),
      g.gateway,
    );
    expect(report.failure).toBe('incorrect_outcome');
    expect(report.executedTools).toEqual(['list_opportunities']);
  });
  it('rejects a safe error obtained by looking up the wrong resource', async () => {
    const g = await gateway();
    const report = await runAgentScenario(
      missing,
      offlineModel([{ ...call, arguments: { projectId: fixtureIds.riskOpportunityId } }, final]),
      g.gateway,
    );
    expect(report.failure).toBe('incorrect_outcome');
  });
  it('rejects unsafe discovery before calling the adapter', async () => {
    const g = await gateway();
    const listing = await g.client.listTools();
    vi.spyOn(g.client, 'listTools').mockResolvedValue({
      ...listing,
      tools: listing.tools.map((tool) => ({ ...tool, annotations: { readOnlyHint: false } })),
    });
    const model = offlineModel([call, final]);
    const complete = vi.spyOn(model, 'complete');
    expect((await runAgentScenario(missing, model, g.gateway)).failure).toBe('discovery_failed');
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a malformed successful tool response without reporting its contents', async () => {
    const g = await gateway();
    vi.spyOn(g.client, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: 'private-response-sentinel' }],
      structuredContent: { secret: 'private-response-sentinel' },
    });
    const report = await runAgentScenario(missing, offlineModel([call]), g.gateway);
    expect(report.failure).toBe('invalid_tool_response');
    expect(report.executedTools).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('private-response-sentinel');
  });
  it('requires appropriate completed tools even when claims were guessed correctly', async () => {
    const g = await gateway();
    expect((await runAgentScenario(missing, offlineModel([final]), g.gateway)).failure).toBe(
      'incorrect_outcome',
    );
  });
  it.each(['model', 'gateway'] as const)(
    'fails on %s cleanup but attempts both closures',
    async (failing) => {
      const g = await gateway();
      const model = offlineModel([call, final]);
      const originalClose = g.gateway.close.bind(g.gateway);
      const modelClose = vi.spyOn(model, 'close');
      const gatewayClose = vi.spyOn(g.gateway, 'close');
      if (failing === 'model') modelClose.mockRejectedValue(new Error('private-cleanup-secret'));
      else
        gatewayClose.mockImplementation(async () => {
          await originalClose();
          throw new Error('private-cleanup-secret');
        });
      const report = await runAgentScenario(missing, model, g.gateway);
      expect(report.cleanup).toBe('failed');
      expect(report.status).toBe('failed');
      expect(modelClose).toHaveBeenCalledOnce();
      expect(gatewayClose).toHaveBeenCalledOnce();
      expect(JSON.stringify(report)).not.toContain('private-cleanup-secret');
    },
  );
  it('bounds stalled cleanup and still closes the gateway', async () => {
    const g = await gateway();
    const model = offlineModel([call, final]);
    model.close = () => new Promise(() => {});
    const close = vi.spyOn(g.gateway, 'close');
    const report = await runAgentScenario(missing, model, g.gateway, {
      ...defaultAgentLimits,
      cleanupTimeoutMs: 10,
    });
    expect(report.cleanup).toBe('failed');
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects missing/extra scenario fields and increased limits before model execution', async () => {
    const g = await gateway();
    const model = offlineModel([]);
    const complete = vi.spyOn(model, 'complete');
    expect(
      (await runAgentScenario({ id: 'unavailable_information' }, model, g.gateway)).failure,
    ).toBe('invalid_scenario');
    expect(complete).not.toHaveBeenCalled();
    expect(() => validateAgentScenarios(definitions.slice(1))).toThrow();
    expect(() => validateAgentScenarios([...definitions.slice(1), definitions[1]])).toThrow();
    expect(() =>
      validateAgentScenarios(
        definitions.map((scenario) => ({ ...scenario, secret: 'not-approved' })),
      ),
    ).toThrow();
    const next = await gateway();
    expect(
      (
        await runAgentScenario(missing, offlineModel([]), next.gateway, {
          ...defaultAgentLimits,
          maxTokens: 10000,
        })
      ).failure,
    ).toBe('invalid_limits');
  });
  it('fails closed for missing/skipped/duplicate/unsafe reports without exposing unknown fields', () => {
    const outcomes = scenarioIds.map((name) => ({
      name,
      state: 'passed',
      report: {
        ...failedAgentReport(name, 'setup_failed'),
        status: 'passed',
        failure: null,
        turns: 1,
      },
    }));
    expect(aggregateAgentReports(outcomes).status).toBe('passed');
    expect(aggregateAgentReports(outcomes.slice(1)).status).toBe('failed');
    expect(aggregateAgentReports([...outcomes, outcomes[0]!]).status).toBe('failed');
    expect(
      aggregateAgentReports(outcomes.map((outcome) => ({ ...outcome, state: 'skipped' }))).status,
    ).toBe('failed');
    const unsafe = outcomes.map((outcome) => ({
      ...outcome,
      report: { ...outcome.report, private: 'credential-sentinel' },
    }));
    const report = aggregateAgentReports(unsafe);
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('credential-sentinel');
    expect(aggregateAgentReports(outcomes, true).status).toBe('failed');
  });
  it('rejects contradictory success and refusal metadata', () => {
    const outcomes = scenarioIds.map((name) => ({
      name,
      state: 'passed',
      report: {
        ...failedAgentReport(name, 'setup_failed'),
        status: 'passed',
        failure: null,
        turns: 1,
      },
    }));
    expect(aggregateAgentReports(outcomes).status).toBe('passed');
    for (const invalid of [
      { failure: 'cleanup_failed' },
      { cleanup: 'failed' },
      { rejectedTools: ['create_project_note'] },
      { usage: { kind: 'simulated', inputTokens: 0, outputTokens: 0, complete: false } },
      { selectedTools: ['get_project'], refusedWithoutToolCall: true },
    ]) {
      const report = aggregateAgentReports(
        outcomes.map((outcome) => ({ ...outcome, report: { ...outcome.report, ...invalid } })),
      );
      expect(report.status).toBe('failed');
    }
  });
  it('rejects a late completion even before the timer callback runs', async () => {
    let finished = false;
    let signal: AbortSignal | undefined;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (finished ? 100 : 0));
    const operation = vi.fn((s: AbortSignal) => {
      signal = s;
      finished = true;
      return Promise.resolve('late');
    });
    try {
      await expect(bounded(operation, 10, 'model_timeout')).rejects.toMatchObject({
        code: 'model_timeout',
      });
      expect(operation).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
