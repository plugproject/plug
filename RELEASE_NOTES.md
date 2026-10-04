# Plug 0.1.0-alpha.2 — local alpha

Verified locally on 2026-10-04 using Node 24.21.0. Public URL: **not deployed**.
Release commit: **not assigned**; this repository began without commits and the
implementation is currently an uncommitted workspace change. No production SLO or
adoption claims are made.

## Implemented

- Canonical `0.1-alpha.2` TypeScript contracts, generated JSON Schema, standalone
  AJV validators and schema reference; synchronized examples and draft SEP pages.
- Six deterministic patterns/compositions with direct baseline, exact-policy
  coverage replay, bounded age/scheduling/load reasoning, evidence, tradeoffs and
  implementation/configuration/report exports.
- Manual JSON/YAML, MCP 2025-11-25 tools/list and A2A 1.0 Agent Card metadata intake.
- React/Express playground, isolated HTTP demo sandboxes, scoped action tokens,
  quotas, memory/lifetime caps, response validation and cancellation/cleanup.
- Reference package, CLI, real 15-second flight source, continuous trusted-local
  inventory example, documentation preview, CI and Render deployment configuration.

## Verified

- Clean `npm ci`: successful; dependency audit reported zero vulnerabilities.
- `npm run check`: TypeScript, ESLint, formatting, generated-artifact drift,
  examples, documentation links/SEP metadata, and **48 passing tests**.
- `npm run build`: reference package, declarations, schema, service and UI build.
- `PLUG_TEST_PRODUCTION=1 npm run test:browser`: **3 passing Chromium tests**.
  Own descriptions, changed constraints/verdicts, downloads, mobile width, MCP
  metadata review and canonical browser validation passed under the production CSP.
  The full-speed proof observed real 15-second warmup, an eligible fast cache hit,
  a changed source version after the later 60-second refresh, expiry and cancellation.
- `npm run test:package`: a local tarball was installed outside the workspace;
  contract, field mappings, exact key, profile and endpoint were customized, then
  analyzed and executed against a separate loopback HTTP service. TypeScript
  consumer imports and bundled schema availability passed.
- `npm run serve:docs`: rendered quickstart and code examples returned HTTP 200.
  Desktop and mobile playground screenshots were inspected.

The fixture recommends `scheduled-cache`, 60,000 ms cadence, a conservative
86,000 ms age envelope, and 0.98 usable-hit replay coverage. The synthetic
within-target hit assumption yields 0.9702 target success. These are estimates
under declared synthetic assumptions, not measured production traffic guarantees.
Input hash: `67f171929ac7196ac47bfedea59a131b3edfbdb6a834937cc7be9cf22bf203c4`.
Design hash: `0208b69c5676dd668ccc1536bfed07959a876848e085fc7929a1608b7e619291`.

## Remaining release steps

1. Owner chooses a distribution license. Until then the package remains private
   and UNLICENSED; no open-source or public npm publication is claimed.
2. Owner configures a private security reporting route and actual maintainers.
3. Commit/push the reviewed implementation and connect the repository to Render
   using `render.yaml`. Supply `APP_ORIGIN` and verify the hosting proxy topology
   before setting `TRUST_PROXY_HOPS`. No Render API credential was available here.
4. On the host-provided domain, repeat streaming, real source/refresh, isolation,
   cancellation, per-IP and four-session-cap smoke checks. Record the deployed
   commit and public URL here. Free-tier cold starts remain a documented limitation.

The bootstrap SEP remains draft pending actual owner review. Multi-instance
operation, durable jobs/cache, restart continuity, authenticated MCP/A2A execution
and customer endpoint execution in the hosted playground are outside this alpha.
The local continuous runner is explicitly selected by trusted application code;
hosted requests cannot extend the 120-second session lifetime. The production UI
bundle is about 125 KB gzip; Vite reports a raw minified chunk-size warning.
Five outside users and two own-system integrations are learning targets, not
claimed adoption.
