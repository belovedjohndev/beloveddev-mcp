import {
  EvaluationPolicyV1,
  evaluationVersion,
  evaluationWeightsV1,
  normalizeEvaluationValueV1,
  recommendationForScoreV1,
  recommendationThresholdsV1,
  type EvaluationEvidence,
  type EvaluationPolicyInput,
} from '../src/evaluation-policy-v1.js';
import { describe, expect, it } from 'vitest';

const profile: EvaluationPolicyInput['profile'] = {
  skills: ['TypeScript', 'PostgreSQL', 'Docker'],
  preferredProjectTypes: ['SaaS'],
  excludedProjectTypes: ['Gambling'],
};

const opportunity: EvaluationPolicyInput['opportunity'] = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Build a SaaS platform',
  source: 'manual',
  projectType: 'SaaS',
  amountMin: '5000.00',
  amountMax: '10000.00',
  requiredSkills: ['TypeScript', 'PostgreSQL'],
  preferredSkills: ['Docker'],
};

const evidence: EvaluationEvidence[] = [
  {
    evidenceId: '00000000-0000-4000-8000-000000000010',
    projectId: '00000000-0000-4000-8000-000000000011',
    projectName: 'Portfolio Platform',
    title: 'Tenant-safe persistence',
    summary: 'Implemented constrained PostgreSQL persistence.',
    skills: ['TypeScript', 'PostgreSQL'],
    relevanceScore: 0.75,
  },
  {
    evidenceId: '00000000-0000-4000-8000-000000000012',
    projectId: '00000000-0000-4000-8000-000000000011',
    projectName: 'Portfolio Platform',
    title: 'Containerized delivery',
    summary: 'Shipped a Docker deployment.',
    skills: ['Docker'],
    relevanceScore: 0.5,
  },
];

function evaluate(
  overrides: {
    profile?: Partial<EvaluationPolicyInput['profile']>;
    opportunity?: Partial<EvaluationPolicyInput['opportunity']>;
    evidence?: readonly EvaluationEvidence[];
    evidenceRetrievalIncomplete?: boolean;
  } = {},
) {
  return new EvaluationPolicyV1().evaluate({
    profile: { ...profile, ...overrides.profile },
    opportunity: { ...opportunity, ...overrides.opportunity },
    evidence: overrides.evidence ?? evidence,
    evidenceRetrievalIncomplete: overrides.evidenceRetrievalIncomplete ?? false,
  });
}

