# M9-B deterministic workflow evaluation specification

## Purpose and boundary

Exercise scripted caller workflows through the existing MCP SDK interface against synthetic, real PostgreSQL data. These are deterministic workflow regressions. They do not demonstrate that a live LLM selected tools independently, reasoned correctly, or would avoid unsupported prose. No provider, paid API, new workspace, or dependency is required.

Production domain rules, application use cases, repository adapters, schemas, permissions, migrations, and authentication remain unchanged. Existing SDK, stdio, lifecycle, readiness, limit, and transaction tests retain their responsibilities. The new suite adds composed workflow checks, explicit grounding oracles, side-effect reconciliation, and fail-closed reporting.

## Implementation and execution

Use Vitest with a dedicated configuration and the existing in-memory SDK client/server transport. Calls use all real application use cases, restricted PostgreSQL runtime repositories, and the local request-context provider backed by active database membership. Fixture administration uses the separately provisioned administrator connection only for seeding, independent observations, and membership changes. It is never exposed as MCP context or tool input.

Files: this specification; evaluation contract/helper and unit tests in packages/mcp/test; one workflow.evaluation.integration.test.ts; vitest.evaluation.config.ts; the root eval script; an ignored .evaluation-reports directory; README and implementation-plan documentation. No compiled production module or workspace is added.

The eval command builds first, requires explicit TEST_DATABASE_URL, and uses the same optional local environment-file loading as test:integration. It runs only the four workflows, sequentially, with retries disabled. The normal integration suite also includes them. Each scenario owns a new randomly named database and restricted role through createTestDatabase(mcpRuntime: true). The configured server is only a provisioning endpoint, never a fixture database itself. Never fall back to DATABASE_URL.

## Scenarios and explicit expectations

A - evidence_grounding: get_profile, list_opportunities, search_project_evidence, evaluate_opportunity. A two-tenant fixture has TypeScript/PostgreSQL profile skills, preferred SaaS projects, five years experience, one architecture evidence item per tenant, and a stored SaaS opportunity requiring TypeScript/PostgreSQL and preferring Docker. Assert tenant-local stored field projections, one relevant evidence item, exact evidence IDs and content, independent PostgreSQL relevance ranks, policy v1 scores (skills 80, project type 100, budget null, evidence 80, overall 85), strong_match recommendation, matched required skills, exact findings, and no missing required skills or risk flags. Do not recompute scoring with the production policy as an oracle. Strict result schemas and a golden semantic projection reject unknown fields, unsupported scores, evidence, or findings. Read workflows leave notes and audits unchanged.

B - authorization_isolation: get_project for tenant B while the trusted principal is in A returns NOT_FOUND. Only the scoped project lookup is permitted; child repositories are not accessed. Change the same principal's stored membership to viewer, then create_project_note returns FORBIDDEN without calling the protected creation repository. This also proves membership is revalidated between calls. Notes and audits remain unchanged.

C - note_idempotency: create_project_note three times: initial creation, exact same actor/tenant/key/payload, then conflicting content with the same key. Expect created=true, then created=false with the original note identity and timestamp, then safe CONFLICT. Reconcile database rows: exactly one added note and one matching audit, creation requestId retained in the audit, no retry/conflict audit. These are explicit scenario steps, never automatic mutation retries.

D - safe_failure: get_project for a missing resource returns NOT_FOUND; deactivate the principal's membership, then get_profile returns UNAUTHENTICATED without profile access. Error responses contain only the existing safe classification/message/requestId, no structured success or invented domain facts. Notes and audits remain unchanged.

list_projects and get_blockers remain covered by existing contract and PostgreSQL suites; this initial evaluation does not claim a new workflow for every tool. All eight implementations are reused in the evaluation composition.

## Definitions, comparison, and reporting

Strict Zod definitions enumerate four IDs, permitted tool sequences, and required check IDs. Validate definitions before fixture provisioning. There is no executable external scenario/plugin loader. Negative unit controls deliberately falsify scores/evidence, scenario metadata, and safe error envelopes to prove evaluation failures are detected.

Publish a new JSON file per invocation under ignored .evaluation-reports, using exclusive creation and private file permissions where supported. Schema version 1 reports deterministic_workflow_regression, overall and independent runner pass/fail, and one record per scenario with expected/observed tool names, completed check IDs, and safe failure codes. Fixture UUIDs, database URLs, request/response bodies, raw assertion messages, SQL, stacks, and environment contents are omitted. File names and fixture identities may vary; deterministic means the fixed ordered workflow and semantic expectations, not byte-identical timing or random identifiers.

The dedicated reporter emits only allowlisted outcomes and safe diagnostics. Missing, skipped, duplicated, unknown, malformed, incomplete, or failed scenarios fail the report and process. Setup, collection, unhandled, cleanup, and report-publication errors also fail closed. Standard developer verification still uses its existing Vitest diagnostics; do not claim universal sanitization of every toolchain startup error.

## Resource lifecycle and failure behavior

No automatic operation retries. Stop a scenario on its first failed expectation. In finally, independently attempt SDK client closure, server closure, and fixture cleanup using cleanupTestResources. Existing integration hooks provide pending-setup and final fixture cleanup. Record cleanup failure as failure even when workflow checks passed. Fixture ownership/OID checks guard teardown; cleanup targets only invocation-created databases and roles. Never delete existing volumes, containers, databases, or other worktrees. Each workflow has a 60-second Vitest budget for provisioning and execution; existing bounded fixture cleanup deadlines still apply; abrupt process termination can still require operator recovery of an owned test database.

## Acceptance and limitations

Run focused definition/report/grounding tests, the new eval command against real PostgreSQL, relevant integration tests, format:check, verify, diff --check, and verify:all where feasible. Preserve original migration hashes. Exercise a failing evaluation invocation to prove nonzero exit and safe machine reporting. No migration generation, application changes, security-gate exceptions, M8-G imports, commits, or publishing.

This suite validates a programmed caller's interpretation of structured results, not arbitrary natural-language claims. It does not replace live-agent evaluation, packaged stdio/container checks, security release gates, production authentication, or operational recovery testing. Future slices may add adversarial model-output evaluation, more workflows, and provider-independent live-agent adapters under a separate approved specification.

## Checkout verification note

This existing Windows worktree still materialized 128 unchanged baseline files as CRLF before M9-B, despite the merged LF attributes policy. Its initial format:check and verify fail on those files. Do not reformat unrelated source to hide that condition. Verification uses a fresh isolated local checkout with core.autocrlf=true, the committed .gitattributes policy, and only the M9-B overlay. Original migration hashes must match there and in the working tree. No system-wide Git setting or other worktree is changed.
