import type { DeveloperProfile, Opportunity } from './entities.js';

export const evaluationVersion = 'v1' as const;
export const evaluationEvidenceLimit = 10;

export const evaluationWeightsV1 = Object.freeze({
  skills: 45,
  projectType: 20,
  budget: 15,
  experienceEvidence: 20,
});

export const recommendationThresholdsV1 = Object.freeze({
  strongMatch: 85,
  goodMatch: 70,
  review: 55,
  weakMatch: 40,
});

export type OpportunityRecommendation =
  'strong_match' | 'good_match' | 'review' | 'weak_match' | 'skip';

export type EvaluationStrengthCode =
  'all_required_skills_matched' | 'preferred_project_type' | 'strong_portfolio_evidence';
export type EvaluationConcernCode =
  | 'missing_required_skills'
  | 'project_type_not_preferred'
  | 'limited_portfolio_evidence'
  | 'budget_not_comparable';
export type EvaluationRiskCode =
  | 'excluded_project_type'
  | 'no_required_skills_matched'
  | 'no_portfolio_evidence'
  | 'evidence_retrieval_incomplete'
  | 'insufficient_evaluation_signals';

export interface EvaluationFinding<Code extends string> {
  readonly code: Code;
  readonly message: string;
}

export interface EvaluationEvidence {
  readonly projectId: string;
  readonly projectName: string;
  readonly evidenceId: string;
  readonly title: string;
  readonly summary: string;
  readonly skills: readonly string[];
  /** PostgreSQL search rank is retrieval metadata, not a fit percentage. */
  readonly relevanceScore: number;
}

export interface EvaluationPolicyInput {
  readonly profile: Pick<
    DeveloperProfile,
    'skills' | 'preferredProjectTypes' | 'excludedProjectTypes'
  >;
  readonly opportunity: Pick<
    Opportunity,
    | 'id'
    | 'title'
    | 'source'
    | 'projectType'
    | 'amountMin'
    | 'amountMax'
    | 'requiredSkills'
    | 'preferredSkills'
  >;
  readonly evidence: readonly EvaluationEvidence[];
  /** Query terms were omitted/shortened, or more than ten matches exist. */
  readonly evidenceRetrievalIncomplete?: boolean;
}

export interface OpportunityEvaluationResult {
  readonly opportunity: {
    readonly id: string;
    readonly title: string;
    readonly source: string;
  };
  readonly fit: {
    readonly overallScore: number;
    readonly recommendation: OpportunityRecommendation;
  };
  readonly scores: {
    readonly skills: number | null;
    readonly projectType: number | null;
    readonly budget: null;
    readonly experienceEvidence: number | null;
  };
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly strengths: readonly EvaluationFinding<EvaluationStrengthCode>[];
  readonly concerns: readonly EvaluationFinding<EvaluationConcernCode>[];
  readonly riskFlags: readonly EvaluationFinding<EvaluationRiskCode>[];
  readonly relevantEvidence: readonly {
    readonly projectId: string;
    readonly projectName: string;
    readonly evidenceId: string;
    readonly title: string;
    readonly summary: string;
    readonly relevanceScore: number;
  }[];
  readonly evaluationVersion: typeof evaluationVersion;
}

export function normalizeEvaluationValueV1(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function normalizeEvaluationCollectionV1(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const item = normalizeEvaluationValueV1(value);
    if (item !== '') normalized.add(item);
  }
  return [...normalized];
}

function coverage(matched: number, total: number): number | null {
  return total === 0 ? null : matched / total;
}

function weightedCoverageScore(
  requiredMatched: number,
  requiredTotal: number,
  preferredMatched: number,
  preferredTotal: number,
): number | null {
  const requiredCoverage = coverage(requiredMatched, requiredTotal);
  const preferredCoverage = coverage(preferredMatched, preferredTotal);
  if (requiredCoverage === null && preferredCoverage === null) return null;
  if (requiredCoverage === null) return Math.round((preferredCoverage ?? 0) * 100);
  if (preferredCoverage === null) return Math.round(requiredCoverage * 100);
  return Math.round(requiredCoverage * 80 + preferredCoverage * 20);
}

