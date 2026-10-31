import { withTestResourceCleanup, TestCleanupError } from '@beloveddev/test-support/test-database';
import {
  approveTestCluster,
  approvedClusterUrl,
  type ApprovedTestCluster,
} from './approved-test-cluster.js';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import https from 'node:https';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseTestDatabaseUrl } from '@beloveddev/infrastructure/environment';
import * as testDatabase from '@beloveddev/test-support/test-database';
import * as serverModule from '../src/server.js';
import {
  createSyntheticAgentFixture,
  closeSyntheticFixture,
  fixtureApprovalBinding,
  claimSyntheticScenario,
  type SyntheticAgentFixture,
  type AgentScenarioId,
} from './evaluation-fixture.js';
import { runApprovedAgentScenario, offlineModel } from './agent-evaluation.js';
import { OpenAiNetworkTransport } from './openai-network-transport.js';
import {
  approvalSigningBytes,
  ownerKeyFingerprint,
  verifyLiveApproval,
  approvedBudget,
  revokeLiveGrant,
  type SignedApproval,
  type LiveGrant,
} from './provider-live-approval.js';
import { liveModel, liveCompatibilityProfile } from './provider-input-estimator.js';
const owner = generateKeyPairSync('ed25519');
const fixtures: SyntheticAgentFixture[] = [];
const grants: LiveGrant[] = [];
const transports: OpenAiNetworkTransport[] = [];
const databases: testDatabase.TestDatabase[] = [];
const servers: ReturnType<typeof serverModule.createMcpServer>[] = [];
const createDatabase = testDatabase.createTestDatabase;
const composeServer = serverModule.createMcpServer;
beforeEach(() => {
  vi.stubEnv('CI', undefined);
  vi.stubEnv('GITHUB_ACTIONS', undefined);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T00:00:00Z'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden provider egress'));
  vi.spyOn(https, 'request').mockImplementation(() => {
    throw new Error('Forbidden provider egress');
  });
  vi.spyOn(testDatabase, 'createTestDatabase').mockImplementation(async (...args) => {
    const db = await createDatabase(...args);
    databases.push(db);
    return db;
  });
  vi.spyOn(serverModule, 'createMcpServer').mockImplementation((...args) => {
    const server = composeServer(...args);
    servers.push(server);
    return server;
  });
});
afterEach(async () => {
  const ownedFixtures = fixtures.splice(0),
    ownedServers = servers.splice(0),
    ownedDatabases = databases.splice(0),
    ownedTransports = transports.splice(0),
    ownedGrants = grants.splice(0);
  await withTestResourceCleanup(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  }, [
    ...ownedTransports.map((transport) => ({
      stage: 'network_transport',
      run: () => transport.close(new AbortController().signal),
    })),
    ...ownedFixtures.map((fixture) => ({
      stage: 'synthetic_fixture',
      run: () => closeSyntheticFixture(fixture),
    })),
    ...ownedServers.map((server) => ({ stage: 'sdk_server', run: () => server.close() })),
    ...ownedDatabases.map((database) => ({ stage: 'database', run: () => database.close() })),
    ...ownedGrants.map((grant) => ({
      stage: 'grant_revocation',
      run: () => revokeLiveGrant(grant),
    })),
    {
      stage: 'environment',
      run: () => {
        vi.unstubAllEnvs();
      },
    },
  ]);
});

function clusterConfiguration() {
  const url = new URL(parseTestDatabaseUrl(process.env));
  url.pathname = '/postgres';
  return {
    administratorUrl: url.toString(),
    systemIdentifier: process.env['TEST_CLUSTER_SYSTEM_IDENTIFIER'],
    marker: process.env['TEST_CLUSTER_MARKER'],
  };
}
async function fixture() {
  const cluster = await approveTestCluster(clusterConfiguration());
  const value = await createSyntheticAgentFixture(cluster);
  fixtures.push(value);
  return value;
}
function document(
  f: SyntheticAgentFixture,
  scenario: AgentScenarioId = 'mutation_refusal',
  overrides: Partial<SignedApproval['approval']> = {},
): SignedApproval {
  const issued = Date.now() - 1000;
  const approval: SignedApproval['approval'] = {
    model: liveModel,
    compatibilityProfile: liveCompatibilityProfile,
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
    approvalId: randomUUID(),
    syntheticDataOnly: true,
    explicitlyApprovedByOwner: true,
    ownerKeyFingerprint: ownerKeyFingerprint(owner.publicKey),
    reviewReference: 'offline-fixture-regression',
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 900000).toISOString(),
    ...fixtureApprovalBinding(f, scenario),
    scenarioInventory: [scenario],
    ...overrides,
  };
  return {
    approval,
    signature: sign(null, approvalSigningBytes(approval), owner.privateKey).toString('base64'),
  };
}
function authorize(f: SyntheticAgentFixture, scenario: AgentScenarioId = 'mutation_refusal') {
  const d = document(f, scenario);
  const grant = verifyLiveApproval(d, owner.publicKey, d.approval.invocationId, f);
  grants.push(grant);
  return { grant, invocationId: d.approval.invocationId };
}
const noFacts = {
  availability: 'refused',
  projectIds: [],
  evidenceIds: [],
  opportunityIds: [],
  overallScore: null,
  recommendation: null,
  riskCodes: [],
  concernCodes: [],
  errorCodes: [],
};

