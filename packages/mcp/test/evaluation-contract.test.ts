import { describe, expect, it } from 'vitest';
import {
  buildEvaluationReport,
  requireGroundedResult,
  requireSafeError,
  scenarioDefinitions,
  validateScenarioDefinitions,
} from './evaluation-contract.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const complete = () =>
  scenarioDefinitions.map((def) => ({
    name: def.id,
    state: 'passed',
    observation: {
      id: def.id,
      tools: [...def.tools],
      checks: [...def.checks],
      phase: 'cleanup',
      cleanup: 'passed',
    },
  }));
const facts = {
  opportunity: { id: requestId, title: 'Synthetic SaaS', source: 'manual' },
  fit: { overallScore: 85, recommendation: 'strong_match' },
  scores: { skills: 80, projectType: 100, budget: null, experienceEvidence: 80 },
  matchedSkills: ['typescript', 'postgresql'],
  missingSkills: [],
  strengths: [],
  concerns: [],
  riskFlags: [],
  relevantEvidence: [],
  evaluationVersion: 'v1',
};
function result(payload: Record<string, unknown>) {
  const structuredContent = { ...facts, ...payload, meta: { requestId } };
  return {
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  };
}

describe('deterministic evaluation controls', () => {
  it('validates the exact four definitions before execution', () => {
    expect(validateScenarioDefinitions(scenarioDefinitions)).toHaveLength(4);
  });
  it.each(['unknown_field', 'duplicate_id', 'unsupported_tool', 'changed_sequence'])(
    'rejects %s definitions',
    (change) => {
      const definitions = structuredClone(scenarioDefinitions).map((def) => ({
        ...def,
        tools: [...def.tools],
      }));
      if (change === 'unknown_field')
        Object.assign(definitions[0] ?? {}, { secret: 'not-allowed' });
      if (change === 'duplicate_id') definitions[1] = { ...definitions[0]! };
      if (change === 'unsupported_tool') Object.assign(definitions[0]!, { tools: ['execute_sql'] });
      if (change === 'changed_sequence') definitions[0]?.tools.reverse();
      expect(() => validateScenarioDefinitions(definitions)).toThrow();
    },
  );
  it('accepts a complete successful report', () => {
    expect(buildEvaluationReport(complete()).status).toBe('passed');
  });
  it.each([
    'missing',
    'skipped',
    'duplicate',
    'unknown',
    'metadata',
    'sequence',
    'checks',
    'cleanup',
    'phase',
    'runtime',
  ])('fails closed for %s outcomes', (change) => {
    const outcomes = complete();
    const first = outcomes[0]!;
    if (change === 'missing') outcomes.pop();
    if (change === 'skipped') first.state = 'skipped';
    if (change === 'duplicate') outcomes.push(first);
    if (change === 'unknown') first.name = 'not_a_scenario' as typeof first.name;
    if (change === 'metadata') Object.assign(first.observation, { private: 'credential-sentinel' });
    if (change === 'sequence') first.observation.tools.reverse();
    if (change === 'checks') first.observation.checks.pop();
    if (change === 'cleanup') first.observation.cleanup = 'failed';
    if (change === 'phase') first.observation.phase = 'workflow';
    const report = buildEvaluationReport(outcomes, change === 'runtime');
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('credential-sentinel');
  });
  it('retains completed scenario outcomes when the runner independently fails', () => {
    const report = buildEvaluationReport(complete(), true);
    expect(report.status).toBe('failed');
    expect(report.runnerStatus).toBe('failed');
    expect(report.scenarios.every((scenario) => scenario.status === 'passed')).toBe(true);
  });
  it('accepts the full expected grounded result', () => {
    expect(() => requireGroundedResult('evaluate_opportunity', result({}), facts)).not.toThrow();
  });
  it.each([
    { fit: { overallScore: 99, recommendation: 'strong_match' } },
    {
      relevantEvidence: [
        {
          projectId: requestId,
          projectName: 'Invented',
          evidenceId: requestId,
          title: 'Unsupported',
          summary: 'Invented fact',
          relevanceScore: 1,
        },
      ],
    },
    { strengths: [{ code: 'preferred_project_type', message: 'Unsupported business success' }] },
    { inventedClaim: 'Guaranteed outcome' },
  ])('rejects unsupported evaluation facts: %j', (unsupported) => {
    expect(() =>
      requireGroundedResult('evaluate_opportunity', result(unsupported), facts),
    ).toThrow();
  });
  it('accepts only the safe unavailable envelope', () => {
    const error = {
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId },
    };
    const response = {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(error) }],
    };
    expect(requireSafeError(response, 'NOT_FOUND').requestId).toBe(requestId);
    expect(() =>
      requireSafeError({ ...response, structuredContent: { invented: 'fact' } }, 'NOT_FOUND'),
    ).toThrow();
    expect(() =>
      requireSafeError(
        {
          ...response,
          content: [{ type: 'text', text: JSON.stringify({ ...error, project: 'invented' }) }],
        },
        'NOT_FOUND',
      ),
    ).toThrow();
    expect(() => requireSafeError(response, 'FORBIDDEN')).toThrow();
    expect(() =>
      requireSafeError(
        {
          ...response,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: { ...error.error, message: 'private-secret' } }),
            },
          ],
        },
        'NOT_FOUND',
      ),
    ).toThrow();
  });
});