export function recommendationForScoreV1(score: number): OpportunityRecommendation {
  if (score >= recommendationThresholdsV1.strongMatch) return 'strong_match';
  if (score >= recommendationThresholdsV1.goodMatch) return 'good_match';
  if (score >= recommendationThresholdsV1.review) return 'review';
  if (score >= recommendationThresholdsV1.weakMatch) return 'weak_match';
  return 'skip';
}

const recommendationRank: Record<OpportunityRecommendation, number> = {
  skip: 0,
  weak_match: 1,
  review: 2,
  good_match: 3,
  strong_match: 4,
};

function capRecommendation(
  recommendation: OpportunityRecommendation,
  maximum: OpportunityRecommendation,
): OpportunityRecommendation {
  return recommendationRank[recommendation] > recommendationRank[maximum]
    ? maximum
    : recommendation;
}

function overallScore(scores: OpportunityEvaluationResult['scores']): number {
  const dimensions = [
    [scores.skills, evaluationWeightsV1.skills],
    [scores.projectType, evaluationWeightsV1.projectType],
    [scores.budget, evaluationWeightsV1.budget],
    [scores.experienceEvidence, evaluationWeightsV1.experienceEvidence],
  ] as const;
  let numerator = 0;
  let denominator = 0;
  for (const [score, weight] of dimensions) {
    if (score === null) continue;
    numerator += score * weight;
    denominator += weight;
  }
  return denominator === 0 ? 50 : Math.round(numerator / denominator);
}

