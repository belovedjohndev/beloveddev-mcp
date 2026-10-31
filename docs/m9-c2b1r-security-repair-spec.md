# M9-C2B1R: live authorization and fixture-boundary repair

## Scope and source review

Preserve the 15-file B1 implementation. Repair test-only evaluation authorization, fixture provenance, grant cleanup, reporting and offline wire-schema validation. No live provider requests, charges, model replacement, raised limits, application/domain/authentication/MCP-contract changes, migrations, M8-G imports, commit or push. The requested branch is feat/m9-c2-provider; the prior B1 branch has an identical source tree, so carry the uncommitted changes without resetting files.

## Synthetic fixture authorization and scenario integrity

Only a new trusted setup function in evaluation-fixture.ts may mint the opaque SyntheticAgentFixture capability. It creates its own disposable database using createTestDatabase, applies the original migrations, seeds the existing two-tenant/evidence/opportunity fixtures, generates the six canonical agentScenarios, and composes its own runtime and McpToolGateway. It rejects inherited application rows before seeding, so a modified PostgreSQL template cannot contribute unapproved data. It accepts no database object, principal, prompt, scenario definitions or MCP client from callers. Administrator configuration remains outside provider inputs. Existing composeEvaluationRuntime does not mint capabilities.

The factory privately retains its database/runtime/gateway and immutable canonical scenario definitions. Its public capability is unforgeable through JSON or caller objects. A SHA-256 manifest binds fixture version, owned database identity, seeded data snapshot (all tenant-owned fixture tables), principal and resource identifiers. A deterministic canonical JSON digest binds the selected complete scenario definition, including prompt and independent oracle. Signed approval additionally requires fixtureManifestDigest, scenarioSetDigest and exact scenarioInventory, alongside invocation ID and existing model/budget/pricing fields. The syntheticDataOnly acknowledgement remains necessary but is insufficient without a live fixture capability whose binding matches.

Choose one scenario per signed invocation, enforced as an exact one-element inventory. No multi-scenario approval/coordinator is introduced. Each future suite invocation needs separately signed scenario approvals and fresh owned fixtures. The approved runner accepts a fixture capability and scenario ID, never arbitrary prompts or gateway/client arguments. It resolves the canonical scenario and gateway internally. The fixture is one-shot; closed, forged, reused or differently bound fixtures fail before provider dispatch. Provider controls may mock the fixture authority solely in isolated unit tests with native HTTPS/socket interception; real PostgreSQL tests exercise the actual factory, provenance rejection, canonical gateway and cleanup. No production test-capability issuer or injectable arbitrary-client factory is added.

## LiveGrant ownership, cleanup and replay

Approval verification binds the opaque grant to the actual fixture capability and selected scenario. The approved runner takes exclusive one-shot execution ownership. Independent bounded cleanup attempts include model, SDK gateway/client, SDK server and owned database. Revocation occurs in an outer finally after execution and cleanup, regardless of success, model failure, invalid execution or cleanup failure. Repeated revocation is safe. Revocation makes both existing transports and new transport construction fail. Concurrent/repeated execution cannot continue using the same grant. Preserve existing bounded engine cleanup and fail-safe reports; cleanup failure must remain visible.

Replay sets are process-local, not durable or cross-process atomic. A persistent atomic replay store is required before C2B2. It is not implemented here. Owner keys, approval files, trusted launcher and OS account remain trusted-code boundaries; capabilities do not sandbox malicious JavaScript or a compromised operator.

## Readiness report semantics

Retain legacy C2A mock-report compatibility. The updated readiness report separates offlineControlsStatus, liveTokenBudgetPreflightStatus and overallLiveReadiness. Successful offline controls may return command exit zero while overallLiveReadiness remains blocked. Missing/invalid measurements or failed/incomplete controls produce a nonzero command result. Reports contain only allowlisted counts, statuses, numerical measurements and fixed blocker codes, never prompts, credentials, approvals or private errors.

The measured representative request remains 11733 input + 1024 framing + 256 output = 13013 tokens against the unchanged 4096 ceiling. Record budget preflight as blocked. Also record persistent replay storage, active-model approval, protected owner provisioning and live compatibility verification as C2B2 blockers. A passing safety suite must never advertise live readiness.

## Offline Structured Outputs compatibility

Inspect the exact z.toJSONSchema(wireActionSchema) output. Add a small fail-closed validator for this reviewed non-fine-tuned Structured Outputs profile, including object root, all properties required, closed objects, nested anyOf, local definitions/references, UUID format/pattern and finite numeric constraints. Reject unknown/unsupported keywords, malformed references and invalid constraints. Bound schema traversal and validate definitions even when unused. No arbitrary remote references. Keep application Zod validation and refinements unchanged. Validate the actual exported wire schema before credentials/network and test nested/nullable shapes, reference resolution and rejection paths. This is an offline subset check, not proof that a future API accepts the request.

Official source reviewed: https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas (2026-10-30). The documented base-model subset supports nested anyOf, definitions/references, uuid/pattern and numeric/array restrictions; the root must be a closed object with every property required. Fine-tuned profiles have different restrictions and are not supported by this profile.

## Remaining C2B2 restrictions and verification

The GPT-4.1 mini snapshot remains deprecated; C2B2 must select and explicitly approve an active model/profile. No silent replacement. Token and monetary limits remain owner decisions, and estimates/reservations do not guarantee invoices. No live launcher, durable replay service, actual provider handshake, account-access probe or billable evaluation is authorized by this repair.

Run format:check, verify, db:check, verify:all, eval, eval:agent, eval:provider:test and git diff --check, plus focused regressions. Preserve all 11 migration hashes and all original Docker resources and other worktrees. Use an exact isolated LF checkout if existing baseline CRLF files prevent source formatting checks.

Affected tree:

```text
docs/m9-c2b1r-security-repair-spec.md
packages/mcp/test/
  evaluation-fixture.ts
  agent-evaluation.ts
  provider-live-approval.ts
  provider-live-readiness.test.ts
  provider-evaluation-report.ts
  provider-wire-contract.ts
  openai-provider.ts
  provider-schema-compatibility.ts
  provider-schema-compatibility.test.ts
  provider-fixture.integration.test.ts
vitest.provider-evaluation.config.ts
README.md
docs/implementation-plan.md
```
