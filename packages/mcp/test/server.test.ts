import {
  Client,
  InMemoryTransport,
  ProtocolError,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import {
  PermissionAuthorization,
  permissionsForRole,
  type RequestContext,
} from '@beloveddev/application/request-context';
import { ApplicationError } from '@beloveddev/application/application-error';
import { RepositoryError } from '@beloveddev/application/repository-error';
import { GetProfile } from '@beloveddev/application/use-cases/get-profile';
import { ListProjects } from '@beloveddev/application/use-cases/list-projects';
import { GetProject } from '@beloveddev/application/use-cases/get-project';
import { GetBlockers } from '@beloveddev/application/use-cases/get-blockers';
import { SearchProjectEvidence } from '@beloveddev/application/use-cases/search-project-evidence';
import { ListOpportunities } from '@beloveddev/application/use-cases/list-opportunities';
import { EvaluateOpportunity } from '@beloveddev/application/use-cases/evaluate-opportunity';
import { CreateProjectNote } from '@beloveddev/application/use-cases/create-project-note';
import { EvaluationPolicyV1 } from '@beloveddev/domain/evaluation-policy-v1';
import type {
  OpportunityListQuery,
  OpportunityPage,
  OpportunityRepository,
  EvidenceRepository,
  ProjectNoteCreationRepository,
} from '@beloveddev/application/repositories';
import type { Opportunity } from '@beloveddev/domain/entities';
import { SignedCursorCodec } from '@beloveddev/infrastructure/signed-cursor';
import { createReadFixture, fixtureId } from '@beloveddev/test-support/read-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, type InvocationLog } from '../src/server.js';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';
import {
  APPLICATION_RESPONSE_DEADLINE_MS,
  InvocationAdmission,
  MAX_SUCCESS_RESPONSE_BYTES,
} from '../src/invocation-policy.js';

function deferred<T>() {
  let done: ((value: T) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (value: T) => done?.(value),
    reject: (reason: unknown) => fail?.(reason),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function errorPayload(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected JSON error text');
  return safeErrorSchema.parse(JSON.parse(first.text));
}

describe('MCP SDK and application contracts', () => {
  let fixture: ReturnType<typeof createReadFixture>;
  let principal: RequestContext | null;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let logs: InvocationLog[];
  let useCases: {
    getProfile: GetProfile;
    listProjects: ListProjects;
    getProject: GetProject;
    getBlockers: GetBlockers;
    searchProjectEvidence: SearchProjectEvidence;
    listOpportunities: ListOpportunities;
    evaluateOpportunity: EvaluateOpportunity;
    createProjectNote: CreateProjectNote;
  };
  let opportunity: Opportunity;
  let listOpportunityPage: ReturnType<
    typeof vi.fn<(input: OpportunityListQuery) => Promise<OpportunityPage>>
  >;
  let resolve: ReturnType<typeof vi.fn<(requestId: string) => Promise<RequestContext | null>>>;
  let getOpportunityById: ReturnType<typeof vi.fn<OpportunityRepository['getById']>>;
  let evaluationSearch: ReturnType<typeof vi.fn<EvidenceRepository['search']>>;
  let createNote: ReturnType<typeof vi.fn<ProjectNoteCreationRepository['create']>>;
  let release: ReturnType<typeof vi.fn<() => void>>;
  let enter: ReturnType<typeof vi.fn<() => (() => void) | null>>;
  let admission: InvocationAdmission;

  beforeEach(async () => {
    fixture = createReadFixture();
    principal = { ...fixture.context, role: 'owner', permissions: permissionsForRole('owner') };
    logs = [];
    release = vi.fn<() => void>();
    enter = vi.fn<() => (() => void) | null>(() => release);
    admission = new InvocationAdmission({ enter });
    const authorization = new PermissionAuthorization();
    const cursors = new SignedCursorCodec('contract-test-secret-at-least-32-bytes');
    const r = fixture.repositories;
    opportunity = {
      id: fixtureId(40),
      tenantId: fixture.context.tenantId,
      source: 'upwork',
      externalId: 'private-external-id',
      title: 'TypeScript platform',
      clientName: 'Example Client',
      description: 'Private complete opportunity description',
      projectType: 'SaaS',
      budgetType: 'fixed',
      amountMin: '5000.00',
      amountMax: '9000.00',
      currency: 'USD',
      requiredSkills: ['TypeScript'],
      preferredSkills: ['PostgreSQL'],
      status: 'reviewing',
      sourceUrl: 'https://example.test/opportunities/40',
      publishedAt: new Date('2026-09-01T12:00:00Z'),
      createdAt: new Date('2026-09-01T12:00:00Z'),
      updatedAt: new Date('2026-09-01T12:00:00Z'),
    };
    listOpportunityPage = vi.fn((input) => {
      fixture.calls.push({ method: 'opportunities', input });
      return Promise.resolve({ items: [opportunity], nextPosition: null });
    });
    getOpportunityById = vi.fn((input) => {
      fixture.calls.push({ method: 'opportunity', input });
      return Promise.resolve(
        input.tenantId === opportunity.tenantId && input.opportunityId === opportunity.id
          ? opportunity
          : null,
      );
    });
    evaluationSearch = vi.fn((input) => {
      fixture.calls.push({ method: 'evaluationEvidence', input });
      return Promise.resolve({
        items: [
          {
            evidenceId: fixture.evidence.id,
            projectId: fixture.project.id,
            projectName: fixture.project.name,
            title: fixture.evidence.title,
            summary: fixture.evidence.summary,
            type: fixture.evidence.type,
            skills: ['TypeScript', 'PostgreSQL'],
            capabilities: [],
            businessOutcomes: [],
            relevanceScore: 0.75,
          },
        ],
        nextPosition: null,
      });
    });
    createNote = vi.fn((input) => {
      fixture.calls.push({ method: 'createNote', input });
      return Promise.resolve({
        note: {
          ...fixture.note,
          tenantId: input.tenantId,
          authorUserId: input.authorUserId,
          projectId: input.projectId,
          category: input.category,
          content: input.content,
          idempotencyKey: input.idempotencyKey,
        },
        created: true,
      });
    });
    useCases = {
      getProfile: new GetProfile(r.profiles, authorization),
      listProjects: new ListProjects(r.projects, authorization, cursors),
      getProject: new GetProject(r, authorization),
      getBlockers: new GetBlockers(r.blockers, authorization, cursors),
      searchProjectEvidence: new SearchProjectEvidence(r.evidence, authorization, cursors),
      listOpportunities: new ListOpportunities(
        { listPage: listOpportunityPage },
        authorization,
        cursors,
      ),
      evaluateOpportunity: new EvaluateOpportunity(
        {
          opportunities: { getById: getOpportunityById },
          profiles: r.profiles,
          evidence: { search: evaluationSearch },
        },
        authorization,
      ),
      createProjectNote: new CreateProjectNote({ create: createNote }, authorization),
    };
    resolve = vi.fn((requestId: string) =>
      Promise.resolve(principal === null ? null : { ...principal, requestId }),
    );
    server = createMcpServer({
      useCases,
      context: { resolve },
      admission,
      logger: {
        info: (record) => {
          logs.push(record);
        },
      },
    });
    client = new Client({ name: 'contract-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await client?.close();
    await server?.close();
    expect(release).toHaveBeenCalledTimes(
      enter.mock.results.filter((result) => result.type === 'return' && result.value === release)
        .length,
    );
  });

  it('shares eight slots across tools and SDK server instances, rejects immediately, and never queues', async () => {
    const profile = await useCases.getProfile.execute(principal, {});
    const projects = await useCases.listProjects.execute(principal, {});
    const profileGate = deferred<typeof profile>();
    const projectGate = deferred<typeof projects>();
    const profileCall = vi
      .spyOn(useCases.getProfile, 'execute')
      .mockReturnValue(profileGate.promise);
    const projectCall = vi
      .spyOn(useCases.listProjects, 'execute')
      .mockReturnValue(projectGate.promise);
    resolve.mockClear();
    const otherServer = createMcpServer({
      useCases,
      context: { resolve },
      admission,
      logger: { info: (record) => logs.push(record) },
    });
    const otherClient = new Client({ name: 'shared-capacity', version: '1' });
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    await otherServer.connect(serverWire);
    await otherClient.connect(clientWire);
    const running = Promise.allSettled([
      ...Array.from({ length: 4 }, () => client.callTool({ name: 'get_profile', arguments: {} })),
      ...Array.from({ length: 4 }, () =>
        otherClient.callTool({ name: 'list_projects', arguments: {} }),
      ),
    ]);
    try {
      await flush();
      expect(profileCall).toHaveBeenCalledTimes(4);
      expect(projectCall).toHaveBeenCalledTimes(4);
      const denied = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
      expect(denied.error.code).toBe('RATE_LIMITED');
      expect(resolve).toHaveBeenCalledTimes(8);
      profileGate.resolve(profile);
      projectGate.resolve(projects);
      const results = await running;
      expect(
        results.every((result) => result.status === 'fulfilled' && result.value.isError !== true),
      ).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(8); // The rejected ninth request never runs later.
      expect((await otherClient.callTool({ name: 'get_profile', arguments: {} })).isError).not.toBe(
        true,
      );
      expect(resolve).toHaveBeenCalledTimes(9);
    } finally {
      profileGate.resolve(profile);
      projectGate.resolve(projects);
      await running;
      await otherClient.close();
      await otherServer.close();
    }
  });

  it('recovers all capacity after ordinary failures without queuing rejected calls', async () => {
    const gate = deferred<Awaited<ReturnType<GetProfile['execute']>>>();
    const execute = vi.spyOn(useCases.getProfile, 'execute').mockReturnValue(gate.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const running = Promise.allSettled(
      Array.from({ length: 8 }, () => client.callTool({ name: 'get_profile', arguments: {} })),
    );
    try {
      await flush();
      expect(execute).toHaveBeenCalledTimes(8);
      expect(
        errorPayload(await client.callTool({ name: 'get_profile', arguments: {} })).error.code,
      ).toBe('RATE_LIMITED');
      expect(resolve).toHaveBeenCalledTimes(8);
      expect(execute).toHaveBeenCalledTimes(8);
      gate.reject(new ApplicationError('NOT_FOUND'));
      for (const result of await running) {
        if (result.status !== 'fulfilled') throw result.reason;
        expect(errorPayload(result.value).error.code).toBe('NOT_FOUND');
      }
      expect(vi.getTimerCount()).toBe(0);
      const recovered = await Promise.all(
        Array.from({ length: 8 }, () => client.callTool({ name: 'list_projects', arguments: {} })),
      );
      expect(recovered.every((result) => result.isError !== true)).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(16);
      expect(execute).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.reject(new ApplicationError('NOT_FOUND'));
      await running;
    }
  });

  it.each(['success', 'rejection'] as const)(
    'retains timed-out work until late %s without duplicate logs or unhandled rejection',
    async (outcome) => {
      const profile = await useCases.getProfile.execute(principal, {});
      const gate = deferred<typeof profile>();
      vi.spyOn(useCases.getProfile, 'execute').mockReturnValue(gate.promise);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const running = Promise.allSettled(
        Array.from({ length: 8 }, () => client.callTool({ name: 'get_profile', arguments: {} })),
      );
      try {
        await flush();
        await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_DEADLINE_MS - 1);
        expect(logs).toHaveLength(0);
        expect(release).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const results = await running;
        const errors = results.map((entry) => {
          if (entry.status !== 'fulfilled') throw entry.reason;
          return errorPayload(entry.value).error;
        });
        expect(errors.every((error) => error.code === 'INTERNAL_ERROR')).toBe(true);
        expect(new Set(errors.map((error) => error.requestId)).size).toBe(8);
        expect(errors.map((error) => error.requestId)).toEqual(
          resolve.mock.calls.map(([requestId]) => requestId),
        );
        expect(release).not.toHaveBeenCalled();
        const rejected = errorPayload(
          await client.callTool({ name: 'list_projects', arguments: {} }),
        );
        expect(rejected.error.code).toBe('RATE_LIMITED');
        expect(resolve).toHaveBeenCalledTimes(8);
        if (outcome === 'success') gate.resolve(profile);
        else gate.reject(new Error('private-SQL-password-connection-details'));
        await flush();
        expect(release).toHaveBeenCalledTimes(9); // Eight executions and one rejected admission.
        expect(logs).toHaveLength(9);
        expect(
          logs
            .slice(0, 8)
            .every((log) => log.resultStatus === 'error' && log.errorCategory === 'INTERNAL_ERROR'),
        ).toBe(true);
        expect(JSON.stringify(logs)).not.toContain('private-');
        expect((await client.callTool({ name: 'list_projects', arguments: {} })).isError).not.toBe(
          true,
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        gate.resolve(profile);
        await running;
        await flush();
      }
    },
  );

  it('does not initiate a use case when trusted-context resolution finishes after the deadline', async () => {
    const gate = deferred<RequestContext | null>();
    resolve.mockReturnValue(gate.promise);
    const operation = vi.spyOn(useCases.getProfile, 'execute');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = client.callTool({ name: 'get_profile', arguments: {} });
    await flush();
    await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_DEADLINE_MS);
    expect(errorPayload(await response).error.code).toBe('INTERNAL_ERROR');
    expect(release).not.toHaveBeenCalled();
    gate.resolve(principal);
    await flush();
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.actorUserId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'failure'] as const)(
    'rejects overdue %s even before the timer callback gets an event-loop turn',
    async (outcome) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      const execute = useCases.getProfile.execute.bind(useCases.getProfile);
      vi.spyOn(useCases.getProfile, 'execute').mockImplementation(async (context, input) => {
        const result = await execute(context, input);
        clock.mockReturnValue(APPLICATION_RESPONSE_DEADLINE_MS);
        if (outcome === 'failure') throw new ApplicationError('VALIDATION_ERROR');
        return result;
      });
      expect(
        errorPayload(await client.callTool({ name: 'get_profile', arguments: {} })).error.code,
      ).toBe('INTERNAL_ERROR');
      expect(release).toHaveBeenCalledTimes(1);
      expect(logs[0]?.durationMs).toBe(APPLICATION_RESPONSE_DEADLINE_MS);
    },
  );

  it('counts the entire UTF-8 success object, includes JSON escaping, and accepts exactly one MiB', async () => {
    const profile = await useCases.getProfile.execute(principal, {});
    const withSummary = (summary: string) => ({
      ...profile,
      profile: { ...profile.profile, summary },
    });
    const encoded = (summary: string) => {
      const data = toolSchemas.get_profile.output.parse({
        ...withSummary(summary),
        meta: { requestId: fixtureId(1) },
      });
      return JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      });
    };
    const prefix =
      (MAX_SUCCESS_RESPONSE_BYTES - Buffer.byteLength(encoded(''))) % 2 === 0 ? '' : '\n';
    const base = Buffer.byteLength(encoded(prefix));
    const exact = prefix + 'a'.repeat((MAX_SUCCESS_RESPONSE_BYTES - base) / 2);
    vi.spyOn(useCases.getProfile, 'execute').mockResolvedValue(withSummary(exact));
    const accepted = await client.callTool({ name: 'get_profile', arguments: {} });
    expect(accepted.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(accepted))).toBe(MAX_SUCCESS_RESPONSE_BYTES);
    for (const summary of [exact + 'a', '🚀'.repeat(150_000), '\\"\n'.repeat(100_000)]) {
      expect(Buffer.byteLength(encoded(summary))).toBeGreaterThan(MAX_SUCCESS_RESPONSE_BYTES);
      vi.spyOn(useCases.getProfile, 'execute').mockResolvedValue(withSummary(summary));
      const denied = await client.callTool({ name: 'get_profile', arguments: {} });
      expect(errorPayload(denied).error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(denied).length).toBeLessThan(1000);
    }
    expect(logs.map((log) => log.resultStatus)).toEqual(['success', 'error', 'error', 'error']);
  });

  it('advertises seven read-only tools and one idempotent mutation with strict schemas', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'get_profile',
      'list_projects',
      'get_project',
      'search_project_evidence',
      'get_blockers',
      'list_opportunities',
      'evaluate_opportunity',
      'create_project_note',
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: tool.name !== 'create_project_note',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema['additionalProperties']).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('tenantId');
      expect(tool.inputSchema.properties).not.toHaveProperty('userId');
      expect(tool.inputSchema.properties).not.toHaveProperty('membershipId');
      expect(tool.inputSchema.properties).not.toHaveProperty('role');
      expect(tool.inputSchema.properties).not.toHaveProperty('permissions');
      expect(tool.inputSchema.properties).not.toHaveProperty('relevanceScore');
      expect(tool.inputSchema.properties).not.toHaveProperty('tsquery');
      expect(tool.outputSchema).toHaveProperty('type', 'object');
    }
    const search = listed.tools.find((tool) => tool.name === 'search_project_evidence');
    expect(search?.description).toMatch(
      /prior project evidence.*PostgreSQL full-text relevance.*tenant.*read-only.*projects:read/i,
    );
    const opportunities = listed.tools.find((tool) => tool.name === 'list_opportunities');
    expect(opportunities?.description).toMatch(
      /current tenant opportunities.*exact status\/source.*case-insensitive.*makes no changes.*opportunities:read/i,
    );
    const evaluation = listed.tools.find((tool) => tool.name === 'evaluate_opportunity');
    expect(evaluation?.description).toMatch(
      /current tenant.*deterministic v1.*read-only.*opportunities:evaluate/i,
    );
    expect(evaluation?.description).toMatch(/strengths.*gaps.*risks.*recommendation/i);
    expect(Object.keys(evaluation?.inputSchema.properties ?? {})).toEqual(['opportunityId']);
    expect(evaluation?.inputSchema.properties?.['opportunityId']).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    const mutation = listed.tools.find((tool) => tool.name === 'create_project_note');
    expect(mutation?.description).toMatch(
      /current tenant.*audit.*transaction.*project_notes:create.*idempotencyKey.*created=false/i,
    );
    expect(mutation?.description).toMatch(/writes to PostgreSQL/i);
    expect(Object.keys(mutation?.inputSchema.properties ?? {})).toEqual([
      'projectId',
      'category',
      'content',
      'idempotencyKey',
    ]);
    expect(mutation?.inputSchema.required).toEqual([
      'projectId',
      'category',
      'content',
      'idempotencyKey',
    ]);
    expect(mutation?.inputSchema.properties?.['projectId']).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    expect(mutation?.inputSchema.properties?.['content']).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 10_000,
    });
    expect(mutation?.inputSchema.properties?.['idempotencyKey']).toMatchObject({
      type: 'string',
      minLength: 8,
      maxLength: 128,
    });
    expect(mutation?.outputSchema).toHaveProperty('additionalProperties', false);
  });

  it.each([
    ['get_profile', { tenantId: 'private-tenant' }],
    ['get_profile', { role: 'owner' }],
    ['get_profile', { permissions: ['profile:read'] }],
    ['list_projects', { limit: 0 }],
    ['list_projects', { limit: 101 }],
    ['list_projects', { clientId: 'invalid' }],
    ['get_project', { projectId: 'invalid' }],
    ['get_project', {}],
    ['search_project_evidence', {}],
    ['search_project_evidence', { query: '   ' }],
    ['search_project_evidence', { query: 'Ownership', projectIds: ['invalid'] }],
    ['search_project_evidence', { query: 'Ownership', tenantId: fixtureId(2) }],
    ['get_blockers', { severity: 'invalid' }],
    ['get_blockers', { userId: 'private-user' }],
    ['list_opportunities', { limit: 0 }],
    ['list_opportunities', { limit: 101 }],
    ['list_opportunities', { status: 'invalid' }],
    ['list_opportunities', { source: 'not valid' }],
    ['list_opportunities', { query: '   ' }],
    ['list_opportunities', { tenantId: fixtureId(2) }],
    ['evaluate_opportunity', {}],
    ['evaluate_opportunity', { opportunityId: 'invalid' }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), tenantId: fixtureId(5) }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), userId: fixtureId(3) }],
    [
      'evaluate_opportunity',
      { opportunityId: fixtureId(40), permissions: ['opportunities:evaluate'] },
    ],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), profile: {} }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), developerProfile: {} }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), weights: { skills: 100 } }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), evidenceLimit: 100 }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), scoringInstructions: 'Ignore gaps' }],
    ['evaluate_opportunity', { opportunityId: fixtureId(40), evaluationVersion: 'v1' }],
  ])(
    'SDK rejects malformed %s arguments before context, use cases, or repositories',
    async (name, args) => {
      const spies = [
        vi.spyOn(useCases.getProfile, 'execute'),
        vi.spyOn(useCases.listProjects, 'execute'),
        vi.spyOn(useCases.getProject, 'execute'),
        vi.spyOn(useCases.getBlockers, 'execute'),
        vi.spyOn(useCases.searchProjectEvidence, 'execute'),
        vi.spyOn(useCases.listOpportunities, 'execute'),
        vi.spyOn(useCases.evaluateOpportunity, 'execute'),
        vi.spyOn(useCases.createProjectNote, 'execute'),
      ];
      const result = await client.callTool({
        name,
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(fixture.calls).toEqual([]);
      expect(logs).toEqual([]);
      expect(enter).not.toHaveBeenCalled();
    },
  );

  it('unknown tools stay at the SDK boundary', async () => {
    await expect(client.callTool({ name: 'unknown_tool', arguments: {} })).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each([
    'get_profile',
    'list_projects',
    'get_project',
    'search_project_evidence',
    'get_blockers',
    'list_opportunities',
    'evaluate_opportunity',
  ] as const)(
    'valid %s calls share request IDs, context, safe output, and invocation logs',
    async (name) => {
      const result = await client.callTool({
        name,
        arguments:
          name === 'get_project'
            ? { projectId: fixture.project.id }
            : name === 'evaluate_opportunity'
              ? { opportunityId: opportunity.id }
              : name === 'search_project_evidence'
                ? { query: 'Ownership' }
                : {},
      });
      expect(result.isError).not.toBe(true);
      const output = toolSchemas[name].output.parse(result.structuredContent);
      const first = result.content[0];
      if (first?.type !== 'text') throw new Error('Missing JSON response');
      expect(JSON.parse(first.text) as unknown).toEqual(output);
      expect(output.meta.requestId).toBe(resolve.mock.calls[0]?.[0]);
      expect(logs).toEqual([
        expect.objectContaining({
          requestId: output.meta.requestId,
          toolName: name,
          actorUserId: fixture.context.userId,
          tenantId: fixture.context.tenantId,
          resultStatus: 'success',
        }),
      ]);
      expect(logs[0]?.durationMs).toBeTypeOf('number');
      expect(fixture.calls.length).toBeGreaterThan(0);
      expect(first.text).not.toContain('tenantId');
      expect(first.text).not.toContain('idempotencyKey');
      expect(enter).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'get_profile',
    'list_projects',
    'get_project',
    'search_project_evidence',
    'get_blockers',
    'list_opportunities',
    'evaluate_opportunity',
  ] as const)('%s rejects missing principal before protected repository work', async (name) => {
    principal = null;
    const result = await client.callTool({
      name,
      arguments:
        name === 'get_project'
          ? { projectId: fixture.project.id }
          : name === 'evaluate_opportunity'
            ? { opportunityId: opportunity.id }
            : name === 'search_project_evidence'
              ? { query: 'Ownership' }
              : {},
    });
    const payload = errorPayload(result);
    expect(payload.error.code).toBe('UNAUTHENTICATED');
    expect(payload.error.requestId).toBe(logs[0]?.requestId);
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    'get_profile',
    'list_projects',
    'get_project',
    'search_project_evidence',
    'get_blockers',
    'list_opportunities',
    'evaluate_opportunity',
  ] as const)('%s requires its permission before repository work', async (name) => {
    principal = {
      ...fixture.context,
      permissions: name === 'get_profile' ? ['projects:read'] : ['profile:read'],
    };
    const payload = errorPayload(
      await client.callTool({
        name,
        arguments:
          name === 'get_project'
            ? { projectId: fixture.project.id }
            : name === 'evaluate_opportunity'
              ? { opportunityId: opportunity.id }
              : name === 'search_project_evidence'
                ? { query: 'Ownership' }
                : {},
      }),
    );
    expect(payload.error.code).toBe('FORBIDDEN');
    expect(logs[0]).toMatchObject({
      resultStatus: 'error',
      errorCategory: 'FORBIDDEN',
      requestId: payload.error.requestId,
    });
    expect(fixture.calls).toEqual([]);
  });

  function noteInput() {
    return {
      projectId: fixture.project.id,
      category: 'technical' as const,
      content: '  MCP_NOTE_SENSITIVE client context 🚀\n  code  ',
      idempotencyKey: 'mcp-note-key-001',
    };
  }

  it.each([
    { projectId: 'invalid' },
    { category: 'invalid' },
    { content: '' },
    { content: ' \n\t' },
    { content: 'x'.repeat(10_001) },
    { content: 'invalid\0text' },
    { content: 'invalid\uD800text' },
    { idempotencyKey: 'short' },
    { idempotencyKey: ' '.repeat(8) },
    { idempotencyKey: 'x'.repeat(129) },
    { idempotencyKey: 'invalid\0key' },
    { idempotencyKey: 'invalid\uDFFFkey' },
    { tenantId: fixtureId(99) },
    { authorUserId: fixtureId(99) },
    { userId: fixtureId(99) },
    { membershipId: fixtureId(99) },
    { requestId: fixtureId(99) },
    { role: 'owner' },
    { permissions: ['project_notes:create'] },
    { audit: { action: 'project_note.created' } },
    { createdAt: '2026-01-01T00:00:00Z' },
    { noteId: fixtureId(99) },
  ])('SDK rejects malformed mutation input before invocation: %j', async (change) => {
    const execute = vi.spyOn(useCases.createProjectNote, 'execute');
    const result = await client.callTool({
      name: 'create_project_note',
      arguments: { ...noteInput(), ...change },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each(['projectId', 'category', 'content', 'idempotencyKey'] as const)(
    'SDK requires mutation %s',
    async (field) => {
      const args: Record<string, unknown> = noteInput();
      delete args[field];
      const result = await client.callTool({ name: 'create_project_note', arguments: args });
      expect(result.isError).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(createNote).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it.each(['owner', 'member'] as const)(
    'invokes note creation with trusted %s context and safe logs',
    async (role) => {
      const trusted = { ...fixture.context, role, permissions: permissionsForRole(role) };
      principal = trusted;
      const execute = vi.spyOn(useCases.createProjectNote, 'execute');
      const args = noteInput();
      const result = await client.callTool({ name: 'create_project_note', arguments: args });
      const output = toolSchemas.create_project_note.output.parse(result.structuredContent);
      expect(result.isError).not.toBe(true);
      expect(output).toEqual({
        note: {
          id: fixture.note.id,
          projectId: args.projectId,
          category: args.category,
          content: args.content,
          createdAt: fixture.note.createdAt.toISOString(),
        },
        created: true,
        meta: { requestId: resolve.mock.calls[0]?.[0] },
      });
      const first = result.content[0];
      if (first?.type !== 'text') throw new Error('Expected note JSON response');
      expect(JSON.parse(first.text)).toEqual(output);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        { ...trusted, requestId: output.meta.requestId },
        args,
      );
      expect(createNote).toHaveBeenCalledExactlyOnceWith({
        ...args,
        tenantId: trusted.tenantId,
        authorUserId: trusted.userId,
        requestId: output.meta.requestId,
      });
      expect(Object.keys(output.note).sort()).toEqual(
        ['id', 'projectId', 'category', 'content', 'createdAt'].sort(),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'mcp.invocation',
        requestId: output.meta.requestId,
        toolName: 'create_project_note',
        actorUserId: trusted.userId,
        tenantId: trusted.tenantId,
        resultStatus: 'success',
      });
      expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(logs[0]).not.toHaveProperty('errorCategory');
      expect(JSON.stringify(logs)).not.toContain('MCP_NOTE_SENSITIVE');
      expect(JSON.stringify(logs)).not.toContain(args.idempotencyKey);
    },
  );

  it.each(['missing', 'viewer', 'without permission'] as const)(
    'denies mutation for %s context before repository work',
    async (kind) => {
      principal =
        kind === 'missing'
          ? null
          : {
              ...fixture.context,
              role: kind === 'viewer' ? 'viewer' : 'owner',
              permissions: kind === 'viewer' ? permissionsForRole('viewer') : ['projects:read'],
            };
      const payload = errorPayload(
        await client.callTool({ name: 'create_project_note', arguments: noteInput() }),
      );
      const code = kind === 'missing' ? 'UNAUTHENTICATED' : 'FORBIDDEN';
      expect(payload.error.code).toBe(code);
      expect(logs[0]).toMatchObject({
        requestId: payload.error.requestId,
        toolName: 'create_project_note',
        errorCategory: code,
        resultStatus: 'error',
      });
      expect(createNote).not.toHaveBeenCalled();
      expect(fixture.calls).toEqual([]);
    },
  );

  it('preserves the original retry result while generating fresh invocation metadata', async () => {
    const args = noteInput();
    const first = toolSchemas.create_project_note.output.parse(
      (await client.callTool({ name: 'create_project_note', arguments: args })).structuredContent,
    );
    createNote.mockResolvedValueOnce({
      note: {
        ...fixture.note,
        projectId: args.projectId,
        content: args.content,
        category: args.category,
      },
      created: false,
    });
    const retry = toolSchemas.create_project_note.output.parse(
      (await client.callTool({ name: 'create_project_note', arguments: args })).structuredContent,
    );
    expect(retry.note).toEqual(first.note);
    expect(retry.created).toBe(false);
    expect(retry.meta.requestId).not.toBe(first.meta.requestId);
    expect(logs.map(({ requestId }) => requestId)).toEqual([
      first.meta.requestId,
      retry.meta.requestId,
    ]);
  });

  it.each(['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR'] as const)(
    'maps mutation %s to a safe application envelope without success content',
    async (code) => {
      if (code === 'NOT_FOUND') createNote.mockResolvedValueOnce(null);
      else if (code === 'CONFLICT')
        createNote.mockRejectedValueOnce(new RepositoryError('CONFLICT'));
      else if (code === 'VALIDATION_ERROR')
        vi.spyOn(useCases.createProjectNote, 'execute').mockRejectedValueOnce(
          new ApplicationError('VALIDATION_ERROR'),
        );
      else
        createNote.mockRejectedValueOnce(
          new Error('SQL password=private-db-secret C:\\private\\database'),
        );
      const result = await client.callTool({ name: 'create_project_note', arguments: noteInput() });
      const payload = errorPayload(result);
      expect(payload.error.code).toBe(code);
      expect(logs[0]).toMatchObject({
        requestId: payload.error.requestId,
        toolName: 'create_project_note',
        resultStatus: 'error',
        errorCategory: code,
      });
      expect(JSON.stringify({ result, logs })).not.toMatch(
        /private-db-secret|private\\\\database|MCP_NOTE_SENSITIVE|mcp-note-key-001/,
      );
    },
  );

  it('maps a mutation context-provider failure without accessing the write port', async () => {
    resolve.mockRejectedValueOnce(new Error('private identity provider failure'));
    const payload = errorPayload(
      await client.callTool({ name: 'create_project_note', arguments: noteInput() }),
    );
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.requestId).toBe(logs[0]?.requestId);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('rejects malformed mutation output and keeps internal note fields private', async () => {
    const result = await useCases.createProjectNote.execute(principal, noteInput());
    const valid = { ...result, meta: { requestId: fixtureId(1) } };
    const schema = toolSchemas.create_project_note.output;
    for (const output of [
      { ...valid, created: 'true' },
      { note: valid.note, meta: valid.meta },
      { ...valid, note: { ...valid.note, id: 'invalid' } },
      { ...valid, note: { ...valid.note, projectId: 'invalid' } },
      { ...valid, note: { ...valid.note, category: 'invalid' } },
      { ...valid, note: { ...valid.note, content: '' } },
      { ...valid, note: { ...valid.note, content: 'x'.repeat(10_001) } },
      { ...valid, note: { ...valid.note, createdAt: 'invalid' } },
      { ...valid, note: { ...valid.note, tenantId: fixture.context.tenantId } },
      { ...valid, note: { ...valid.note, authorUserId: fixture.context.userId } },
      { ...valid, note: { ...valid.note, idempotencyKey: 'private-key' } },
      { ...valid, tenantId: fixture.context.tenantId },
      { ...valid, meta: { requestId: 'invalid' } },
    ])
      expect(schema.safeParse(output).success).toBe(false);
    const internal = { ...result, note: { ...result.note, authorUserId: fixture.context.userId } };
    vi.spyOn(useCases.createProjectNote, 'execute').mockResolvedValueOnce(internal);
    const payload = errorPayload(
      await client.callTool({ name: 'create_project_note', arguments: noteInput() }),
    );
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.requestId).toBe(logs.at(-1)?.requestId);
  });

  it('get_profile returns NOT_FOUND without exposing foreign profiles', async () => {
    fixture.data.profiles.splice(0, 1);
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(fixture.calls).toEqual([
      { method: 'profile', input: { tenantId: fixture.context.tenantId } },
    ]);
  });

  it.each(['owner', 'member'] as const)(
    'evaluates through the shared boundary for %s',
    async (role) => {
      principal = { ...fixture.context, role, permissions: permissionsForRole(role) };
      const result = await client.callTool({
        name: 'evaluate_opportunity',
        arguments: { opportunityId: opportunity.id },
      });
      const output = toolSchemas.evaluate_opportunity.output.parse(result.structuredContent);
      expect(result.isError).not.toBe(true);
      const { meta, ...evaluation } = output;
      expect(evaluation).toEqual(
        new EvaluationPolicyV1().evaluate({
          profile: fixture.profile,
          opportunity,
          evidence: [
            {
              projectId: fixture.project.id,
              projectName: fixture.project.name,
              evidenceId: fixture.evidence.id,
              title: fixture.evidence.title,
              summary: fixture.evidence.summary,
              skills: ['TypeScript', 'PostgreSQL'],
              relevanceScore: 0.75,
            },
          ],
          evidenceRetrievalIncomplete: false,
        }),
      );
      expect(getOpportunityById).toHaveBeenCalledWith({
        tenantId: fixture.context.tenantId,
        opportunityId: opportunity.id,
      });
      expect(evaluationSearch).toHaveBeenCalledWith({
        tenantId: fixture.context.tenantId,
        query: '"typescript" OR "postgresql"',
        limit: 10,
      });
      expect(output.evaluationVersion).toBe('v1');
      expect(output.scores.budget).toBeNull();
      expect(logs[0]).toMatchObject({
        requestId: meta.requestId,
        toolName: 'evaluate_opportunity',
        resultStatus: 'success',
      });
      expect(JSON.stringify(logs)).not.toContain(opportunity.description);
      expect(JSON.stringify(logs)).not.toContain('Composite references');
      const again = toolSchemas.evaluate_opportunity.output.parse(
        (
          await client.callTool({
            name: 'evaluate_opportunity',
            arguments: { opportunityId: opportunity.id },
          })
        ).structuredContent,
      );
      expect(again.meta.requestId).not.toBe(meta.requestId);
      expect({ ...again, meta }).toEqual(output);
    },
  );

  it('preserves skill gaps, strengths, and concerns in the public evaluation result', async () => {
    opportunity = { ...opportunity, requiredSkills: ['TypeScript', 'Rust'] };
    const result = await client.callTool({
      name: 'evaluate_opportunity',
      arguments: { opportunityId: opportunity.id },
    });
    const output = toolSchemas.evaluate_opportunity.output.parse(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(output.matchedSkills).toEqual(['typescript']);
    expect(output.missingSkills).toEqual(['rust']);
    expect(output.strengths).toContainEqual({
      code: 'preferred_project_type',
      message: 'The opportunity matches a preferred project type.',
    });
    expect(output.concerns).toContainEqual({
      code: 'missing_required_skills',
      message: 'Missing required skills: rust.',
    });
    expect(output.concerns.map(({ code }) => code)).toContain('budget_not_comparable');
    expect(output.relevantEvidence).toEqual([
      {
        projectId: fixture.project.id,
        projectName: fixture.project.name,
        evidenceId: fixture.evidence.id,
        title: fixture.evidence.title,
        summary: fixture.evidence.summary,
        relevanceScore: 0.75,
      },
    ]);
  });

  it('accepts all domain recommendations and the ten-record evidence boundary', async () => {
    const result = await useCases.evaluateOpportunity.execute(principal, {
      opportunityId: opportunity.id,
    });
    const schema = toolSchemas.evaluate_opportunity.output;
    for (const recommendation of ['strong_match', 'good_match', 'review', 'weak_match', 'skip']) {
      expect(
        schema.safeParse({
          ...result,
          fit: { ...result.fit, recommendation },
          meta: { requestId: fixtureId(1) },
        }).success,
      ).toBe(true);
    }
    const bounded = schema.parse({
      ...result,
      relevantEvidence: Array.from({ length: 10 }, () => result.relevantEvidence[0]),
      meta: { requestId: fixtureId(1) },
    });
    expect(bounded.relevantEvidence).toHaveLength(10);
  });

  it('denies a viewer before opportunity, profile, or evidence access', async () => {
    principal = { ...fixture.context, role: 'viewer', permissions: permissionsForRole('viewer') };
    const payload = errorPayload(
      await client.callTool({
        name: 'evaluate_opportunity',
        arguments: { opportunityId: opportunity.id },
      }),
    );
    expect(payload.error.code).toBe('FORBIDDEN');
    expect(logs[0]).toMatchObject({
      requestId: payload.error.requestId,
      errorCategory: 'FORBIDDEN',
      toolName: 'evaluate_opportunity',
    });
    expect(fixture.calls).toEqual([]);
    expect(getOpportunityById).not.toHaveBeenCalled();
    expect(evaluationSearch).not.toHaveBeenCalled();
  });

  it('maps foreign and unknown opportunity IDs to identical safe NOT_FOUND errors', async () => {
    opportunity = { ...opportunity, tenantId: fixture.otherContext.tenantId };
    for (const opportunityId of [opportunity.id, fixtureId(999)]) {
      const payload = errorPayload(
        await client.callTool({ name: 'evaluate_opportunity', arguments: { opportunityId } }),
      );
      expect(payload.error.code).toBe('NOT_FOUND');
      expect(payload.error.message).toBe('The requested resource was not found.');
      expect(payload.error.requestId).toBe(logs.at(-1)?.requestId);
    }
    expect(fixture.calls.map(({ method }) => method)).toEqual(['opportunity', 'opportunity']);
    expect(evaluationSearch).not.toHaveBeenCalled();
  });

  it('maps a missing tenant profile to safe NOT_FOUND before evidence work', async () => {
    fixture.data.profiles.splice(0, 1);
    const payload = errorPayload(
      await client.callTool({
        name: 'evaluate_opportunity',
        arguments: { opportunityId: opportunity.id },
      }),
    );
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(evaluationSearch).not.toHaveBeenCalled();
  });

  it.each(['opportunity', 'profile', 'evidence'] as const)(
    'safely maps evaluation %s infrastructure failures',
    async (stage) => {
      const failure = new Error('SQL password=private-secret C:\\private\\database');
      if (stage === 'opportunity') getOpportunityById.mockRejectedValueOnce(failure);
      else if (stage === 'profile')
        vi.spyOn(fixture.repositories.profiles, 'getByTenant').mockRejectedValueOnce(failure);
      else evaluationSearch.mockRejectedValueOnce(failure);
      const payload = errorPayload(
        await client.callTool({
          name: 'evaluate_opportunity',
          arguments: { opportunityId: opportunity.id },
        }),
      );
      expect(payload.error.code).toBe('INTERNAL_ERROR');
      expect(logs[0]).toMatchObject({
        requestId: payload.error.requestId,
        resultStatus: 'error',
        errorCategory: 'INTERNAL_ERROR',
      });
      expect(JSON.stringify({ payload, logs })).not.toContain('private-secret');
      expect(JSON.stringify({ payload, logs })).not.toContain('database');
    },
  );

  it('validates nullable evaluation dimensions and partial-retrieval findings', async () => {
    opportunity = { ...opportunity, requiredSkills: [], preferredSkills: [], projectType: null };
    const output = toolSchemas.evaluate_opportunity.output.parse(
      (
        await client.callTool({
          name: 'evaluate_opportunity',
          arguments: { opportunityId: opportunity.id },
        })
      ).structuredContent,
    );
    expect(output.scores).toEqual({
      skills: null,
      projectType: null,
      budget: null,
      experienceEvidence: null,
    });
    expect(output.fit).toEqual({ overallScore: 50, recommendation: 'review' });
    expect(output.riskFlags.map(({ code }) => code)).toContain('insufficient_evaluation_signals');
    opportunity = { ...opportunity, requiredSkills: ['x'.repeat(1001)] };
    const partial = toolSchemas.evaluate_opportunity.output.parse(
      (
        await client.callTool({
          name: 'evaluate_opportunity',
          arguments: { opportunityId: opportunity.id },
        })
      ).structuredContent,
    );
    expect(partial.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
    expect(partial.riskFlags.map(({ code }) => code)).not.toContain('no_portfolio_evidence');
  });

  it('rejects malformed evaluation success results at every output boundary', async () => {
    const result = await useCases.evaluateOpportunity.execute(principal, {
      opportunityId: opportunity.id,
    });
    const valid = { ...result, meta: { requestId: fixtureId(1) } };
    const schema = toolSchemas.evaluate_opportunity.output;
    const evidence = valid.relevantEvidence[0];
    if (evidence === undefined) throw new Error('Expected evidence fixture');
    for (const output of [
      { ...valid, tenantId: fixture.context.tenantId },
      { ...valid, opportunity: { ...valid.opportunity, tenantId: fixture.context.tenantId } },
      { ...valid, fit: { overallScore: 101, recommendation: 'strong_match' } },
      { ...valid, fit: { overallScore: 50.5, recommendation: 'review' } },
      { ...valid, fit: { ...valid.fit, recommendation: 'invented' } },
      { ...valid, scores: { ...valid.scores, budget: 50 } },
      { ...valid, scores: { ...valid.scores, skills: -1 } },
      { ...valid, evaluationVersion: 'v2' },
      { ...valid, strengths: [{ code: 'invented', message: 'invalid' }] },
      { ...valid, concerns: [{ code: 'invented', message: 'invalid' }] },
      { ...valid, riskFlags: [{ code: 'invented', message: 'invalid' }] },
      { ...valid, relevantEvidence: [{ ...evidence, skills: ['private'] }] },
      { ...valid, relevantEvidence: [{ ...evidence, relevanceScore: -1 }] },
      { ...valid, relevantEvidence: [{ ...evidence, relevanceScore: Number.NaN }] },
      {
        ...valid,
        relevantEvidence: [{ ...evidence, relevanceScore: Number.POSITIVE_INFINITY }],
      },
      {
        ...valid,
        strengths: [{ code: 'preferred_project_type', message: 'invalid', extra: true }],
      },
      {
        ...valid,
        relevantEvidence: Array.from({ length: 11 }, () => ({
          projectId: fixture.project.id,
          projectName: 'project',
          evidenceId: fixture.evidence.id,
          title: 'title',
          summary: 'summary',
          relevanceScore: 0.5,
        })),
      },
      {
        ...valid,
        relevantEvidence: [
          {
            projectId: fixture.project.id,
            projectName: 'project',
            evidenceId: 'invalid',
            title: 'title',
            summary: 'summary',
            relevanceScore: Number.POSITIVE_INFINITY,
          },
        ],
      },
    ])
      expect(schema.safeParse(output).success).toBe(false);
    vi.spyOn(useCases.evaluateOpportunity, 'execute').mockResolvedValue({
      ...result,
      fit: { ...result.fit, overallScore: 101 },
    });
    const payload = errorPayload(
      await client.callTool({
        name: 'evaluate_opportunity',
        arguments: { opportunityId: opportunity.id },
      }),
    );
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(logs.at(-1)?.errorCategory).toBe('INTERNAL_ERROR');
  });

  it('lists projects with defaults, filters, tenant scope, and signed continuation', async () => {
    fixture.data.projects.push({ ...fixture.project, id: fixtureId(20), slug: 'second' });
    const first = toolSchemas.list_projects.output.parse(
      (
        await client.callTool({
          name: 'list_projects',
          arguments: {
            limit: 1,
            status: 'active',
            clientId: fixture.client.id,
            query: 'Portfolio',
          },
        })
      ).structuredContent,
    );
    expect(first.projects.map((p) => p.id)).toEqual([fixture.project.id]);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = toolSchemas.list_projects.output.parse(
      (
        await client.callTool({
          name: 'list_projects',
          arguments: {
            limit: 1,
            status: 'active',
            clientId: fixture.client.id,
            query: 'Portfolio',
            cursor: first.nextCursor,
          },
        })
      ).structuredContent,
    );
    expect(second.projects.map((p) => p.id)).toEqual([fixtureId(20)]);
    expect(second.nextCursor).toBeUndefined();
    const defaults = toolSchemas.list_projects.output.parse(
      (await client.callTool({ name: 'list_projects', arguments: {} })).structuredContent,
    );
    expect(defaults.projects).toHaveLength(2);
    expect(fixture.calls.at(-1)).toEqual({
      method: 'projects',
      input: { tenantId: fixture.context.tenantId, limit: 20 },
    });
  });

  it('lists opportunities with strict output, trusted tenant scope, filters, and signed continuation', async () => {
    const secondOpportunity: Opportunity = {
      ...opportunity,
      id: fixtureId(41),
      title: 'Second TypeScript platform',
      publishedAt: new Date('2026-08-01T12:00:00Z'),
    };
    listOpportunityPage
      .mockResolvedValueOnce({
        items: [opportunity],
        nextPosition: {
          id: opportunity.id,
          orderingTimestamp: '2026-09-01T12:00:00.000000Z',
        },
      })
      .mockResolvedValueOnce({ items: [secondOpportunity], nextPosition: null });
    const argumentsWithoutCursor = {
      status: 'reviewing',
      source: ' UPWORK ',
      query: ' TYPESCRIPT ',
      limit: 1,
    } as const;
    const first = toolSchemas.list_opportunities.output.parse(
      (
        await client.callTool({
          name: 'list_opportunities',
          arguments: argumentsWithoutCursor,
        })
      ).structuredContent,
    );
    expect(first.opportunities).toEqual([
      {
        id: opportunity.id,
        source: 'upwork',
        title: opportunity.title,
        clientName: opportunity.clientName,
        projectType: opportunity.projectType,
        budgetType: opportunity.budgetType,
        amountMin: opportunity.amountMin,
        amountMax: opportunity.amountMax,
        currency: opportunity.currency,
        requiredSkills: opportunity.requiredSkills,
        preferredSkills: opportunity.preferredSkills,
        status: opportunity.status,
        sourceUrl: opportunity.sourceUrl,
        publishedAt: opportunity.publishedAt?.toISOString(),
      },
    ]);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(first.opportunities[0]).not.toHaveProperty('tenantId');
    expect(first.opportunities[0]).not.toHaveProperty('externalId');
    expect(first.opportunities[0]).not.toHaveProperty('description');
    expect(listOpportunityPage).toHaveBeenNthCalledWith(1, {
      tenantId: fixture.context.tenantId,
      status: 'reviewing',
      source: 'upwork',
      query: 'typescript',
      limit: 1,
    });

    const second = toolSchemas.list_opportunities.output.parse(
      (
        await client.callTool({
          name: 'list_opportunities',
          arguments: { ...argumentsWithoutCursor, cursor: first.nextCursor },
        })
      ).structuredContent,
    );
    expect(second.opportunities.map((row) => row.id)).toEqual([secondOpportunity.id]);
    expect(second.nextCursor).toBeUndefined();
    expect(listOpportunityPage.mock.calls[1]?.[0]).toMatchObject({
      tenantId: fixture.context.tenantId,
      status: 'reviewing',
      source: 'upwork',
      query: 'typescript',
      limit: 1,
      after: {
        id: opportunity.id,
        orderingTimestamp: '2026-09-01T12:00:00.000000Z',
      },
    });

    await expect(
      client.callTool({
        name: 'list_opportunities',
        arguments: { ...argumentsWithoutCursor, query: 'different', cursor: first.nextCursor },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(listOpportunityPage).toHaveBeenCalledTimes(2);
  });

  it('searches evidence through the use case with structured filters and signed pagination', async () => {
    fixture.data.evidence[0] = {
      ...fixture.evidence,
      skills: ['PostgreSQL'],
      capabilities: ['Tenant isolation'],
      businessOutcomes: ['Reliable delivery'],
    };
    fixture.data.evidence.push({
      ...fixture.data.evidence[0],
      id: fixtureId(20),
      title: 'Ownership patterns',
    });
    const argumentsWithoutCursor = {
      query: 'Ownership',
      projectIds: [fixture.project.id],
      evidenceTypes: ['architecture'],
      skills: ['PostgreSQL'],
      limit: 1,
    };
    const first = toolSchemas.search_project_evidence.output.parse(
      (
        await client.callTool({
          name: 'search_project_evidence',
          arguments: argumentsWithoutCursor,
        })
      ).structuredContent,
    );
    expect(first.results).toEqual([
      {
        evidenceId: fixture.evidence.id,
        projectId: fixture.project.id,
        projectName: fixture.project.name,
        type: 'architecture',
        title: fixture.evidence.title,
        summary: fixture.evidence.summary,
        skills: ['PostgreSQL'],
        capabilities: ['Tenant isolation'],
        businessOutcomes: ['Reliable delivery'],
        relevanceScore: 1,
      },
    ]);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(first.results[0]).not.toHaveProperty('searchVector');
    expect(first.results[0]).not.toHaveProperty('queryFingerprint');
    expect(fixture.calls[0]).toEqual({
      method: 'evidenceSearch',
      input: {
        tenantId: fixture.context.tenantId,
        query: 'Ownership',
        projectIds: [fixture.project.id],
        evidenceTypes: ['architecture'],
        skills: ['postgresql'],
        limit: 1,
      },
    });

    const second = toolSchemas.search_project_evidence.output.parse(
      (
        await client.callTool({
          name: 'search_project_evidence',
          arguments: { ...argumentsWithoutCursor, cursor: first.nextCursor },
        })
      ).structuredContent,
    );
    expect(second.results.map((result) => result.evidenceId)).toEqual([fixtureId(20)]);
    expect(second.nextCursor).toBeUndefined();

    const foreign = toolSchemas.search_project_evidence.output.parse(
      (
        await client.callTool({
          name: 'search_project_evidence',
          arguments: { query: 'Ownership', projectIds: [fixture.otherProject.id] },
        })
      ).structuredContent,
    );
    expect(foreign.results).toEqual([]);
    expect(foreign.nextCursor).toBeUndefined();
  });

  it.each([
    'list_projects',
    'search_project_evidence',
    'get_blockers',
    'list_opportunities',
  ] as const)(
    '%s rejects malformed cursors as application errors without repository access',
    async (name) => {
      const payload = errorPayload(
        await client.callTool({
          name,
          arguments:
            name === 'search_project_evidence'
              ? { query: 'Ownership', cursor: 'malformed' }
              : { cursor: 'malformed' },
        }),
      );
      expect(payload.error.code).toBe('VALIDATION_ERROR');
      expect(logs[0]?.requestId).toBe(payload.error.requestId);
      expect(fixture.calls).toEqual([]);
    },
  );

  it('get_project returns a bounded aggregate and excludes internal fields', async () => {
    for (let i = 0; i < 30; i++) {
      fixture.data.evidence.push({ ...fixture.evidence, id: fixtureId(100 + i) });
      fixture.data.blockers.push({ ...fixture.blocker, id: fixtureId(200 + i) });
      fixture.data.notes.push({ ...fixture.note, id: fixtureId(300 + i) });
    }
    const result = await client.callTool({
      name: 'get_project',
      arguments: { projectId: fixture.project.id },
    });
    const output = toolSchemas.get_project.output.parse(result.structuredContent);
    expect(output.client).toEqual({ id: fixture.client.id, name: fixture.client.name });
    expect(output.evidenceSummary).toHaveLength(20);
    expect(output.openBlockers).toHaveLength(20);
    expect(output.recentNotes).toHaveLength(10);
    expect(output.evidenceSummary[0]).not.toHaveProperty('details');
    expect(output.recentNotes[0]).not.toHaveProperty('authorUserId');
  });

  it('get_project handles a project without a client', async () => {
    fixture.data.projects[0] = { ...fixture.project, clientId: null };
    const output = toolSchemas.get_project.output.parse(
      (await client.callTool({ name: 'get_project', arguments: { projectId: fixture.project.id } }))
        .structuredContent,
    );
    expect(output.client).toBeNull();
    expect(fixture.calls.some((call) => call.method === 'client')).toBe(false);
  });

  it('cross-tenant and missing projects produce identical NOT_FOUND categories and messages', async () => {
    const foreign = errorPayload(
      await client.callTool({
        name: 'get_project',
        arguments: { projectId: fixture.otherProject.id },
      }),
    );
    const missing = errorPayload(
      await client.callTool({ name: 'get_project', arguments: { projectId: fixtureId(999) } }),
    );
    expect(foreign.error.code).toBe('NOT_FOUND');
    expect(missing.error.code).toBe(foreign.error.code);
    expect(missing.error.message).toBe(foreign.error.message);
    expect(fixture.calls.map((call) => call.method)).toEqual(['project', 'project']);
  });

  it('get_blockers combines tenant/project/severity scope, open-only default, and pagination', async () => {
    fixture.data.blockers.push(
      { ...fixture.blocker, id: fixtureId(21) },
      { ...fixture.blocker, id: fixtureId(22), severity: 'low' },
      { ...fixture.blocker, id: fixtureId(23), status: 'resolved', resolvedAt: new Date() },
      {
        ...fixture.blocker,
        id: fixtureId(24),
        tenantId: fixture.otherContext.tenantId,
        projectId: fixture.otherProject.id,
      },
    );
    const args = { projectId: fixture.project.id, severity: 'high', limit: 1 };
    const first = toolSchemas.get_blockers.output.parse(
      (await client.callTool({ name: 'get_blockers', arguments: args })).structuredContent,
    );
    expect(first.blockers.map((row) => row.id)).toEqual([fixture.blocker.id]);
    const second = toolSchemas.get_blockers.output.parse(
      (
        await client.callTool({
          name: 'get_blockers',
          arguments: { ...args, cursor: first.nextCursor },
        })
      ).structuredContent,
    );
    expect(second.blockers.map((row) => row.id)).toEqual([fixtureId(21)]);
    expect(second.nextCursor).toBeUndefined();
    const all = toolSchemas.get_blockers.output.parse(
      (await client.callTool({ name: 'get_blockers', arguments: {} })).structuredContent,
    );
    expect(all.blockers).toHaveLength(3);
    const foreign = toolSchemas.get_blockers.output.parse(
      (
        await client.callTool({
          name: 'get_blockers',
          arguments: { projectId: fixture.otherProject.id },
        })
      ).structuredContent,
    );
    expect(foreign.blockers).toEqual([]);
  });

  it.each([new RepositoryError('UNAVAILABLE'), new Error('private SQL /internal/path')])(
    'infrastructure errors never leak raw detail',
    async (failure) => {
      vi.spyOn(fixture.repositories.profiles, 'getByTenant').mockRejectedValue(failure);
      const result = await client.callTool({ name: 'get_profile', arguments: {} });
      expect(errorPayload(result).error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result)).not.toMatch(/private SQL|internal\/path|stack|cause/);
    },
  );

  it('search infrastructure failures use the shared safe INTERNAL_ERROR envelope', async () => {
    vi.spyOn(fixture.repositories.evidence, 'search').mockRejectedValue(
      new RepositoryError('UNAVAILABLE'),
    );
    const result = await client.callTool({
      name: 'search_project_evidence',
      arguments: { query: 'Ownership' },
    });
    const payload = errorPayload(result);
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(logs[0]).toMatchObject({
      toolName: 'search_project_evidence',
      requestId: payload.error.requestId,
      resultStatus: 'error',
      errorCategory: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(result)).not.toMatch(/postgres|stack|cause/i);
  });

  it('opportunity infrastructure failures use the shared safe INTERNAL_ERROR envelope', async () => {
    listOpportunityPage.mockRejectedValueOnce(new RepositoryError('UNAVAILABLE'));
    const result = await client.callTool({ name: 'list_opportunities', arguments: {} });
    const payload = errorPayload(result);
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(logs[0]).toMatchObject({
      toolName: 'list_opportunities',
      requestId: payload.error.requestId,
      resultStatus: 'error',
      errorCategory: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(result)).not.toMatch(/postgres|stack|cause/i);
  });

  it('invalid application output is safely rejected by the wrapper', async () => {
    vi.spyOn(useCases.getProfile, 'execute').mockResolvedValue({
      profile: { ...fixture.profile, yearsExperience: -1 },
    });
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(logs[0]?.errorCategory).toBe('INTERNAL_ERROR');
  });

  it('rejects a mutation after shutdown admission closes before context or repository work', async () => {
    enter.mockReturnValue(null);
    const result = await client.callTool({ name: 'create_project_note', arguments: noteInput() });
    const payload = errorPayload(result);
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.requestId).toBe(logs[0]?.requestId);
    expect(resolve).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });

  it('context-provider failures use the safe application boundary', async () => {
    resolve.mockRejectedValue(new ApplicationError('INTERNAL_ERROR'));
    const payload = errorPayload(await client.callTool({ name: 'get_profile', arguments: {} }));
    expect(payload.error.requestId).toBe(logs[0]?.requestId);
    expect(fixture.calls).toEqual([]);
  });
});
