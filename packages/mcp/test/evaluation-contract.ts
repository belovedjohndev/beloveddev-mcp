import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  ApplicationError,
  type ApplicationErrorCode,
} from '@beloveddev/application/application-error';
import { safeErrorSchema, toolSchemas, type ToolName } from '../src/schemas.js';

const scenarioId = z.enum([
  'evidence_grounding',
  'authorization_isolation',
  'note_idempotency',
  'safe_failure',
]);
const toolName = z.enum([
  'get_profile',
  'list_projects',
  'get_project',
  'search_project_evidence',
  'list_opportunities',
  'evaluate_opportunity',
  'create_project_note',
  'get_blockers',
]);
const checkId = z.enum([
  'stored_data',
  'grounded_evaluation',
  'no_writes',
  'scoped_lookup',
  'permission_before_repository',
  'original_result',
  'one_note_one_audit',
  'safe_conflict',
  'safe_unavailable',
  'inactive_membership',
]);
const definition = z.strictObject({
  id: scenarioId,
  tools: z.array(toolName).min(1),
  checks: z.array(checkId).min(1),
});
export const scenarioDefinitions = [
  {
    id: 'evidence_grounding',
    tools: ['get_profile', 'list_opportunities', 'search_project_evidence', 'evaluate_opportunity'],
    checks: ['stored_data', 'grounded_evaluation', 'no_writes'],
  },
  {
    id: 'authorization_isolation',
    tools: ['get_project', 'create_project_note'],
    checks: ['scoped_lookup', 'permission_before_repository', 'no_writes'],
  },
  {
    id: 'note_idempotency',
    tools: ['create_project_note', 'create_project_note', 'create_project_note'],
    checks: ['original_result', 'one_note_one_audit', 'safe_conflict'],
  },
  {
    id: 'safe_failure',
    tools: ['get_project', 'get_profile'],
    checks: ['safe_unavailable', 'inactive_membership', 'no_writes'],
  },
] as const;

export function validateScenarioDefinitions(input: unknown) {
  const definitions = z.array(definition).length(4).parse(input);
  if (!isDeepStrictEqual(definitions, scenarioDefinitions))
    throw new Error('Invalid evaluation definitions.');
  return definitions;
}
export type ScenarioId = z.infer<typeof scenarioId>;
export type CheckId = z.infer<typeof checkId>;
export const observationSchema = z.strictObject({
  id: scenarioId,
  tools: z.array(toolName),
  checks: z.array(checkId),
  phase: z.enum(['setup', 'workflow', 'cleanup']),
  cleanup: z.enum(['pending', 'passed', 'failed']),
});
export type EvaluationObservation = z.infer<typeof observationSchema>;

export function requireEqual(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Evaluation expectation failed.');
}

/** Compare the complete semantic result; request identifiers are intentionally variable. */
export function requireGroundedResult(
  name: ToolName,
  result: CallToolResult,
  expected: unknown,
): void {
  requireEqual(result.isError === true, false);
  const parsed = toolSchemas[name].output.parse(result.structuredContent);
  const facts = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'meta'));
  requireEqual(facts, expected);
  requireEqual(result.content, [{ type: 'text', text: JSON.stringify(parsed) }]);
}

export function requireSafeError(result: CallToolResult, code: ApplicationErrorCode) {
  requireEqual(result.isError, true);
  requireEqual(result.structuredContent, undefined);
  requireEqual(result.content.length, 1);
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected safe MCP error.');
  const parsed = safeErrorSchema.parse(JSON.parse(content.text));
  requireEqual(parsed.error.code, code);
  requireEqual(parsed.error.message, new ApplicationError(code).message);
  // No result fields or caller-added domain interpretation accompany an unavailable resource.
  return parsed.error;
}

export interface EvaluationOutcome {
  name: string;
  state: string;
  observation: unknown;
}

/** Only allowlisted identifiers leave the test process; raw assertion errors never enter reports. */
export function buildEvaluationReport(
  outcomes: readonly EvaluationOutcome[],
  runtimeFailure = false,
) {
  validateScenarioDefinitions(scenarioDefinitions);
  const invalidInventory =
    outcomes.length !== scenarioDefinitions.length ||
    outcomes.some((outcome) => !scenarioId.safeParse(outcome.name).success);
  const scenarios = scenarioDefinitions.map((def) => {
    const matches = outcomes.filter((outcome) => outcome.name === def.id);
    const outcome = matches[0];
    const parsed = observationSchema.safeParse(outcome?.observation);
    const observation = parsed.success && parsed.data.id === def.id ? parsed.data : null;
    const complete =
      observation !== null &&
      isDeepStrictEqual(observation.tools, def.tools) &&
      isDeepStrictEqual(observation.checks, def.checks);
    const passed =
      !invalidInventory &&
      matches.length === 1 &&
      outcome?.state === 'passed' &&
      complete &&
      observation?.cleanup === 'passed' &&
      observation.phase === 'cleanup';
    const failure = passed
      ? null
      : observation?.cleanup === 'failed'
        ? 'cleanup_failed'
        : observation?.phase === 'setup'
          ? 'setup_failed'
          : outcome?.state === 'failed'
            ? 'workflow_failed'
            : runtimeFailure
              ? 'runner_failed'
              : 'workflow_failed';
    return {
      id: def.id,
      status: passed ? ('passed' as const) : ('failed' as const),
      expectedTools: def.tools,
      observedTools: observation?.tools ?? [],
      checks: observation?.checks ?? [],
      phase: observation?.phase ?? 'setup',
      cleanup: observation?.cleanup ?? 'pending',
      failure,
    };
  });
  return {
    schemaVersion: 1,
    kind: 'deterministic_workflow_regression',
    runnerStatus: runtimeFailure ? 'failed' : 'passed',
    status:
      !runtimeFailure && scenarios.every((scenario) => scenario.status === 'passed')
        ? ('passed' as const)
        : ('failed' as const),
    scenarios,
  };
}
