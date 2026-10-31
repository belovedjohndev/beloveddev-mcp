import { withTestResourceCleanup } from '@beloveddev/test-support/test-database';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import https from 'node:https';
import { IncomingMessage, type ClientRequest } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { rootCertificates, checkServerIdentity } from 'node:tls';
import { Client } from '@modelcontextprotocol/client';
import { ListToolsResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolSchemas, type ToolName } from '../src/schemas.js';
import {
  actionSchema,
  AgentFailure,
  defaultAgentLimits,
  readOnlyTools,
  runAgentScenario,
  runApprovedAgentScenario,
  type ModelRequest,
  type LiveTurnAuthorization,
  claimProviderTurn,
} from './agent-evaluation.js';
import * as fixtureAuthority from './evaluation-fixture.js';
import * as approvalAuthority from './provider-live-approval.js';
import type { SyntheticAgentFixture } from './evaluation-fixture.js';
import { agentScenarios } from './agent-evaluation-scenarios.js';
import { McpToolGateway } from './agent-tool-gateway.js';
import { OpenAiProvider } from './openai-provider.js';
import { OpenAiNetworkTransport } from './openai-network-transport.js';
import type { responsesEndpoint } from './provider-wire-contract.js';
import { ProviderBudget } from './provider-budget.js';
import { providerControlReport } from './provider-evaluation-report.js';
import {
  createLiveInputEstimator,
  liveCompatibilityProfile,
  liveModel,
} from './provider-input-estimator.js';
import {
  approvalSigningBytes,
  verifyLiveApproval,
  ownerKeyFingerprint,
  approvedBudget,
  prepareLiveRequest,
  revokeLiveGrant,
  type SignedApproval,
  type LiveGrant,
} from './provider-live-approval.js';

const owner = generateKeyPairSync('ed25519');
const id = '11111111-1111-4111-8111-111111111111';
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
const definitions = agentScenarios({
  projectId: id,
  evidenceId: id,
  opportunityId: id,
  riskOpportunityId: '22222222-2222-4222-8222-222222222222',
  missingProjectId: id,
  foreignProjectId: id,
});
const missing = definitions.find((s) => s.id === 'unavailable_information')!;
const modelRequest: ModelRequest = {
  responseSchema: z.toJSONSchema(actionSchema),
  tools: readOnlyTools.map((name) => ({
    name,
    description: 'Synthetic tool.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  })),
  messages: [{ role: 'user', content: missing.prompt }],
  remainingTokens: 4096,
  maxOutputTokens: 256,
};
function document(overrides: Partial<SignedApproval['approval']> = {}): SignedApproval {
  const issued = Date.now() - 1000;
  const approval: SignedApproval['approval'] = {
    model: liveModel,
    maxCalls: 2,
    maxInputTokensPerCall: 3500,
    maxOutputTokensPerCall: 256,
    inputOverheadTokens: 1024,
    maxTotalTokens: 7512,
    maxPlannedCostMicroUsd: 10000,
    pricing: {
      source: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: new Date(issued).toISOString(),
      inputMicroUsdPerMillion: 400000,
      cacheWriteMicroUsdPerMillion: 400000,
      outputMicroUsdPerMillion: 1600000,
    },
    invocationId: randomUUID(),
    syntheticDataOnly: true,
    explicitlyApprovedByOwner: true,
    compatibilityProfile: liveCompatibilityProfile,
    approvalId: randomUUID(),
    fixtureManifestDigest: 'a'.repeat(64),
    scenarioSetDigest: 'b'.repeat(64),
    scenarioInventory: ['unavailable_information'],
    ownerKeyFingerprint: ownerKeyFingerprint(owner.publicKey),
    reviewReference: 'ephemeral-offline-test-owner',
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 900000).toISOString(),
    ...overrides,
  };
  return {
    approval,
    signature: sign(null, approvalSigningBytes(approval), owner.privateKey).toString('base64'),
  };
}
const grants: LiveGrant[] = [];
const resources = new Set<OpenAiNetworkTransport>();
const clients: Client[] = [];
function authorization(doc = document()) {
  const invocationId = doc.approval.invocationId;
  const fixture = Object.freeze({}) as SyntheticAgentFixture;
  unitFixtures.set(fixture, { claimed: false, closed: false });
  lastFixture = fixture;
  const grant = verifyLiveApproval(doc, owner.publicKey, invocationId, fixture);
  grants.push(grant);
  return { doc, grant, invocationId, fixture, budget: approvedBudget(grant, invocationId) };
}
function envelope(action: unknown = call) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    model: liveModel,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: JSON.stringify({ action }), annotations: [], logprobs: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
  };
}
type Behavior = {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  raw?: Buffer;
  stall?: boolean;
  interrupt?: boolean;
  failDestroy?: boolean;
};
let behaviors: Behavior[] = [];
const sent: { options: https.RequestOptions; body: string; request: ClientRequest }[] = [];
let socketSpy: ReturnType<typeof vi.spyOn>;
// Unit transport controls mock fixture authority; real PostgreSQL tests cover its actual issuer.
const unitFixtures = new WeakMap<
  object,
  { claimed: boolean; closed: boolean; gateway?: McpToolGateway }