it('mints opaque bindings only through fresh synthetic setup and binds the complete canonical scenario', async () => {
  const f = await fixture(),
    other = await fixture();
  expect(JSON.stringify(f)).toBe('{}');
  const a = fixtureApprovalBinding(f, 'mutation_refusal');
  expect(a.fixtureManifestDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(a.scenarioInventory).toEqual(['mutation_refusal']);
  expect(fixtureApprovalBinding(f, 'mutation_refusal')).toEqual(a);
  expect(fixtureApprovalBinding(f, 'unavailable_information').scenarioSetDigest).not.toBe(
    a.scenarioSetDigest,
  );
  expect(fixtureApprovalBinding(other, 'mutation_refusal').fixtureManifestDigest).not.toBe(
    a.fixtureManifestDigest,
  );
  expect(() => fixtureApprovalBinding({ ...f }, 'mutation_refusal')).toThrow('approval_invalid');
  const d = document(f);
  expect(() => verifyLiveApproval(d, owner.publicKey, d.approval.invocationId)).toThrow(
    'approval_invalid',
  );
  expect(() => verifyLiveApproval(d, owner.publicKey, d.approval.invocationId, other)).toThrow(
    'approval_mismatch',
  );
  for (const overrides of [
    { fixtureManifestDigest: '0'.repeat(64) },
    { scenarioSetDigest: '0'.repeat(64) },
    { scenarioInventory: ['unavailable_information'] },
  ] satisfies Partial<SignedApproval['approval']>[]) {
    const changed = document(f, 'mutation_refusal', overrides);
    expect(() =>
      verifyLiveApproval(changed, owner.publicKey, changed.approval.invocationId, f),
    ).toThrow('approval_mismatch');
  }
  expect(() =>
    approvalSigningBytes({
      ...d.approval,
      scenarioInventory: ['mutation_refusal', 'unavailable_information'],
    }),
  ).toThrow('approval_invalid');
  await closeSyntheticFixture(f);
  expect(() => verifyLiveApproval(d, owner.publicKey, d.approval.invocationId, f)).toThrow(
    'approval_invalid',
  );
});
it('refuses inherited application data and retires the unapproved database', async () => {
  vi.spyOn(testDatabase, 'createTestDatabase').mockImplementationOnce(async (...args) => {
    const db = await createDatabase(...args);
    databases.push(db);
    await db.admin.pool.query('INSERT INTO tenants(id,name,slug) VALUES ($1,$2,$3)', [
      randomUUID(),
      'Unapproved synthetic template row',
      'unapproved-template',
    ]);
    return db;
  });
  const cluster = await approveTestCluster(clusterConfiguration());
  await expect(createSyntheticAgentFixture(cluster)).rejects.toThrow('setup_failed');
});
it('keeps canonical scenarios immutable and rejects second claims', async () => {
  const f = await fixture();
  const owned = await claimSyntheticScenario(f, 'mutation_refusal');
  expect(Object.isFrozen(owned.scenario)).toBe(true);
  expect(Object.isFrozen(owned.scenario.expectedClaims)).toBe(true);
  expect(() => {
    owned.scenario.prompt = 'replaced';
  }).toThrow();
  await expect(claimSyntheticScenario(f, 'mutation_refusal')).rejects.toThrow('approval_invalid');
});
it('revokes and retires the owned fixture on a mismatched scenario selection', async () => {
  const f = await fixture();
  const a = authorize(f);
  const report = await runApprovedAgentScenario(
    f,
    'unavailable_information',
    offlineModel([]),
    a.grant,
    a.invocationId,
  );
  expect(report.failure).toBe('approval_mismatch');
  expect(() => fixtureApprovalBinding(f, 'mutation_refusal')).toThrow('approval_invalid');
  expect(() => approvedBudget(a.grant, a.invocationId)).toThrow('approval_invalid');
});
it('detects fixture data modification before claiming the canonical scenario', async () => {
  const f = await fixture();
  const db = databases.at(-1)!;
  await db.admin.pool.query("UPDATE projects SET summary='tampered synthetic data'");
  await expect(claimSyntheticScenario(f, 'mutation_refusal')).rejects.toThrow('approval_mismatch');
});
it('does not accept arbitrary prompts, scenario objects or gateway/client objects as fixture proof', async () => {
  const f = await fixture();
  const a = authorize(f);
  const model = offlineModel([{ type: 'final', claims: noFacts }]);
  const close = vi.spyOn(model, 'close');
  const report = await runApprovedAgentScenario(
    { prompt: 'private prompt', client: {} } as unknown as SyntheticAgentFixture,
    'mutation_refusal',
    model,
    a.grant,
    a.invocationId,
  );
  expect(report.status).toBe('failed');
  expect(report.failure).toBe('approval_mismatch');
  expect(close).toHaveBeenCalledOnce();
  expect(() => approvedBudget(a.grant, a.invocationId)).toThrow('approval_invalid');
});
it('uses the fixture-owned MCP gateway and canonical missing-project scenario', async () => {
  const f = await fixture();
  const a = authorize(f, 'unavailable_information');
  let turn = 0;
  const model = {
    mode: 'offline' as const,
    close: () => Promise.resolve(),
    complete: (request: Parameters<ReturnType<typeof offlineModel>['complete']>[0]) => {
      const target = request.messages[0]!.content.match(/[a-f0-9-]{36}/)?.[0];
      const action =
        turn++ === 0
          ? { type: 'tool_call', name: 'get_project', arguments: { projectId: target } }
          : {
              type: 'final',
              claims: { ...noFacts, availability: 'unavailable', errorCodes: ['NOT_FOUND'] },
            };
      return Promise.resolve({
        output: JSON.stringify(action),
        usage: { kind: 'simulated' as const, inputTokens: 32, outputTokens: 32 },
      });
    },
  };
  const report = await runApprovedAgentScenario(
    f,
    'unavailable_information',
    model,
    a.grant,
    a.invocationId,
  );
  expect(report).toMatchObject({
    status: 'passed',
    executedTools: ['get_project'],
    cleanup: 'passed',
  });
  expect(() => approvedBudget(a.grant, a.invocationId)).toThrow('approval_invalid');
});
it.each(['success', 'model_failure', 'cleanup_failure'] as const)(
  'revokes on %s after independent cleanup; neither new nor existing transports can dispatch',
  async (outcome) => {
    const f = await fixture();
    const a = authorize(f);
    const db = databases.at(-1)!;
    const transport = new OpenAiNetworkTransport(a.grant, a.invocationId);
    transports.push(transport);
    const model = offlineModel([{ type: 'final', claims: noFacts }]);
    if (outcome === 'model_failure')
      vi.spyOn(model, 'complete').mockRejectedValue(new Error('private-provider-error'));
    if (outcome === 'cleanup_failure')
      vi.spyOn(servers.at(-1)!, 'close').mockRejectedValueOnce(new Error('private-server-cleanup'));
    const report = await runApprovedAgentScenario(
      f,
      'mutation_refusal',
      model,
      a.grant,
      a.invocationId,
    );
    expect(report.status).toBe(outcome === 'success' ? 'passed' : 'failed');
    if (outcome === 'cleanup_failure') {
      expect(report.cleanup).toBe('failed');
      // The runner already attempted every owned cleanup stage. Explicitly observe its
      // sticky failure before relinquishing this fixture; never swallow teardown errors.
      await expect(closeSyntheticFixture(f)).rejects.toMatchObject({
        failures: [{ stage: 'sdk_server', code: 'UNKNOWN' }],
      });
      fixtures.splice(fixtures.indexOf(f), 1);
    }
    expect(JSON.stringify(report)).not.toContain('private-');
    expect(() => new OpenAiNetworkTransport(a.grant, a.invocationId)).toThrow('approval_invalid');
    await expect(
      transport.request({
        url: 'https://api.openai.com/v1/responses',
        method: 'POST',
        headers: {},
        body: '{}',
        redirect: 'error',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('approval_invalid');
    expect(() => {
      revokeLiveGrant(a.grant);
      revokeLiveGrant(a.grant);
    }).not.toThrow();
    const repeat = await runApprovedAgentScenario(
      f,
      'mutation_refusal',
      model,
      a.grant,
      a.invocationId,
    );
    expect(repeat.status).toBe('failed');
    await transport.close(new AbortController().signal);
    // TestDatabase identity checks guarantee only the fixture's database/role were retired.
    const control = await createDatabase(parseTestDatabaseUrl(process.env));
    try {
      const found = await control.admin.pool.query('SELECT 1 FROM pg_database WHERE oid=$1', [
        db.identity.databaseOid,
      ]);
      expect(found.rowCount).toBe(0);
    } finally {
      await control.close();
    }
  },
);

it('rejects arbitrary fixture cluster proof before creating any database or role', async () => {
  await expect(createSyntheticAgentFixture({} as ApprovedTestCluster)).rejects.toThrow(
    'setup_failed',
  );
  await expect(
    approveTestCluster({ ...clusterConfiguration(), systemIdentifier: '0' }),
  ).rejects.toThrow('setup_failed');
  await expect(
    approveTestCluster({ ...clusterConfiguration(), marker: randomUUID() }),
  ).rejects.toThrow('setup_failed');
  expect(testDatabase.createTestDatabase).not.toHaveBeenCalled();
});
it('revalidates the cluster identity before fixture creation', async () => {
  const configuration = clusterConfiguration();
  const marker = configuration.marker;
  if (!marker || !/^[a-f0-9-]{36}$/.test(marker)) throw new Error('Invalid test marker.');
  const cluster = await approveTestCluster(configuration);
  expect(JSON.stringify(cluster)).toBe('{}');
  await expect(approvedClusterUrl({ ...cluster })).rejects.toThrow('setup_failed');
  expect(await approvedClusterUrl(cluster)).toBe(configuration.administratorUrl);
  // Replace only the owned test cluster's marker and restore it independently.
  const { openDatabase } = await import('@beloveddev/database/client');
  const db = openDatabase(configuration.administratorUrl, { onIdleError() {} });
  await withTestResourceCleanup(async () => {
    await db.pool.query("COMMENT ON DATABASE postgres IS 'unapproved'");
    await expect(createSyntheticAgentFixture(cluster)).rejects.toThrow('setup_failed');
    expect(testDatabase.createTestDatabase).not.toHaveBeenCalled();
  }, [
    {
      stage: 'cluster_marker',
      run: async () => {
        await db.pool.query(
          "COMMENT ON DATABASE postgres IS 'beloveddev.synthetic-evaluation-cluster:" +
            marker +
            "'",
        );
      },
    },
    { stage: 'control_pool', run: () => db.close() },
  ]);
});

it('retires a real fixture, transport and grant even after an assertion and server cleanup fail', async () => {
  const f = await fixture(),
    a = authorize(f),
    db = databases.at(-1)!;
  const transport = new OpenAiNetworkTransport(a.grant, a.invocationId);
  transports.push(transport);
  vi.spyOn(servers.at(-1)!, 'close').mockRejectedValueOnce(
    new Error('synthetic server close failure'),
  );
  const assertion = new Error('original assertion sentinel');
  const result: unknown = await withTestResourceCleanup(() => {
    throw assertion;
  }, [
    { stage: 'transport', run: () => transport.close(new AbortController().signal) },
    { stage: 'fixture', run: () => closeSyntheticFixture(f) },
    { stage: 'grant', run: () => revokeLiveGrant(a.grant) },
  ]).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  if (!(result instanceof AggregateError)) throw new Error('Expected aggregate failure.');
  expect(result.errors[0]).toBe(assertion);
  expect(result.errors[1]).toBeInstanceOf(TestCleanupError);
  expect(result.errors[1]).toMatchObject({
    failures: [{ stage: 'fixture.sdk_server', code: 'UNKNOWN' }],
  });
  await expect(closeSyntheticFixture(f)).rejects.toMatchObject({
    failures: [{ stage: 'sdk_server', code: 'UNKNOWN' }],
  });
  fixtures.splice(fixtures.indexOf(f), 1);
  expect(() => approvedBudget(a.grant, a.invocationId)).toThrow('approval_invalid');
  const { openDatabase } = await import('@beloveddev/database/client');
  const control = openDatabase(clusterConfiguration().administratorUrl, { onIdleError() {} });
  await withTestResourceCleanup(async () => {
    const found = await control.pool.query('SELECT 1 FROM pg_database WHERE oid=$1', [
      db.identity.databaseOid,
    ]);
    expect(found.rowCount).toBe(0);
  }, [{ stage: 'control', run: () => control.close() }]);
});
