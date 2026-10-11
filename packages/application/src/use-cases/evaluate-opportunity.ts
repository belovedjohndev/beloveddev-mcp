import {
  EvaluationPolicyV1,
  evaluationEvidenceLimit,
  normalizeEvaluationCollectionV1,
  normalizeEvaluationValueV1,
  type OpportunityEvaluationResult,
} from '@beloveddev/domain/evaluation-policy-v1';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { evaluateOpportunityInput, parseReadInput } from '../read-inputs.js';
import type {
  DeveloperProfileRepository,
  EvidenceRepository,
  OpportunityRepository,
} from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';

export const opportunityEvaluationEvidenceLimit = evaluationEvidenceLimit;

const evidenceQueryLengthLimit = 1000;

function literalSearchText(value: string): string {
  // Embedded quotes would terminate a websearch phrase. Treat them as separators.
  return value.replaceAll('"', ' ').replace(/\s+/gu, ' ').trim();
}

function buildEvidenceQuery(input: {
  readonly requiredSkills: readonly string[];
  readonly preferredSkills: readonly string[];
  readonly projectType: string | null;
  readonly title: string;
}): { query: string | null; incomplete: boolean } {
  const skills = normalizeEvaluationCollectionV1([
    ...input.requiredSkills,
    ...input.preferredSkills,
  ]);
  if (skills.length > 0) {
    const terms: string[] = [];
    let queryLength = 0;
    let incomplete = false;
    for (const skill of skills) {
      const text = literalSearchText(skill);
      const term = `"${text}"`;
      const addedLength = term.length + (terms.length === 0 ? 0 : 4);
      if (text !== skill) incomplete = true;
      if (text === '' || queryLength + addedLength > evidenceQueryLengthLimit) {
        incomplete = true;
        continue;
      }
      terms.push(term);
      queryLength += addedLength;
    }
    return { query: terms.length === 0 ? null : terms.join(' OR '), incomplete };
  }

  const fallback =
    (input.projectType === null ? '' : normalizeEvaluationValueV1(input.projectType)) ||
    normalizeEvaluationValueV1(input.title);
  const text = literalSearchText(fallback);
  // Slice by UTF-16 length (the repository contract) without splitting a surrogate pair.
  let prefix = text.slice(0, evidenceQueryLengthLimit - 2);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.trimEnd();
  return {
    query: prefix === '' ? null : `"${prefix}"`,
    incomplete: prefix !== fallback,
  };
}

export class EvaluateOpportunity {
  constructor(
    private readonly repositories: {
      opportunities: Pick<OpportunityRepository, 'getById'>;
      profiles: DeveloperProfileRepository;
      evidence: Pick<EvidenceRepository, 'search'>;
    },
    private readonly authorization: AuthorizationPolicy,
    private readonly policy: Pick<EvaluationPolicyV1, 'evaluate'> = new EvaluationPolicyV1(),
  ) {}

  async execute(
    context: RequestContext | null,
    input: unknown,
  ): Promise<OpportunityEvaluationResult> {
    const scope = this.authorization.require(context, 'opportunities:evaluate');
    const { opportunityId } = parseReadInput(evaluateOpportunityInput, input);
    return applicationOperation(async () => {
      const tenantId = scope.tenantId;
      const opportunity = await this.repositories.opportunities.getById({
        tenantId,
        opportunityId,
      });
      if (opportunity === null) throw new ApplicationError('NOT_FOUND');

      const profile = await this.repositories.profiles.getByTenant({ tenantId });
      if (profile === null) throw new ApplicationError('NOT_FOUND');

      const retrieval = buildEvidenceQuery(opportunity);
      const evidencePage =
        retrieval.query === null
          ? { items: [], nextPosition: null }
          : await this.repositories.evidence.search({
              tenantId,
              query: retrieval.query,
              limit: opportunityEvaluationEvidenceLimit,
            });
      const evidence = evidencePage.items.map(
        ({ projectId, projectName, evidenceId, title, summary, skills, relevanceScore }) => ({
          projectId,
          projectName,
          evidenceId,
          title,
          summary,
          skills,
          relevanceScore,
        }),
      );
      return this.policy.evaluate({
        profile,
        opportunity,
        evidence,
        evidenceRetrievalIncomplete: retrieval.incomplete || evidencePage.nextPosition !== null,
      });
    });
  }
}