>();
let lastFixture: SyntheticAgentFixture;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T00:00:00Z'));
  vi.spyOn(fixtureAuthority, 'fixtureApprovalBinding').mockImplementation((fixture, scenarioId) => {
    const state = unitFixtures.get(fixture);
    if (!state || state.closed) throw new AgentFailure('approval_invalid');
    if (scenarioId !== 'unavailable_information') throw new AgentFailure('approval_mismatch');
    return {
      fixtureManifestDigest: 'a'.repeat(64),
      scenarioSetDigest: 'b'.repeat(64),
      scenarioInventory: ['unavailable_information'],
    };
  });
  vi.spyOn(fixtureAuthority, 'claimSyntheticScenario').mockImplementation((fixture) => {
    const state = unitFixtures.get(fixture);
    if (!state || state.closed || state.claimed || !state.gateway)
      return Promise.reject(new AgentFailure('approval_invalid'));
    state.claimed = true;
    return Promise.resolve({ scenario: missing, gateway: state.gateway });
  });
  vi.spyOn(fixtureAuthority, 'closeSyntheticFixture').mockImplementation((fixture) => {
    const state = unitFixtures.get(fixture);
    if (!state) return Promise.reject(new AgentFailure('approval_invalid'));
    state.closed = true;
    return Promise.resolve();
  });
  vi.stubEnv('CI', undefined);
  vi.stubEnv('GITHUB_ACTIONS', undefined);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden fetch.'));
  socketSpy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('Forbidden socket.');
  });
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback: (message: IncomingMessage) => void,
  ) => {
    const behavior = behaviors.shift() ?? {};
    let body = '';
    const request = new Writable({
      autoDestroy: false,
      write(chunk: Buffer, _encoding, done) {
        body += chunk.toString('utf8');
        done();
      },
    });
    if (behavior.failDestroy) {
      const destroy = request.destroy.bind(request);
      let first = true;
      request.destroy = () => {
        if (first) {
          first = false;
          throw new Error('private-request-cleanup');
        }
        return destroy();
      };
    }
    request.once('finish', () => {
      sent.push({ options, body, request: request as unknown as ClientRequest });
      queueMicrotask(() => {
        const incoming = new IncomingMessage(new Socket());
        incoming.statusCode = behavior.status ?? 200;
        incoming.headers = { 'content-type': 'application/json', ...behavior.headers };
        callback(incoming);
        if (incoming.destroyed || behavior.stall) return;
        if (behavior.interrupt) {
          incoming.destroy(new Error('private-interrupted-response'));
          return;
        }
        incoming.complete = true;
        incoming.push(behavior.raw ?? Buffer.from(JSON.stringify(behavior.body ?? envelope())));
        incoming.push(null);
      });
    });
    return request as unknown as ClientRequest;
  }) as typeof https.request);
});
afterEach(async () => {
  const ownedTransports = [...resources],
    ownedClients = clients.splice(0),
    ownedGrants = grants.splice(0);
  resources.clear();
  await withTestResourceCleanup(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  }, [
    {
      stage: 'timers',
      run: () => {
        vi.useRealTimers();
      },
    },
    ...ownedTransports.map((resource) => ({
      stage: 'network_transport',
      run: () => resource.close(new AbortController().signal),
    })),
    ...ownedClients.map((client) => ({ stage: 'sdk_client', run: () => client.close() })),
    ...ownedGrants.map((grant) => ({
      stage: 'grant_revocation',
      run: () => revokeLiveGrant(grant),
    })),
    {
      stage: 'observations',
      run: () => {
        behaviors = [];
        sent.length = 0;
      },
    },
    {
      stage: 'environment',
      run: () => {
        vi.unstubAllEnvs();
      },
    },
  ]);
});

function control(doc = document()) {
  const auth = authorization(doc);
  const transport = new OpenAiNetworkTransport(auth.grant, auth.invocationId);
  resources.add(transport);
  const credential = vi.fn(() => randomUUID());
  const estimator = createLiveInputEstimator(liveModel);
  const adapter = new OpenAiProvider(transport, auth.budget, credential, estimator, undefined, {
    grant: auth.grant,
    invocationId: auth.invocationId,
  });
  return { ...auth, transport, credential, estimator, adapter };
}
function gateway(full = false) {
  const client = new Client({ name: 'offline-live-readiness', version: '1' }, { listMaxPages: 1 });
  clients.push(client);
  const names: ToolName[] = [...readOnlyTools, 'create_project_note'];
  vi.spyOn(client, 'listTools').mockResolvedValue(
    ListToolsResultSchema.parse(
      JSON.parse(
        JSON.stringify({
          tools: names.map((name) => ({
            name,
            description: full ? toolSchemas[name].description : 'Synthetic tool.',
            inputSchema: full
              ? { ...z.toJSONSchema(toolSchemas[name].input), type: 'object' as const }
              : { type: 'object' as const },
            outputSchema: full
              ? { ...z.toJSONSchema(toolSchemas[name].output), type: 'object' as const }
              : { type: 'object' as const },
            annotations: { readOnlyHint: name !== 'create_project_note' },
          })),
        }),
      ),
    ),
  );
  const dispatch = vi.spyOn(client, 'callTool').mockResolvedValue({
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'The requested resource was not found.',
            requestId: id,
          },
        }),
      },
    ],
  });
  const ownedGateway = new McpToolGateway(client);
  const state = unitFixtures.get(lastFixture);
  if (state) state.gateway = ownedGateway;
  return Promise.resolve({ gateway: ownedGateway, dispatch });
}

