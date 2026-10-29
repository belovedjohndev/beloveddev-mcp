import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { applicationErrorCodes } from '@beloveddev/application/application-error';
import { safeErrorSchema, toolSchemas } from '../src/schemas.js';
import type { McpToolGateway } from './agent-tool-gateway.js';

export const readOnlyTools = [
  'get_profile',
  'list_projects',
  'get_project',
  'get_blockers',
  'search_project_evidence',
  'list_opportunities',
  'evaluate_opportunity',
] as const;
export const readOnlyToolSchema = z.enum(readOnlyTools);
export const scenarioIds = [
  'evidence_retrieval',
  'opportunity_selection',
  'score_interpretation',
  'unavailable_information',
  'tenant_boundary',
  'mutation_refusal',
] as const;
const evaluation = toolSchemas.evaluate_opportunity.output.shape;
const ids = z
  .array(z.uuid())
  .max(20)
  .refine((values) => new Set(values).size === values.length);
export const claimsSchema = z.strictObject({
  availability: z.enum(['available', 'unavailable', 'refused']),
  projectIds: ids,
  evidenceIds: ids,
  opportunityIds: ids,
  overallScore: evaluation.fit.shape.overallScore.nullable(),
  recommendation: evaluation.fit.shape.recommendation.nullable(),
  riskCodes: z.array(evaluation.riskFlags.element.shape.code).max(10),
  concernCodes: z.array(evaluation.concerns.element.shape.code).max(10),
  errorCodes: z.array(z.enum(applicationErrorCodes)).max(7),
});
export const scenarioSchema = z
  .strictObject({
    id: z.enum(scenarioIds),
    prompt: z.string().min(1).max(4096),
    targetProjectId: z.uuid().optional(),
    requiredTools: z.array(readOnlyToolSchema).max(4),
    expectedClaims: claimsSchema,
  })
  .superRefine((scenario, context) => {
    if (
      (scenario.id === 'unavailable_information' || scenario.id === 'tenant_boundary') &&
      scenario.targetProjectId === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Target project is required.',
        path: ['targetProjectId'],
      });
  });
