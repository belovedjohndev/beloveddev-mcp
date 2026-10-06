import type { DeveloperProfileRepository } from '../repositories.js';
import type { AuthorizationPolicy, RequestContext } from '../request-context.js';
import { ApplicationError, applicationOperation } from '../application-error.js';
import { getProfileInput, parseReadInput } from '../read-inputs.js';

export class GetProfile {
  constructor(
    private readonly profiles: DeveloperProfileRepository,
    private readonly authorization: AuthorizationPolicy,
  ) {}
  async execute(context: RequestContext | null, input: unknown) {
    const scope = this.authorization.require(context, 'profile:read');
    parseReadInput(getProfileInput, input);
    return applicationOperation(async () => {
      const profile = await this.profiles.getByTenant({ tenantId: scope.tenantId });
      if (!profile) throw new ApplicationError('NOT_FOUND');
      return {
        profile: {
          id: profile.id,
          displayName: profile.displayName,
          headline: profile.headline,
          summary: profile.summary,
          location: profile.location,
          yearsExperience: profile.yearsExperience,
          hourlyRate: profile.hourlyRate,
          availability: profile.availability,
          skills: profile.skills,
          serviceAreas: profile.serviceAreas,
          preferredProjectTypes: profile.preferredProjectTypes,
          excludedProjectTypes: profile.excludedProjectTypes,
          portfolioUrl: profile.portfolioUrl,
          githubUrl: profile.githubUrl,
        },
      };
    });
  }
}
