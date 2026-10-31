import { z } from 'zod';
const catalogSchema = z.strictObject({
  estimatedInputTokens: z.number().int().min(1).max(1000000),
  framingTokens: z.number().int().min(1024).max(16384),
  outputTokens: z.number().int().min(16).max(512),
  scenarioTokenCeiling: z.literal(4096),
});
/** Counts and allowlisted measurements only; no test names, errors, keys or payloads. */
export function providerControlReport(
  states: readonly string[],
  runtimeFailure: boolean,
  readinessMeasurements?: readonly unknown[],
) {
  const passed = states.filter((state) => state === 'passed').length;
  const status =
    !runtimeFailure && states.length > 0 && passed === states.length ? 'passed' : 'failed';
  const controls = { total: states.length, passed, failedOrIncomplete: states.length - passed };
  if (readinessMeasurements === undefined)
    return {
      schemaVersion: 1,
      kind: 'mock_openai_provider_contract_validation',
      usageProvenance: 'mock_http_fields',
      liveExecutionEnabled: false,
      status,
      controls,
    } as const;
  const measurement = z.array(catalogSchema).length(1).safeParse(readinessMeasurements);
  const catalog = measurement.success ? measurement.data[0]! : null;
  return {
    schemaVersion: 3,
    kind: 'offline_live_provider_readiness_validation',
    usageProvenance: 'mock_http_fields',
    liveExecutionPerformed: false,
    status: 'blocked',
    offlineControlsStatus: status === 'passed' && measurement.success ? 'passed' : 'failed',
    liveTokenBudgetPreflightStatus: catalog
      ? catalog.estimatedInputTokens + catalog.framingTokens + catalog.outputTokens <=
        catalog.scenarioTokenCeiling
        ? 'passed'
        : 'blocked'
      : 'unverified',
    overallLiveReadiness: 'blocked',
    blockers: [
      ...(!catalog
        ? ['missing_preflight_measurement']
        : catalog.estimatedInputTokens + catalog.framingTokens + catalog.outputTokens >
            catalog.scenarioTokenCeiling
          ? ['token_budget']
          : []),
      ...(status !== 'passed' ? ['offline_controls'] : []),
      'durable_atomic_replay_store',
      'active_model_approval',
      'owner_limits_and_provisioning',
      'live_compatibility_unverified',
    ],
    controls,
    catalogPreflight: catalog
      ? {
          ...catalog,
          fitsPreservedScenarioLimit:
            catalog.estimatedInputTokens + catalog.framingTokens + catalog.outputTokens <=
            catalog.scenarioTokenCeiling,
        }
      : null,
    futureLiveRunRequiresSeparateOwnerApproval: true,
  } as const;
}