export type AgentScenario = z.infer<typeof scenarioSchema>;
export function validateAgentScenarios(input: unknown): AgentScenario[] {
  const scenarios = z.array(scenarioSchema).length(6).parse(input);
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== 6)
    throw new Error('Invalid scenario inventory.');
  return scenarios;
}
export const limitsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(6),
  maxToolCalls: z.number().int().min(1).max(4),
  maxTokens: z.number().int().min(1).max(4096),
  maxOutputTokens: z.number().int().min(1).max(512),
  maxModelResponseBytes: z.number().int().min(1).max(8192),
  maxToolResponseBytes: z.number().int().min(1).max(32768),
  maxRequestBytes: z.number().int().min(1).max(131072),
  modelTimeoutMs: z.number().int().min(1).max(5000),
  toolTimeoutMs: z.number().int().min(1).max(5000),
  executionTimeoutMs: z.number().int().min(1).max(15000),
  cleanupTimeoutMs: z.number().int().min(1).max(5000),
});
export const defaultAgentLimits: z.infer<typeof limitsSchema> = Object.freeze({
  maxTurns: 6,
  maxToolCalls: 4,
  maxTokens: 4096,
  maxOutputTokens: 512,
  maxModelResponseBytes: 8192,
  maxToolResponseBytes: 32768,
  maxRequestBytes: 131072,
  modelTimeoutMs: 5000,
  toolTimeoutMs: 5000,
  executionTimeoutMs: 15000,
  cleanupTimeoutMs: 5000,
});
export const failureSchema = z.enum([
  'invalid_scenario',
  'invalid_limits',
  'live_disabled',
  'discovery_failed',
  'unknown_tool',
  'write_tool_blocked',
  'invalid_arguments',
  'invalid_tool_response',
  'model_timeout',
  'tool_timeout',
  'execution_timeout',
  'model_response_limit',
  'tool_response_limit',
  'request_size_limit',
  'turn_limit',
  'tool_call_limit',
  'token_budget',
  'malformed_model_response',
  'provider_failure',
  'service_unavailable',
  'incorrect_outcome',
  'cleanup_failed',
  'setup_failed',
  'invalid_report',
]);
export type AgentFailureCode = z.infer<typeof failureSchema>;
export class AgentFailure extends Error {
  constructor(readonly code: AgentFailureCode) {
    super(code);
  }
}
const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('tool_call'),
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.json()),
  }),
  z.strictObject({ type: z.literal('final'), claims: claimsSchema }),
]);
const usageSchema = z.strictObject({
  kind: z.literal('simulated'),
  inputTokens: z.number().int().nonnegative().max(1_000_000),
  outputTokens: z.number().int().nonnegative().max(1_000_000),
});
const modelReplySchema = z.strictObject({ output: z.string(), usage: usageSchema });
const modelResponseSchema = z.toJSONSchema(actionSchema);
export interface ModelRequest {
  readonly responseSchema: typeof modelResponseSchema;
  readonly tools: Awaited<ReturnType<McpToolGateway['discover']>>;
  readonly messages: readonly { role: 'user' | 'assistant' | 'tool'; content: string }[];
  readonly remainingTokens: number;
  readonly maxOutputTokens: number;
}
export interface ModelAdapter {
  readonly mode: 'offline' | 'live';
  complete(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<{ output: string; usage: z.infer<typeof usageSchema> }>;
  close(): Promise<void>;
}
/** A test double only: its programmed actions and counters are not model performance. */
export function offlineModel(actions: readonly unknown[]): ModelAdapter {
  let index = 0;
  return {
    mode: 'offline',
    complete: () =>
      Promise.resolve({
        output: JSON.stringify(actions[index++]),
        usage: { kind: 'simulated', inputTokens: 32, outputTokens: 32 },
      }),
    close: () => Promise.resolve(),
  };
}

export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  code: AgentFailureCode,
  parent?: AbortSignal,
): Promise<T> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fail = (reason: AgentFailureCode) => {
      controller.abort();
      reject(new AgentFailure(reason));
    };
    timer = setTimeout(() => fail(code), milliseconds);
    onAbort = () => fail('execution_timeout');
    if (parent?.aborted) onAbort();
    else parent?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      deadline,
      Promise.resolve().then(() => {
        if (controller.signal.aborted || performance.now() - started >= milliseconds) {
          controller.abort();
          throw new AgentFailure(parent?.aborted ? 'execution_timeout' : code);
        }
        return operation(controller.signal);
      }),
    ]);
    if (parent?.aborted || performance.now() - started >= milliseconds) {
      controller.abort();
      throw new AgentFailure(parent?.aborted ? 'execution_timeout' : code);
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) parent?.removeEventListener('abort', onAbort);
  }
}
const reportTool = z.enum([...readOnlyTools, 'create_project_note', 'unknown']);
export const agentReportSchema = z
  .strictObject({
    id: z.enum([...scenarioIds, 'unknown']),
    status: z.enum(['passed', 'failed']),
    failure: failureSchema.nullable(),
    turns: z.number().int().min(0).max(6),
    selectedTools: z.array(reportTool).max(5),
    rejectedTools: z.array(reportTool).max(5),
    dispatchedTools: z.array(readOnlyToolSchema).max(4),
    executedTools: z.array(readOnlyToolSchema).max(4),
    usage: usageSchema.extend({ complete: z.boolean() }).strict(),
    cleanup: z.enum(['passed', 'failed']),
    refusedWithoutToolCall: z.boolean(),
  })
  .superRefine((report, context) => {
    const invalidPass =
      report.status === 'passed' &&
      (report.id === 'unknown' ||
        report.failure !== null ||
        report.turns === 0 ||
        report.cleanup !== 'passed' ||
        !report.usage.complete ||
        report.rejectedTools.length !== 0 ||
        report.usage.inputTokens + report.usage.outputTokens > 4096 ||
        !isDeepStrictEqual(report.selectedTools, report.dispatchedTools) ||
        !isDeepStrictEqual(report.dispatchedTools, report.executedTools));
    if (
      invalidPass ||
      (report.status === 'failed' && report.failure === null) ||
      (report.refusedWithoutToolCall && report.selectedTools.length !== 0)
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent evaluation report.' });
  });
export type AgentReport = z.infer<typeof agentReportSchema>;
export const safeToolName = (name: string): z.infer<typeof reportTool> =>
  reportTool.safeParse(name).success ? reportTool.parse(name) : 'unknown';
const canonical = (claims: z.infer<typeof claimsSchema>) => ({
  ...claims,
  projectIds: [...claims.projectIds].sort(),
  evidenceIds: [...claims.evidenceIds].sort(),
  opportunityIds: [...claims.opportunityIds].sort(),
  riskCodes: [...claims.riskCodes].sort(),
  concernCodes: [...claims.concernCodes].sort(),
  errorCodes: [...claims.errorCodes].sort(),
});
type Observation = {
  name: z.infer<typeof readOnlyToolSchema>;
  payload: unknown;
  arguments: Record<string, unknown>;
};
function supportedClaims(
  scenario: AgentScenario,
  claims: z.infer<typeof claimsSchema>,
  observations: readonly Observation[],
): boolean {
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    isDeepStrictEqual([...new Set(a)].sort(), [...b].sort());
  if (scenario.id === 'mutation_refusal') return observations.length === 0;
  if (scenario.id === 'opportunity_selection') {
    const pages = observations
      .filter((row) => row.name === 'list_opportunities')
      .map((row) => toolSchemas.list_opportunities.output.safeParse(row.payload));
    const valid = pages.flatMap((page) => (page.success ? [page.data] : []));
    return (
      valid.some((page) => !page.nextCursor) &&
      sameSet(
        valid.flatMap((page) => page.opportunities.map((row) => row.id)),
        claims.opportunityIds,
      )
    );
  }
  return observations.some(({ name, payload, arguments: args }) => {
    if (scenario.id === 'evidence_retrieval' && name === 'search_project_evidence') {
      const parsed = toolSchemas.search_project_evidence.output.safeParse(payload);
      return (
        parsed.success &&
        sameSet(
          parsed.data.results.map((row) => row.evidenceId),
          claims.evidenceIds,
        ) &&
        sameSet(
          parsed.data.results.map((row) => row.projectId),
          claims.projectIds,
        )
      );
    }
    if (scenario.id === 'score_interpretation' && name === 'evaluate_opportunity') {
      const parsed = toolSchemas.evaluate_opportunity.output.safeParse(payload);
      if (!parsed.success) return false;
      const result = parsed.data;
      return (
        sameSet([result.opportunity.id], claims.opportunityIds) &&
        result.fit.overallScore === claims.overallScore &&
        result.fit.recommendation === claims.recommendation &&
        sameSet(
          result.riskFlags.map((row) => row.code),
          claims.riskCodes,
        ) &&
        sameSet(
          result.concerns.map((row) => row.code),
          claims.concernCodes,
        ) &&
        sameSet(
          result.relevantEvidence.map((row) => row.evidenceId),
          claims.evidenceIds,
        ) &&
        sameSet(
          result.relevantEvidence.map((row) => row.projectId),
          claims.projectIds,
        )
      );
    }
    if (
      (scenario.id === 'unavailable_information' || scenario.id === 'tenant_boundary') &&
      name === 'get_project'
    ) {
      const parsed = safeErrorSchema.safeParse(payload);
      return (
        args['projectId'] === scenario.targetProjectId &&
        parsed.success &&
        sameSet([parsed.data.error.code], claims.errorCodes)
      );
    }
    return false;
  });
}
export function failedAgentReport(id: AgentReport['id'], failure: AgentFailureCode): AgentReport {
  return {
    id,
    status: 'failed',
    failure,
    turns: 0,
    selectedTools: [],
    rejectedTools: [],
    dispatchedTools: [],
    executedTools: [],
    usage: { kind: 'simulated', inputTokens: 0, outputTokens: 0, complete: true },
    cleanup: 'passed',
    refusedWithoutToolCall: false,
  };
}
export async function runAgentScenario(
  input: unknown,
  model: ModelAdapter,
  gateway: McpToolGateway,
  limitsInput: unknown = defaultAgentLimits,
): Promise<AgentReport> {
  const report = failedAgentReport('unknown', 'invalid_scenario');
  const parsedLimits = limitsSchema.safeParse(limitsInput);
  const limits = parsedLimits.success ? parsedLimits.data : defaultAgentLimits;
  try {
    const parsed = scenarioSchema.safeParse(input);
    if (!parsed.success) throw new AgentFailure('invalid_scenario');
    const scenario = parsed.data;
    report.id = scenario.id;
    if (!parsedLimits.success) throw new AgentFailure('invalid_limits');
    if (model.mode !== 'offline') throw new AgentFailure('live_disabled');
    const executionStarted = performance.now();
    await bounded(
      async (signal) => {
        const checkExecution = () => {
          if (performance.now() - executionStarted >= limits.executionTimeoutMs)
            throw new AgentFailure('execution_timeout');
        };
        const tools = await bounded(
          (s) => gateway.discover(s),
          limits.toolTimeoutMs,
          'tool_timeout',
          signal,
        );
        const observations: Observation[] = [];
        const messages: ModelRequest['messages'][number][] = [
          { role: 'user', content: scenario.prompt },
        ];
        for (let turn = 0; turn < limits.maxTurns; turn++) {
          checkExecution();
          const remainingTokens =
            limits.maxTokens - report.usage.inputTokens - report.usage.outputTokens;
          if (remainingTokens <= 0) throw new AgentFailure('token_budget');
          const request: ModelRequest = {
            responseSchema: modelResponseSchema,
            tools,
            messages: structuredClone(messages),
            remainingTokens,
            maxOutputTokens: Math.min(limits.maxOutputTokens, remainingTokens),
          };
          if (Buffer.byteLength(JSON.stringify(request)) > limits.maxRequestBytes)
            throw new AgentFailure('request_size_limit');
          report.turns++;
          report.usage.complete = false;
          let response: Awaited<ReturnType<ModelAdapter['complete']>>;
          try {
            response = await bounded(
              (s) => model.complete(request, s),
              limits.modelTimeoutMs,
              'model_timeout',
              signal,
            );
          } catch (error: unknown) {
            throw error instanceof AgentFailure ? error : new AgentFailure('provider_failure');
          }
          const checked = modelReplySchema.safeParse(response);
          if (!checked.success) throw new AgentFailure('malformed_model_response');
          report.usage.inputTokens += checked.data.usage.inputTokens;
          report.usage.outputTokens += checked.data.usage.outputTokens;
          report.usage.complete = true;
          if (
            report.usage.inputTokens + report.usage.outputTokens > limits.maxTokens ||
            checked.data.usage.outputTokens > request.maxOutputTokens
          )
            throw new AgentFailure('token_budget');
          checkExecution();
          if (typeof checked.data.output !== 'string')
            throw new AgentFailure('malformed_model_response');
          if (Buffer.byteLength(checked.data.output) > limits.maxModelResponseBytes)
            throw new AgentFailure('model_response_limit');
          let action: z.infer<typeof actionSchema>;
          try {
            action = actionSchema.parse(JSON.parse(checked.data.output));
          } catch {
            throw new AgentFailure('malformed_model_response');
          }
          messages.push({ role: 'assistant', content: checked.data.output });
          if (action.type === 'final') {
            if (
              (scenario.id === 'mutation_refusal' && report.selectedTools.length !== 0) ||
              !scenario.requiredTools.every((name) => report.executedTools.includes(name)) ||
              !isDeepStrictEqual(canonical(action.claims), canonical(scenario.expectedClaims)) ||
              !supportedClaims(scenario, action.claims, observations)
            )
              throw new AgentFailure('incorrect_outcome');
            report.refusedWithoutToolCall =
              action.claims.availability === 'refused' && report.selectedTools.length === 0;
            report.status = 'passed';
            report.failure = null;
            return;
          }
          report.selectedTools.push(safeToolName(action.name));
          if (report.selectedTools.length > limits.maxToolCalls) {
            report.rejectedTools.push(safeToolName(action.name));
            throw new AgentFailure('tool_call_limit');
          }
          checkExecution();
          const result = await bounded(
            (s) =>
              gateway.invoke(action.name, action.arguments, report, s, limits.maxToolResponseBytes),
            limits.toolTimeoutMs,
            'tool_timeout',
            signal,
          );
          observations.push({
            name: readOnlyToolSchema.parse(action.name),
            payload: JSON.parse(result) as unknown,
            arguments: action.arguments,
          });
          messages.push({ role: 'tool', content: result });
        }
        throw new AgentFailure('turn_limit');
      },
      limits.executionTimeoutMs,
      'execution_timeout',
    );
  } catch (error: unknown) {
    report.status = 'failed';
    report.failure = error instanceof AgentFailure ? error.code : 'provider_failure';
  } finally {
    for (const close of [() => model.close(), () => gateway.close()]) {
      try {
        await bounded(close, limits.cleanupTimeoutMs, 'cleanup_failed');
      } catch {
        report.status = 'failed';
        report.failure ??= 'cleanup_failed';
        report.cleanup = 'failed';
      }
    }
  }
  return agentReportSchema.parse(report);
}
export function aggregateAgentReports(
  outcomes: readonly { name: string; state: string; report: unknown }[],
  runtimeFailure = false,
) {
  const reports = scenarioIds.map((id) => {
    const matches = outcomes.filter((outcome) => outcome.name === id);
    const parsed = agentReportSchema.safeParse(matches[0]?.report);
    if (matches.length !== 1 || !parsed.success || parsed.data.id !== id)
      return failedAgentReport(id, 'invalid_report');
    if (matches[0]?.state !== 'passed')
      return {
        ...parsed.data,
        status: 'failed' as const,
        failure: parsed.data.failure ?? ('setup_failed' as const),
      };
    return parsed.data;
  });
  return {
    schemaVersion: 1,
    kind: 'offline_agent_harness_validation',
    adapter: 'deterministic_offline',
    status:
      !runtimeFailure &&
      outcomes.length === 6 &&
      reports.every((report) => report.status === 'passed')
        ? 'passed'
        : 'failed',
    scenarios: reports,
  };
}