export class EvaluationPolicyV1 {
  evaluate(input: EvaluationPolicyInput): OpportunityEvaluationResult {
    const requiredSkills = normalizeEvaluationCollectionV1(input.opportunity.requiredSkills);
    const requiredSkillSet = new Set(requiredSkills);
    const preferredSkills = normalizeEvaluationCollectionV1(
      input.opportunity.preferredSkills,
    ).filter((skill) => !requiredSkillSet.has(skill));
    const profileSkills = new Set(normalizeEvaluationCollectionV1(input.profile.skills));
    const matchedRequired = requiredSkills.filter((skill) => profileSkills.has(skill));
    const matchedPreferred = preferredSkills.filter((skill) => profileSkills.has(skill));
    const missingRequired = requiredSkills.filter((skill) => !profileSkills.has(skill));
    const requiredCoverage = coverage(matchedRequired.length, requiredSkills.length);
    const skillsScore = weightedCoverageScore(
      matchedRequired.length,
      requiredSkills.length,
      matchedPreferred.length,
      preferredSkills.length,
    );

    const projectType =
      input.opportunity.projectType === null
        ? null
        : normalizeEvaluationValueV1(input.opportunity.projectType) || null;
    const preferredProjectTypes = new Set(
      normalizeEvaluationCollectionV1(input.profile.preferredProjectTypes),
    );
    const excludedProjectTypes = new Set(
      normalizeEvaluationCollectionV1(input.profile.excludedProjectTypes),
    );
    const isExcludedProjectType = projectType !== null && excludedProjectTypes.has(projectType);
    const isPreferredProjectType = projectType !== null && preferredProjectTypes.has(projectType);
    const projectTypeScore = isExcludedProjectType
      ? 0
      : isPreferredProjectType
        ? 100
        : projectType !== null && preferredProjectTypes.size > 0
          ? 50
          : null;

    const evidenceSkills = new Set(
      normalizeEvaluationCollectionV1(input.evidence.flatMap((item) => item.skills)),
    );
    const experienceEvidenceScore = weightedCoverageScore(
      requiredSkills.filter((skill) => evidenceSkills.has(skill)).length,
      requiredSkills.length,
      preferredSkills.filter((skill) => evidenceSkills.has(skill)).length,
      preferredSkills.length,
    );

    const scores = {
      skills: skillsScore,
      projectType: projectTypeScore,
      budget: null,
      experienceEvidence: experienceEvidenceScore,
    } as const;
    const score = overallScore(scores);
    const noEvaluationSignals = Object.values(scores).every((value) => value === null);

    const strengths: EvaluationFinding<EvaluationStrengthCode>[] = [];
    const concerns: EvaluationFinding<EvaluationConcernCode>[] = [];
    const riskFlags: EvaluationFinding<EvaluationRiskCode>[] = [];

    if (requiredCoverage === 1) {
      strengths.push({
        code: 'all_required_skills_matched',
        message: 'All required skills are present in the developer profile.',
      });
    }
    if (isPreferredProjectType && !isExcludedProjectType) {
      strengths.push({
        code: 'preferred_project_type',
        message: 'The opportunity matches a preferred project type.',
      });
    }
    if (experienceEvidenceScore !== null && experienceEvidenceScore >= 80) {
      strengths.push({
        code: 'strong_portfolio_evidence',
        message: 'Portfolio evidence demonstrates at least 80% of the requested skill coverage.',
      });
    }

    if (missingRequired.length > 0) {
      concerns.push({
        code: 'missing_required_skills',
        message: `Missing required skills: ${missingRequired.join(', ')}.`,
      });
    }
    if (
      projectType !== null &&
      preferredProjectTypes.size > 0 &&
      !isPreferredProjectType &&
      !isExcludedProjectType
    ) {
      concerns.push({
        code: 'project_type_not_preferred',
        message: 'The opportunity project type is not in the preferred project types.',
      });
    }
    if (
      experienceEvidenceScore !== null &&
      experienceEvidenceScore > 0 &&
      experienceEvidenceScore < 80
    ) {
      concerns.push({
        code: 'limited_portfolio_evidence',
        message: 'Portfolio evidence demonstrates less than 80% of the requested skill coverage.',
      });
    }
    if (input.opportunity.amountMin !== null || input.opportunity.amountMax !== null) {
      concerns.push({
        code: 'budget_not_comparable',
        message: 'Budget compatibility cannot be scored because the profile rate has no currency.',
      });
    }

    if (isExcludedProjectType) {
      riskFlags.push({
        code: 'excluded_project_type',
        message: 'The opportunity matches an excluded project type.',
      });
    }
    if (requiredCoverage === 0) {
      riskFlags.push({
        code: 'no_required_skills_matched',
        message: 'None of the required skills are present in the developer profile.',
      });
    }
    if (experienceEvidenceScore === 0 && !input.evidenceRetrievalIncomplete) {
      riskFlags.push({
        code: 'no_portfolio_evidence',
        message: 'No retrieved portfolio evidence demonstrates the requested skills.',
      });
    }
    if (input.evidenceRetrievalIncomplete) {
      riskFlags.push({
        code: 'evidence_retrieval_incomplete',
        message:
          'Evidence retrieval was bounded or shortened; coverage describes only retrieved records and does not establish that other evidence is absent.',
      });
    }
    if (noEvaluationSignals) {
      riskFlags.push({
        code: 'insufficient_evaluation_signals',
        message: 'The opportunity has no skills, project type, or comparable budget signal.',
      });
    }

    let recommendation: OpportunityRecommendation = noEvaluationSignals
      ? 'review'
      : recommendationForScoreV1(score);
    if (isExcludedProjectType || requiredCoverage === 0) {
      recommendation = 'skip';
    } else if (requiredCoverage !== null && requiredCoverage < 0.5) {
      recommendation = capRecommendation(recommendation, 'weak_match');
    }

    return {
      opportunity: {
        id: input.opportunity.id,
        title: input.opportunity.title,
        source: input.opportunity.source,
      },
      fit: { overallScore: score, recommendation },
      scores,
      matchedSkills: [...matchedRequired, ...matchedPreferred],
      missingSkills: missingRequired,
      strengths,
      concerns,
      riskFlags,
      relevantEvidence: input.evidence.slice(0, evaluationEvidenceLimit).map((item) => ({
        projectId: item.projectId,
        projectName: item.projectName,
        evidenceId: item.evidenceId,
        title: item.title,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
      })),
      evaluationVersion,
    };
  }
}