describe('EvaluationPolicyV1', () => {
  it('produces an excellent deterministic v1 evaluation', () => {
    const first = evaluate();
    const second = evaluate();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      fit: { overallScore: 100, recommendation: 'strong_match' },
      scores: { skills: 100, projectType: 100, budget: null, experienceEvidence: 100 },
      matchedSkills: ['typescript', 'postgresql', 'docker'],
      missingSkills: [],
      evaluationVersion,
    });
    expect(first.strengths.map(({ code }) => code)).toEqual([
      'all_required_skills_matched',
      'preferred_project_type',
      'strong_portfolio_evidence',
    ]);
  });

  it('scores a full required match without treating a preferred gap as missing', () => {
    const result = evaluate({
      profile: { skills: ['TypeScript', 'PostgreSQL'] },
      evidence: [evidence[0]!],
    });

    expect(result.scores.skills).toBe(80);
    expect(result.matchedSkills).toEqual(['typescript', 'postgresql']);
    expect(result.missingSkills).toEqual([]);
    expect(result.concerns.map(({ code }) => code)).not.toContain('missing_required_skills');
  });

  it('reports a partial required-skill gap without an unrequested recommendation cap', () => {
    const result = evaluate({
      profile: { skills: ['TypeScript'] },
      opportunity: { requiredSkills: ['TypeScript', 'Rust'], preferredSkills: [] },
      evidence: [{ ...evidence[0]!, skills: ['TypeScript', 'Rust'] }],
    });

    expect(result.scores.skills).toBe(50);
    expect(result.fit).toEqual({ overallScore: 74, recommendation: 'good_match' });
    expect(result.matchedSkills).toEqual(['typescript']);
    expect(result.missingSkills).toEqual(['rust']);
    expect(result.concerns).toContainEqual(
      expect.objectContaining({ code: 'missing_required_skills' }),
    );
  });

  it('forces skip when no required skill matches', () => {
    const result = evaluate({
      profile: { skills: ['Go'] },
      opportunity: { requiredSkills: ['Rust'], preferredSkills: [] },
      evidence: [{ ...evidence[0]!, skills: ['Rust'] }],
    });

    expect(result.scores.skills).toBe(0);
    expect(result.fit.recommendation).toBe('skip');
    expect(result.riskFlags).toContainEqual(
      expect.objectContaining({ code: 'no_required_skills_matched' }),
    );
  });

  it('weights preferred skills at 20 percent when both groups exist', () => {
    const result = evaluate({
      profile: { skills: ['TypeScript', 'Rust'] },
      opportunity: {
        requiredSkills: ['TypeScript'],
        preferredSkills: ['Rust', 'Go'],
      },
    });

    expect(result.scores.skills).toBe(90);
  });

  it('gives the sole skill group the full score and returns null when neither exists', () => {
    expect(
      evaluate({
        opportunity: { requiredSkills: [], preferredSkills: ['Docker', 'Rust'] },
      }).scores.skills,
    ).toBe(50);
    expect(
      evaluate({
        opportunity: { requiredSkills: [], preferredSkills: [] },
      }).scores.skills,
    ).toBeNull();
  });

  it('lets an excluded project type win and force skip', () => {
    const result = evaluate({
      profile: { preferredProjectTypes: ['Gambling'], excludedProjectTypes: ['Gambling'] },
      opportunity: { projectType: 'Gambling' },
    });

    expect(result.scores.projectType).toBe(0);
    expect(result.fit.recommendation).toBe('skip');
    expect(result.strengths.map(({ code }) => code)).not.toContain('preferred_project_type');
    expect(result.riskFlags).toContainEqual(
      expect.objectContaining({ code: 'excluded_project_type' }),
    );
  });

  it('scores an exact preferred project type as 100', () => {
    const result = evaluate();
    expect(result.scores.projectType).toBe(100);
    expect(result.strengths).toContainEqual(
      expect.objectContaining({ code: 'preferred_project_type' }),
    );
  });

  it('never emits a preferred-type strength for a normalized excluded type', () => {
    const result = evaluate({
      profile: {
        preferredProjectTypes: [' SaaS '],
        excludedProjectTypes: ['SAAS'],
      },
      opportunity: { projectType: 'saas' },
    });
    expect(result.scores.projectType).toBe(0);
    expect(result.fit.recommendation).toBe('skip');
    expect(result.strengths.map(({ code }) => code)).not.toContain('preferred_project_type');
    expect(result.riskFlags.map(({ code }) => code)).toContain('excluded_project_type');
  });

  it('scores an unknown project type as 50 only when preferences exist', () => {
    const unknown = evaluate({ opportunity: { projectType: 'Mobile' } });
    const unconfigured = evaluate({
      profile: { preferredProjectTypes: [] },
      opportunity: { projectType: 'Mobile' },
    });

    expect(unknown.scores.projectType).toBe(50);
    expect(unknown.concerns).toContainEqual(
      expect.objectContaining({ code: 'project_type_not_preferred' }),
    );
    expect(unconfigured.scores.projectType).toBeNull();
  });

  it('uses NFKC, trimming, whitespace collapse, lowercase, and deduplication', () => {
    const result = evaluate({
      profile: { skills: [' typescript ', 'POSTGRESQL', 'docker'] },
      opportunity: {
        requiredSkills: ['ＴｙｐｅＳｃｒｉｐｔ', '  PostgreSQL  ', 'typescript'],
        preferredSkills: ['POSTGRESQL', 'Docker', 'docker'],
        projectType: '  ＳａａＳ  ',
      },
      evidence: [
        {
          ...evidence[0]!,
          skills: ['ＴｙｐｅＳｃｒｉｐｔ', '  postgreSQL  ', 'docker'],
        },
      ],
    });

    expect(normalizeEvaluationValueV1('  Ｔｙｐｅ　Ｓｃｒｉｐｔ  ')).toBe('type script');
    expect(result.scores).toMatchObject({ skills: 100, projectType: 100, experienceEvidence: 100 });
    expect(result.matchedSkills).toEqual(['typescript', 'postgresql', 'docker']);
  });

  it('keeps budget null and emits budget_not_comparable when amounts exist', () => {
    const result = evaluate();
    const noBudget = evaluate({ opportunity: { amountMin: null, amountMax: null } });

    expect(result.scores.budget).toBeNull();
    expect(result.concerns).toContainEqual(
      expect.objectContaining({ code: 'budget_not_comparable' }),
    );
    expect(noBudget.scores.budget).toBeNull();
    expect(noBudget.concerns.map(({ code }) => code)).not.toContain('budget_not_comparable');
  });

  it('scores strong evidence from the union of structured evidence skills', () => {
    const result = evaluate();
    expect(result.scores.experienceEvidence).toBe(100);
    expect(result.strengths).toContainEqual(
      expect.objectContaining({ code: 'strong_portfolio_evidence' }),
    );
  });

  it('scores partial evidence with the same required/preferred weighting', () => {
    const result = evaluate({ evidence: [{ ...evidence[0]!, skills: ['TypeScript'] }] });
    expect(result.scores.experienceEvidence).toBe(40);
    expect(result.concerns).toContainEqual(
      expect.objectContaining({ code: 'limited_portfolio_evidence' }),
    );
  });

  it('scores missing evidence as zero when opportunity skills exist', () => {
    const result = evaluate({ evidence: [] });
    expect(result.scores.experienceEvidence).toBe(0);
    expect(result.riskFlags).toContainEqual(
      expect.objectContaining({ code: 'no_portfolio_evidence' }),
    );
  });

  it('distinguishes incomplete retrieval from an absence of portfolio evidence', () => {
    const result = evaluate({ evidence: [], evidenceRetrievalIncomplete: true });
    const complete = evaluate({ evidence: [] });
    expect(result.scores).toEqual(complete.scores);
    expect(result.fit).toEqual(complete.fit);
    expect(result.riskFlags.map(({ code }) => code)).toContain('evidence_retrieval_incomplete');
    expect(result.riskFlags.map(({ code }) => code)).not.toContain('no_portfolio_evidence');
  });

  it('uses neutral review and an explicit risk when every score is null', () => {
    const result = evaluate({
      profile: { preferredProjectTypes: [], excludedProjectTypes: [] },
      opportunity: {
        requiredSkills: [],
        preferredSkills: [],
        projectType: null,
        amountMin: null,
        amountMax: null,
      },
      evidence: [],
    });

    expect(result.scores).toEqual({
      skills: null,
      projectType: null,
      budget: null,
      experienceEvidence: null,
    });
    expect(result.fit).toEqual({ overallScore: 50, recommendation: 'review' });
    expect(result.riskFlags).toEqual([
      {
        code: 'insufficient_evaluation_signals',
        message: 'The opportunity has no skills, project type, or comparable budget signal.',
      },
    ]);
  });

  it('uses documented weights, null renormalization, and threshold boundaries', () => {
    expect(evaluationWeightsV1).toEqual({
      skills: 45,
      projectType: 20,
      budget: 15,
      experienceEvidence: 20,
    });
    expect(recommendationThresholdsV1).toEqual({
      strongMatch: 85,
      goodMatch: 70,
      review: 55,
      weakMatch: 40,
    });
    expect(
      evaluate({
        profile: { preferredProjectTypes: [], excludedProjectTypes: [] },
        opportunity: { projectType: null },
      }).fit.overallScore,
    ).toBe(100);
    expect([
      recommendationForScoreV1(100),
      recommendationForScoreV1(85),
      recommendationForScoreV1(84),
      recommendationForScoreV1(70),
      recommendationForScoreV1(69),
      recommendationForScoreV1(55),
      recommendationForScoreV1(54),
      recommendationForScoreV1(40),
      recommendationForScoreV1(39),
      recommendationForScoreV1(0),
    ]).toEqual([
      'strong_match',
      'strong_match',
      'good_match',
      'good_match',
      'review',
      'review',
      'weak_match',
      'weak_match',
      'skip',
      'skip',
    ]);
  });

  it('caps below-half required coverage at weak_match', () => {
    const result = evaluate({
      profile: { skills: ['TypeScript'] },
      opportunity: {
        requiredSkills: ['TypeScript', 'Rust', 'Go'],
        preferredSkills: [],
      },
      evidence: [{ ...evidence[0]!, skills: ['TypeScript', 'Rust', 'Go'] }],
    });

    expect(result.fit).toEqual({ overallScore: 65, recommendation: 'weak_match' });
  });

  it('preserves repository evidence order, rank metadata, and the output bound', () => {
    const manyEvidence = Array.from({ length: 12 }, (_, index) => ({
      ...evidence[0]!,
      evidenceId: `00000000-0000-4000-8000-${(100 + index).toString().padStart(12, '0')}`,
      relevanceScore: 1 - index / 100,
    }));
    const result = evaluate({ evidence: manyEvidence });

    expect(result.relevantEvidence).toHaveLength(10);
    expect(result.relevantEvidence.map(({ evidenceId }) => evidenceId)).toEqual(
      manyEvidence.slice(0, 10).map(({ evidenceId }) => evidenceId),
    );
    expect(result.relevantEvidence[0]?.relevanceScore).toBe(1);
  });
});
