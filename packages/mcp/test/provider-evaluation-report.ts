/** Counts only: never echo test names, assertion messages, provider payloads or configuration. */
export function providerControlReport(states: readonly string[], runtimeFailure: boolean) {
  const passed = states.filter((state) => state === 'passed').length;
  return {
    schemaVersion: 1,
    kind: 'mock_openai_provider_contract_validation',
    usageProvenance: 'mock_http_fields',
    liveExecutionEnabled: false,
    status: !runtimeFailure && states.length > 0 && passed === states.length ? 'passed' : 'failed',
    controls: { total: states.length, passed, failedOrIncomplete: states.length - passed },
  } as const;
}