async function execute(c: ReturnType<typeof control>, full = false) {
  await gateway(full);
  return runApprovedAgentScenario(
    c.fixture,
    'unavailable_information',
    c.adapter,
    c.grant,
    c.invocationId,
  );
}
describe('offline live-provider readiness', () => {
  it('requires signed owner provenance and returns a nonserializable invocation capability', () => {
    const a = authorization();
    expect(JSON.stringify(a.grant)).toBe('{}');
    expect(a.budget.plan.model).toBe(liveModel);
    expect(() => verifyLiveApproval(a.doc, owner.publicKey, a.invocationId)).toThrow(
      'approval_invalid',
    );
  });
  it('rejects missing, unsigned and extra approval fields', () => {
    const d = document();
    for (const candidate of [
      undefined,
      { ...d, signature: 'A'.repeat(86) + '==' },
      { ...d, extra: true },
      { ...d, approval: { ...d.approval, unexpected: true } },
      { ...d, approval: { ...d.approval, explicitlyApprovedByOwner: false } },
    ])
      expect(() => verifyLiveApproval(candidate, owner.publicKey, d.approval.invocationId)).toThrow(
        'approval_invalid',
      );
    expect(https.request).not.toHaveBeenCalled();
  });
  it('rejects wrong invocation or owner key without reading provider credentials', () => {
    const d = document();
    expect(() => verifyLiveApproval(d, owner.publicKey, randomUUID())).toThrow('approval_mismatch');
    expect(() =>
      verifyLiveApproval(d, generateKeyPairSync('ed25519').publicKey, d.approval.invocationId),
    ).toThrow('approval_mismatch');
    expect(() => verifyLiveApproval(d, owner.privateKey, d.approval.invocationId)).toThrow(
      'approval_invalid',
    );
    expect(https.request).not.toHaveBeenCalled();
  });
  it('rejects edited model, call, token or money limits', () => {
    const d = document();
    for (const field of [
      'model',
      'maxCalls',
      'maxInputTokensPerCall',
      'maxOutputTokensPerCall',
      'maxTotalTokens',
      'maxPlannedCostMicroUsd',
    ] as const) {
      const value = field === 'model' ? 'unknown-model-2026-01-01' : 1;
      expect(() =>
        verifyLiveApproval(
          { ...d, approval: { ...d.approval, [field]: value } },
          owner.publicKey,
          d.approval.invocationId,
        ),
      ).toThrow('approval_invalid');
    }
  });
  it('rejects expired/future approval, stale/future pricing and overlong validity', () => {
    const now = Date.now();
    for (const override of [
      {
        issuedAt: new Date(now - 60000).toISOString(),
        expiresAt: new Date(now - 1).toISOString(),
        pricing: {
          ...document().approval.pricing,
          verifiedAt: new Date(now - 60000).toISOString(),
        },
      },
      {
        issuedAt: new Date(now + 60000).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(),
      },
      {
        pricing: {
          ...document().approval.pricing,
          verifiedAt: new Date(now - 86401000).toISOString(),
        },
      },
      {
        pricing: { ...document().approval.pricing, verifiedAt: new Date(now + 1000).toISOString() },
      },
      { expiresAt: new Date(now + 1000000).toISOString() },
    ]) {
      const d = document(override);
      expect(() => verifyLiveApproval(d, owner.publicKey, d.approval.invocationId)).toThrow();
    }
    expect(https.request).not.toHaveBeenCalled();
  });
  it('requires reviewed price floors, source, framing and API output minimum', () => {
    const d = document();
    for (const override of [
      { pricing: { ...d.approval.pricing, inputMicroUsdPerMillion: 1 } },
      { pricing: { ...d.approval.pricing, outputMicroUsdPerMillion: 1000000 } },
      {
        pricing: {
          ...d.approval.pricing,
          source: 'https://developers.openai.com/api/pricing' as const,
        },
      },
      { inputOverheadTokens: 256 },
      { maxOutputTokensPerCall: 15 },
    ]) {
      const candidate = document(override);
      expect(() =>
        verifyLiveApproval(candidate, owner.publicKey, candidate.approval.invocationId),
      ).toThrow('approval_invalid');
    }
    expect(() => new ProviderBudget({ ...d.approval, pricing: d.approval.pricing })).toThrow(
      'provider_configuration',
    );
  });
  it('refuses the deprecated profile at its documented shutdown', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-14T00:00:00Z'));
    const d = document();
    expect(() => authorization(d)).toThrow('approval_expired');
  });
  it('revalidates expiry and revocation before sending', async () => {
    const c = control();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(c.doc.approval.expiresAt));
    await expect(c.adapter.complete(modelRequest, new AbortController().signal)).rejects.toThrow(
      'approval_expired',
    );
    expect(c.credential).not.toHaveBeenCalled();
    vi.useRealTimers();
    revokeLiveGrant(c.grant);
    revokeLiveGrant(c.grant);
    await expect(c.adapter.complete(modelRequest, new AbortController().signal)).rejects.toThrow(
      'approval_invalid',
    );
    expect(https.request).not.toHaveBeenCalled();
  });
  it('does not extend approval lifetime when the wall clock rolls backwards', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const c = control();
    await vi.advanceTimersByTimeAsync(900000);
    vi.setSystemTime(new Date(c.doc.approval.issuedAt));
    await expect(c.adapter.complete(modelRequest, new AbortController().signal)).rejects.toThrow(
      'approval_expired',
    );
    expect(https.request).not.toHaveBeenCalled();
    expect(c.credential).not.toHaveBeenCalled();
  });
  it('requires complete safe readiness measurements and never echoes malformed report data', () => {
    const metric = {
      estimatedInputTokens: 10000,
      framingTokens: 1024,
      outputTokens: 256,
      scenarioTokenCeiling: 4096,
    };
    expect(providerControlReport(['passed'], false, [metric])).toMatchObject({
      schemaVersion: 3,
      status: 'blocked',
      offlineControlsStatus: 'passed',
      liveTokenBudgetPreflightStatus: 'blocked',
      overallLiveReadiness: 'blocked',
      liveExecutionPerformed: false,
      catalogPreflight: { fitsPreservedScenarioLimit: false },
    });
    expect(providerControlReport(['passed'], false, []).offlineControlsStatus).toBe('failed');
    const invalid = providerControlReport(['passed'], false, [
      { ...metric, secret: 'private-report-sentinel' },
    ]);
    expect('offlineControlsStatus' in invalid && invalid.offlineControlsStatus).toBe('failed');
    expect(JSON.stringify(invalid)).not.toContain('private-report-sentinel');
  });
  it('separates successful controls and fitting preflight from blocked overall readiness', () => {
    const report = providerControlReport(['passed'], false, [
      {
        estimatedInputTokens: 1000,
        framingTokens: 1024,
        outputTokens: 256,
        scenarioTokenCeiling: 4096,
      },
    ]);
    expect(report).toMatchObject({
      status: 'blocked',
      offlineControlsStatus: 'passed',
      liveTokenBudgetPreflightStatus: 'passed',
      overallLiveReadiness: 'blocked',
    });
    expect('blockers' in report && report.blockers).toContain('durable_atomic_replay_store');
  });
  it('revokes after fixture cleanup rejection even when the fixture authority still appears open', async () => {
    const c = control();
    await gateway();
    behaviors.push({ body: envelope(call) }, { body: envelope(final) });
    const close = vi
      .spyOn(fixtureAuthority, 'closeSyntheticFixture')
      .mockRejectedValue(new Error('private-fixture-cleanup'));
    const revoke = vi.spyOn(approvalAuthority, 'revokeLiveGrant');
    const report = await runApprovedAgentScenario(
      c.fixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report).toMatchObject({
      status: 'failed',
      cleanup: 'failed',
      failure: 'cleanup_failed',
    });
    expect(unitFixtures.get(c.fixture)?.closed).toBe(false);
    expect(revoke).toHaveBeenCalledWith(c.grant);
    expect(revoke.mock.invocationCallOrder[0]).toBeGreaterThan(close.mock.invocationCallOrder[0]!);
    expect(() => new OpenAiNetworkTransport(c.grant, c.invocationId)).toThrow('approval_invalid');
    await expect(c.adapter.complete(modelRequest, new AbortController().signal)).rejects.toThrow(
      'approval_invalid',
    );
    expect(JSON.stringify(report)).not.toContain('private-fixture-cleanup');
  });
  it('uses actual bundled o200k encoding with conservative margin and rejects estimator lookalikes', () => {
    const estimator = createLiveInputEstimator(liveModel);
    expect(estimator.estimate('hello world')).toBe(3);
    expect(estimator.estimate('你好 TypeScript <|im_start|>')).toBeGreaterThan(0);
    const c = control();
    expect(
      () =>
        new OpenAiProvider(
          c.transport,
          c.budget,
          c.credential,
          { mode: 'mock', model: liveModel, estimate: () => 0 },
          undefined,
          { grant: c.grant, invocationId: c.invocationId },
        ),
    ).toThrow('provider_configuration');
    expect(() => createLiveInputEstimator('latest')).toThrow('provider_configuration');
  });
  it('binds the live provider to the concrete transport and exact approved budget', () => {
    const c = control();
    const different = new ProviderBudget(c.budget.plan);
    expect(
      () =>
        new OpenAiProvider(c.transport, different, c.credential, c.estimator, undefined, {
          grant: c.grant,
          invocationId: c.invocationId,
        }),
    ).toThrow('approval_mismatch');
    const alternate = {
      mode: 'network' as const,
      request: vi.fn(),
      close: () => Promise.resolve(),
    };
    expect(
      () =>
        new OpenAiProvider(alternate, c.budget, c.credential, c.estimator, undefined, {
          grant: c.grant,
          invocationId: c.invocationId,
        }),
    ).toThrow('approval_mismatch');
    expect(c.credential).not.toHaveBeenCalled();
  });
  it('constructs one exact HTTPS request with isolated TLS/proxy policy and a private credential', async () => {
    const c = control();
    const key = randomUUID();
    c.credential.mockReturnValue(key);
    vi.stubEnv('HTTPS_PROXY', 'http://private-proxy.invalid');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    behaviors.push({ body: envelope(final) });
    const reply = await execute(c);
    expect(reply.usage.kind).toBe('provider_reported');
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.options).toMatchObject({
      protocol: 'https:',
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/responses',
      method: 'POST',
      servername: 'api.openai.com',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxHeaderSize: 8192,
      headers: { authorization: 'Bearer ' + key, 'accept-encoding': 'identity' },
    });
    expect(request.options.ca).toEqual([...rootCertificates]);
    expect(request.options.checkServerIdentity).toBe(checkServerIdentity);
    expect(request.options.agent).toBeInstanceOf(https.Agent);
    expect((request.options.agent as https.Agent).options).toMatchObject({
      proxyEnv: {},
      rejectUnauthorized: true,
    });
    expect(request.body).not.toContain(key);
    expect(request.body).not.toContain('expectedClaims');
    expect(request.body).not.toContain(c.doc.signature);
    expect(request.body).not.toContain('postgresql://');
  });
  it('executes through the shared approved runner and sole MCP gateway', async () => {
    const c = control();
    behaviors.push({ body: envelope(call) }, { body: envelope(final) });
    const g = await gateway();
    const report = await runApprovedAgentScenario(
      c.fixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report).toMatchObject({
      status: 'passed',
      selectedTools: ['get_project'],
      dispatchedTools: ['get_project'],
      executedTools: ['get_project'],
      usage: { kind: 'provider_reported', inputTokens: 200, outputTokens: 100, complete: true },
    });
    expect(g.dispatch).toHaveBeenCalledOnce();
    expect(() => approvedBudget(c.grant, c.invocationId)).toThrow('approval_invalid');
    expect(() => new OpenAiNetworkTransport(c.grant, c.invocationId)).toThrow('approval_invalid');
    await expect(c.adapter.complete(modelRequest, new AbortController().signal)).rejects.toThrow(
      'approval_invalid',
    );
    expect(() => {
      revokeLiveGrant(c.grant);
      revokeLiveGrant(c.grant);
    }).not.toThrow();
  });
  it('keeps the ordinary runner offline even with valid approval, flags and a key present', async () => {
    const c = control();
    vi.stubEnv('ALLOW_LIVE_MODEL', 'true');
    vi.stubEnv('OPENAI_API_KEY', randomUUID());
    const g = await gateway();
    const report = await runAgentScenario(missing, c.adapter, g.gateway);
    expect(report.failure).toBe('live_disabled');
    expect(c.credential).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });
  it.each(['CI', 'GITHUB_ACTIONS'])(
    'blocks %s before credentials or native HTTP',
    async (marker) => {
      const c = control();
      vi.stubEnv(marker, 'false');
      await gateway();
      const report = await runApprovedAgentScenario(
        c.fixture,
        'unavailable_information',
        c.adapter,
        c.grant,
        c.invocationId,
      );
      expect(report.failure).toBe('network_forbidden');
      expect(c.credential).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );
  it('rejects model/scenario approval flags and a wrong invocation on the approved runner', async () => {
    const c = control();
    await gateway();
    const report = await runApprovedAgentScenario(
      { ...missing, approval: c.doc } as unknown as SyntheticAgentFixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report.failure).toBe('approval_mismatch');
    const d = control();
    await gateway();
    const mismatch = await runApprovedAgentScenario(
      d.fixture,
      'unavailable_information',
      d.adapter,
      d.grant,
      randomUUID(),
    );
    expect(mismatch.failure).toBe('approval_mismatch');
    expect(https.request).not.toHaveBeenCalled();
  });
  it.each([
    ['create_project_note', {}, 'write_tool_blocked'],
    ['private-unknown-tool', {}, 'unknown_tool'],
    ['get_project', { projectId: 'bad' }, 'invalid_arguments'],
    ['get_project', { projectId: id, tenantId: id }, 'invalid_arguments'],
  ] as const)('rejects %s selections through the existing gateway', async (name, args, failure) => {
    const c = control();
    behaviors.push({
      body: envelope({ type: 'tool_call', name, argumentsJson: JSON.stringify(args) }),
    });
    const g = await gateway();
    const report = await runApprovedAgentScenario(
      c.fixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report).toMatchObject({
      status: 'failed',
      failure,
      dispatchedTools: [],
      executedTools: [],
      refusedWithoutToolCall: false,
    });
    expect(report.selectedTools).toHaveLength(1);
    expect(report.rejectedTools).toHaveLength(1);
    expect(g.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('private-unknown-tool');
  });
  it.each([401, 403, 429, 500, 503])(
    'classifies HTTP %s with unknown usage and no retry',
    async (status) => {
      const c = control();
      behaviors.push({ status, body: { secret: 'private-http-error' } });
      await gateway();
      const report = await runApprovedAgentScenario(
        c.fixture,
        'unavailable_information',
        c.adapter,
        c.grant,
        c.invocationId,
      );
      expect(report.failure).toBe(
        status === 401 || status === 403
          ? 'provider_authentication'
          : status === 429
            ? 'provider_rate_limited'
            : 'provider_service_failure',
      );
      expect(report.usage.complete).toBe(false);
      expect(() => new OpenAiNetworkTransport(c.grant, c.invocationId)).toThrow('approval_invalid');
      expect(https.request).toHaveBeenCalledOnce();
      expect(JSON.stringify(report)).not.toContain('private-http-error');
      expect(() => c.budget.reserve(1, 16)).toThrow('provider_budget');
    },
  );
  it.each([
    { status: 302, headers: { location: 'https://private-alternate.invalid' } },
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-encoding': 'gzip' } },
    { raw: Buffer.alloc(65537, 120) },
    { headers: { 'content-length': '999999' } },
    { raw: Buffer.from('{partial') },
    { interrupt: true },
    { body: { ...envelope(), usage: null } },
    {
      body: {
        ...envelope(),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    },
    { body: envelope({ type: 'not-an-action' }) },
  ])('fails closed on unsafe/incomplete native responses', async (behavior) => {
    const c = control();
    behaviors.push(behavior);
    await gateway();
    const report = await runApprovedAgentScenario(
      c.fixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report.status).toBe('failed');
    expect(report.dispatchedTools).toEqual([]);
    expect(https.request).toHaveBeenCalledOnce();
  });
  it('enforces exact body, endpoint, missing permit and HTTP permit replay before dispatch', async () => {
    const c = control();
    await expect(
      c.transport.request({
        url: 'http://api.openai.com/v1/responses' as typeof responsesEndpoint,
        method: 'POST',
        headers: {},
        body: '{}',
        redirect: 'error',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('provider_configuration');
    const consume = approvalAuthority.consumeLiveRequest;
    vi.spyOn(approvalAuthority, 'consumeLiveRequest').mockImplementation(
      (grant, invocationId, permit, body) => {
        const before = vi.mocked(https.request).mock.calls.length;
        expect(() => consume(grant, invocationId, permit, body + ' ')).toThrow('approval_invalid');
        expect(() => consume(grant, invocationId, undefined, body)).toThrow('approval_invalid');
        expect(() => consume(grant, randomUUID(), permit, body)).toThrow('approval_mismatch');
        expect(vi.mocked(https.request).mock.calls.length).toBe(before);
        consume(grant, invocationId, permit, body);
        expect(() => consume(grant, invocationId, permit, body)).toThrow('approval_invalid');
        expect(vi.mocked(https.request).mock.calls.length).toBe(before);
      },
    );
    behaviors.push({ body: envelope(final) });
    await execute(c);
    expect(https.request).toHaveBeenCalledOnce();
  });
  it.each(['settled', 'failed'] as const)(
    'rejects a permit whose reservation is %s before native dispatch',
    async (outcome) => {
      const c = control();
      const reserve = c.budget.reserve.bind(c.budget);
      let receipt: ReturnType<typeof reserve> | undefined;
      vi.spyOn(c.budget, 'reserve').mockImplementation((...args) => {
        receipt = reserve(...args);
        return receipt;
      });
      const prepare = approvalAuthority.prepareLiveRequest;
      vi.spyOn(approvalAuthority, 'prepareLiveRequest').mockImplementation((...args) => {
        const permit = prepare(...args);
        expect(receipt).toBeDefined();
        if (outcome === 'settled') receipt!.settle(envelope().usage);
        else receipt!.unknown();
        return permit;
      });
      const report = await execute(c);
      expect(report.failure).toBe('provider_budget');
      expect(https.request).not.toHaveBeenCalled();
    },
  );
  it('reserves planned calls and cost, then blocks exhaustion without another credential read', async () => {
    const c = control(document({ maxCalls: 1 }));
    const report = await execute(c);
    expect(report.failure).toBe('provider_budget');
    expect(c.credential).toHaveBeenCalledOnce();
    expect(https.request).toHaveBeenCalledOnce();
    expect(c.budget.snapshot()).toMatchObject({
      callsReserved: 1,
      reservedTokens: 3756,
      reservedCostMicroUsd: 1810,
    });
  });
  it('aborts stalled native responses with unknown usage and destroys the request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const c = control();
    behaviors.push({ stall: true });
    const pending = execute(c);
    await vi.advanceTimersByTimeAsync(5000);
    const report = await pending;
    expect(report.failure).toBe('model_timeout');
    expect(sent[0]?.request.destroyed).toBe(true);
    expect(c.adapter.usageSnapshot().complete).toBe(false);
    expect(c.budget.snapshot().usageStatus).toBe('unknown');
  });
  it('propagates cancellation after dispatch without retry', async () => {
    const c = control();
    behaviors.push({ stall: true });
    const abort = new AbortController();
    const complete = c.adapter.complete.bind(c.adapter);
    vi.spyOn(c.adapter, 'complete').mockImplementation((request, _signal, turn) =>
      complete(request, abort.signal, turn),
    );
    const pending = execute(c);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    abort.abort();
    const report = await pending;
    expect(report.status).toBe('failed');
    expect(sent[0]?.request.destroyed).toBe(true);
    expect(c.credential).toHaveBeenCalledOnce();
  });
  it('attempts gateway cleanup after a transport cleanup failure', async () => {
    const c = control();
    behaviors.push({ body: envelope(call) }, { body: envelope(final) });
    const g = await gateway();
    const close = vi.spyOn(g.gateway, 'close');
    const destroy = vi
      .spyOn((c.transport as unknown as { agent: https.Agent }).agent, 'destroy')
      .mockImplementation(() => {
        throw new Error('private-cleanup-error');
      });
    const report = await runApprovedAgentScenario(
      c.fixture,
      'unavailable_information',
      c.adapter,
      c.grant,
      c.invocationId,
    );
    expect(report).toMatchObject({
      status: 'failed',
      cleanup: 'failed',
      failure: 'cleanup_failed',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(() => new OpenAiNetworkTransport(c.grant, c.invocationId)).toThrow('approval_invalid');
    expect(JSON.stringify(report)).not.toContain('private-cleanup-error');
    destroy.mockRestore();
    (c.transport as unknown as { agent: https.Agent }).agent.destroy();
    resources.delete(c.transport);
  });
  it.each([
    [{ interrupt: true, failDestroy: true }, 'provider_failure'],
    [{ status: 401, failDestroy: true }, 'provider_authentication'],
  ] as const)(
    'retains failed socket cleanup and reports failure safely (%s)',
    async (behavior, failure) => {
      const c = control();
      behaviors.push(behavior);
      const g = await gateway();
      const close = vi.spyOn(g.gateway, 'close');
      const report = await runApprovedAgentScenario(
        c.fixture,
        'unavailable_information',
        c.adapter,
        c.grant,
        c.invocationId,
      );
      expect(report).toMatchObject({
        status: 'failed',
        failure,
        cleanup: 'failed',
      });
      expect(close).toHaveBeenCalledOnce();
      expect(sent[0]?.request.destroyed).toBe(true);
      expect(JSON.stringify(report)).not.toContain('private-request-cleanup');
      resources.delete(c.transport);
    },
  );
  it('measures the full seven-tool catalog against preserved C1 token limits offline', async ({
    task,
  }) => {
    const g = await gateway(true);
    const tools = await g.gateway.discover(new AbortController().signal);
    const estimator = createLiveInputEstimator(liveModel);
    let estimate = 0;
    const budget = new ProviderBudget({
      model: liveModel,
      maxCalls: 1,
      maxInputTokensPerCall: 3500,
      maxOutputTokensPerCall: 256,
      inputOverheadTokens: 1024,
      maxTotalTokens: 4096,
      maxPlannedCostMicroUsd: 10000,
      pricing: document().approval.pricing,
    });
    const transport = {
      mode: 'mock' as const,
      request: vi.fn(() => Promise.resolve(new Response('{}'))),
      close: () => Promise.resolve(),
    };
    const credential = vi.fn(() => randomUUID());
    const adapter = new OpenAiProvider(transport, budget, credential, {
      mode: 'mock',
      model: liveModel,
      estimate(body) {
        estimate = estimator.estimate(body);
        return estimate;
      },
    });
    await expect(
      adapter.complete({ ...modelRequest, tools }, new AbortController().signal),
    ).rejects.toThrow('provider_budget');
    expect(estimate + 1024 + 256).toBeGreaterThan(defaultAgentLimits.maxTokens);
    expect(credential).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    task.meta.liveReadinessEstimate = {
      estimatedInputTokens: estimate,
      framingTokens: 1024,
      outputTokens: 256,
      scenarioTokenCeiling: 4096,
    };
    await adapter.close();
  });
  it.each(['canonical', 'arbitrary'] as const)(
    'rejects a direct live request (%s) and direct permit preparation before credentials',
    async (prompt) => {
      const c = control();
      const request = {
        ...modelRequest,
        messages: [
          {
            role: 'user' as const,
            content: prompt === 'canonical' ? missing.prompt : 'private unrelated prompt',
          },
        ],
      };
      await expect(c.adapter.complete(request, new AbortController().signal)).rejects.toThrow(
        'approval_invalid',
      );
      expect(() => prepareLiveRequest(c.grant, c.invocationId, c.budget, {}, '{}')).toThrow(
        'approval_invalid',
      );
      expect(c.credential).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );
  it.each(['prompt', 'extra_user', 'fake_tool', 'inventory', 'budget', 'schema'] as const)(
    'rejects changed first-turn %s before credentials or HTTPS',
    async (mutation) => {
      const c = control();
      const original = c.adapter.complete.bind(c.adapter);
      vi.spyOn(c.adapter, 'complete').mockImplementation((request, signal, turn) => {
        expect(Object.isFrozen(request.messages)).toBe(true);
        const changed = { ...structuredClone(request) };
        if (mutation === 'prompt')
          changed.messages = [{ role: 'user', content: 'private changed prompt' }];
        if (mutation === 'extra_user')
          changed.messages = [...changed.messages, { role: 'user', content: 'extra' }];
        if (mutation === 'fake_tool')
          changed.messages = [
            ...changed.messages,
            { role: 'tool', content: '{"fabricated":true}' },
          ];
        if (mutation === 'inventory')
          changed.tools = changed.tools.map((t) => ({ ...t, description: 'changed' }));
        if (mutation === 'budget') changed.remainingTokens--;
        if (mutation === 'schema')
          changed.responseSchema = { ...changed.responseSchema, type: 'string' };
        return original(changed, signal, turn);
      });
      const report = await execute(c);
      expect(report.failure).toBe('approval_mismatch');
      expect(c.credential).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );
  it.each(['other_grant', 'other_provider', 'other_model'] as const)(
    'rejects %s pairing with an otherwise real turn',
    async (pairing) => {
      const c = control(),
        other = control();
      const alternate = new OpenAiProvider(
        c.transport,
        c.budget,
        c.credential,
        c.estimator,
        undefined,
        { grant: c.grant, invocationId: c.invocationId },
      );
      const original = c.adapter.complete.bind(c.adapter);
      vi.spyOn(c.adapter, 'complete').mockImplementation((request, signal, turn) => {
        if (pairing === 'other_grant') return other.adapter.complete(request, signal, turn);
        if (pairing === 'other_provider') return alternate.complete(request, signal, turn);
        claimProviderTurn(turn, c.grant, c.invocationId, c.adapter, 'wrong-model', request);
        return original(request, signal, turn);
      });
      // The first fixture, rather than the most recently created control, owns the gateway.
      lastFixture = c.fixture;
      const report = await execute(c);
      expect(report.status).toBe('failed');
      expect(c.credential).not.toHaveBeenCalled();
      expect(other.credential).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
      await alternate.close();
    },
  );
  it('binds subsequent turns to actual MCP observations and rejects edited history and old capabilities', async () => {
    const c = control();
    const complete = c.adapter.complete.bind(c.adapter);
    let first: { request: ModelRequest; turn: LiveTurnAuthorization | undefined } | undefined;
    vi.spyOn(c.adapter, 'complete').mockImplementation(async (request, signal, turn) => {
      if (!first) {
        first = { request, turn };
        const result = await complete(request, signal, turn);
        const credentialReads = c.credential.mock.calls.length;
        await expect(complete(request, signal, turn)).rejects.toThrow();
        expect(c.credential.mock.calls.length).toBe(credentialReads);
        return result;
      }
      expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(request.messages[1]?.content).toContain('get_project');
      expect(JSON.parse(request.messages[2]!.content)).toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
      expect(request.remainingTokens).toBe(3946);
      const before = c.credential.mock.calls.length;
      await expect(complete(first.request, signal, first.turn)).rejects.toThrow();
      const changed = {
        ...request,
        messages: request.messages.map((m) =>
          m.role === 'tool' ? { ...m, content: '{"fabricated":true}' } : m,
        ),
      };
      await expect(complete(changed, signal, turn)).rejects.toThrow('approval_mismatch');
      expect(c.credential.mock.calls.length).toBe(before);
      const result = await complete(request, signal, turn);
      return result;
    });
    behaviors.push({ body: envelope(call) }, { body: envelope(final) });
    const report = await execute(c);
    expect(report.status).toBe('passed');
    expect(c.credential).toHaveBeenCalledTimes(2);
    expect(https.request).toHaveBeenCalledTimes(2);
    await expect(
      complete(first!.request, new AbortController().signal, first!.turn),
    ).rejects.toThrow('approval_invalid');
  });
  it('rejects direct permit preparation with a real but unclaimed turn', async () => {
    const c = control();
    vi.spyOn(c.adapter, 'complete').mockImplementation((_request, _signal, turn) => {
      expect(() => prepareLiveRequest(c.grant, c.invocationId, c.budget, {}, '{}', turn)).toThrow(
        'approval_invalid',
      );
      return Promise.reject(new AgentFailure('approval_invalid'));
    });
    await execute(c);
    expect(c.credential).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });
  it('retires completed execution turns before cleanup while the grant is still fresh', async () => {
    const c = control();
    let captured: { request: ModelRequest; turn: LiveTurnAuthorization | undefined } | undefined;
    const complete = c.adapter.complete.bind(c.adapter);
    vi.spyOn(c.adapter, 'complete').mockImplementation((request, signal, turn) => {
      captured = { request, turn };
      return complete(request, signal, turn);
    });
    vi.spyOn(fixtureAuthority, 'closeSyntheticFixture').mockImplementationOnce(async () => {
      expect(approvedBudget(c.grant, c.invocationId)).toBe(c.budget);
      const before = c.credential.mock.calls.length;
      const dispatches = vi.mocked(https.request).mock.calls.length;
      await expect(
        complete(captured!.request, new AbortController().signal, captured!.turn),
      ).rejects.toThrow('approval_invalid');
      expect(c.credential.mock.calls.length).toBe(before);
      expect(vi.mocked(https.request).mock.calls.length).toBe(dispatches);
    });
    behaviors.push({ body: envelope(call) }, { body: envelope(final) });
    const report = await execute(c);
    expect(report.status).toBe('passed');
    expect(() => approvedBudget(c.grant, c.invocationId)).toThrow('approval_invalid');
  });
});

declare module 'vitest' {
  interface TaskMeta {
    liveReadinessEstimate?: {
      estimatedInputTokens: number;
      framingTokens: number;
      outputTokens: number;
      scenarioTokenCeiling: number;
    };
  }
}
