# MeterPal Changelog

All notable changes to MeterPal. Dates use 2026.

## [Unreleased] — built during the PayPal AI Hackathon submission period (2026-10-01 → 2026-11-12)

Everything from `0.1.0-baseline` onward is new work performed during the
hackathon submission window: the PayPal payment rail (Subscriptions catalog,
checkout, PayerID linking, Invoicing), the MeterPal SDKs (TypeScript + Python),
the agent layer (MCP server + demos), the end-user demo app, demo retooling,
documentation, and packaging.

**PayPal subscription switch — end to end (2026-11-02)**
- The plan switch now completes the whole PayPal loop: click → a real PayPal
  subscription on the merchant's plan → buyer approves → the browser returns
  → the plan is attached with its allowance. Verified against the PayPal
  sandbox, including the buyer-facing approval.
- PayPal is the authority for subscription state; the DB flag is no longer
  trusted. Repeat clicks reuse the pending approval instead of minting an
  orphan subscription; paid→paid plan changes revise rather than double-bill;
  cancellation sends the `reason` PayPal requires.
- Post-approval redirect resolution: PayPal redirects with the express-checkout
  token of the order it created for the approval, not the BA- token from the
  approval link. The return route now carries a MeterPal-minted checkout token
  in the return URL and resolves the subscription through it, with a
  payer-match fallback for links created earlier.
- Free plans (no recurring price) downgrade correctly: the paid PayPal
  subscription is cancelled and the plan is applied locally, with no checkout.
- Approval intents settle on activation instead of staying `pending`.

**LiteLLM bridge (2026-11-02)**
- Fixed the drizzle column names in `internal/keys/litellmKeys.ts`
  (`customers.litellm_virtual_key`, `bridge_audit_log.customer_id` /
  `.litellm_key_hash`); the camelCase properties were `undefined`, so no
  customer ever received a virtual key.
- LiteLLM key aliases are unique: an orphaned key (customer deleted and
  recreated) is now deleted and re-minted instead of failing forever.

**Architecture spec (2026-11-02)**
- `docs/architecture.md` — the merchant-facing product design: multi-tenant
  PayPal, the served-model and cost catalog, the shared metered gateway, the
  OpenAI-compatible SDK client, the install/CLI step, the onboarding wizard,
  the data-model and API changes, tenant-isolation requirements, and a phased
  rollout with acceptance criteria.

**Live metering (2026-11-02)** — P0 of the architecture plan
- The gateway now runs with its configuration in the environment, so the
  MeterPal bridge is actually enabled. Inference calls are metered again:
  a call through `:4000` debits the customer's wallet (verified in the
  browser — a chat message shows up in "Recent requests" and the credit
  balance drops).
- `LITELLM_MASTER_KEY` has a single source: `gateway/.env` is canonical and
  the billing server reads it from there, so the gateway and the server can
  never disagree about the key. The duplicate copy in
  `billing/server/.env` is gone. An explicit environment variable still wins.
- Windows: LiteLLM's query-engine liveness probe used `os.kill(pid, 0)`,
  which CPython maps to `TerminateProcess` — the probe killed the very engine
  it was inspecting, so every Prisma call failed and the proxy shut down.
  One shared, platform-safe probe (`gateway/litellm/proxy/process_probe.py`)
  now serves every call site. See `gateway/PATCHES.md`.
- Windows: prisma-client-py >= 0.13 stores the query engine in a
  `__slots__`-managed attribute, so LiteLLM's write to the old
  `_Prisma__engine` raised `AttributeError` and left the proxy without a
  database. The write now targets whichever attribute the installed client
  has.
- The stack launcher is one implementation again: `scripts/lib/stack.ps1`
  holds the single service table and the launch/stop logic, and
  `scripts/start.ps1` and `scripts/restart.ps1` both use it. Every service
  runs as a Windows scheduled task, so it has a real console (Prisma's engine
  needs one) and outlives the shell that started it. A restart now waits for
  the port to be released before starting the replacement.
- `scripts/fix-ps1-encoding.py` keeps the PowerShell scripts ASCII-only and
  BOM-encoded so Windows PowerShell 5.1 parses them correctly.

**Multi-tenant PayPal (2026-11-02)** — P1 of the architecture plan
- A merchant's PayPal account is theirs, not the platform's. Every PayPal call
  now goes through a client built from the org's own row
  (`organizations.paypal_config`), with the client secret encrypted at rest and
  the access token cached in Redis per org. `external/paypal/paypalClient.ts`
  replaces the process-global client; the org row wins, and the `PAYPAL_*` env
  vars remain as the back-compat fallback for single-tenant deployments.
- Per-org configuration is split per environment (`paypal_config.test` /
  `.live`), like a PayPal REST app. The env fallback applies only when the org
  has no `paypal_config` at all — once an org manages its own PayPal the
  shared account never bills for it.
- Webhooks move to `POST /webhooks/paypal/:orgId/:webhookId`. The org comes
  from the path, so the signature is verified against THAT org's webhook id,
  and the environment is resolved from the webhook id. Event dedupe reuses
  the durable `webhook_events` table with a `paypal:` prefix rather than adding a second
  table for the same job.
- The dashboard gets a PayPal section (Settings > Integrations): connect with a
  client id and secret, verified against PayPal BEFORE they are stored, the
  webhook URL to paste into the merchant's app, and a disconnect.

**The merchant's price sheet (2026-11-02)** — P2 of the architecture plan
- What a merchant charges is the merchant's decision, so a provider price
  change cannot move it. `served_models` is the per-org price sheet, split by
  environment: `model_id` (the billable id), `upstream_model` (the LiteLLM
  deployment), `enabled`, input/output cost per 1M tokens, and a markup that is
  NULL when the plan's markup should apply. The provider price (models.dev) is
  only the SEED used when a row is created.
- The track path prices from the org's row when it has one and falls back to
  the old path when it does not, so an org that never opens the Models tab
  behaves exactly as before.
- Price pinning: `/check` resolves the unit rates and returns them as
  `pricing.pinned_rates`; the gateway passes them back on `/track_tokens`, and
  the settle uses them verbatim (`markup_source: "pinned"`). The reservation
  and the charge are the same price even if the merchant edits their sheet in
  between.
- The dashboard gets a Models tab (Catalog > Models) with inline-editable
  prices, a markup, and a margin preview against the provider price.
  Verified end to end: a call at the feature's 20/80 cost 0.36; after setting
  60/100 in the dashboard the same call cost 1.76.

**The inference proxy and the SDK (2026-11-02)** — P3 of the architecture plan
- `POST /v1/chat/completions` on the billing server: the merchant's app calls
  it with its MeterPal secret key (or a customer virtual key). The proxy
  resolves the org, the model it may serve and the end user being billed, then
  forwards to the shared gateway with that customer's virtual key — the
  gateway's bridge stays the single metering authority. The response is the
  OpenAI shape verbatim plus a `meterpal` block with what the call cost.
- The billable model id is resolved per org: the gateway names a model its own
  way (`demo-gpt`) while the merchant's price sheet names it the way they bill
  it (`custom/demo-gpt`). A single global alias map cannot serve two merchants
  selling the same upstream model under different ids, so the org's own sheet
  is the authority.
- `@meterpal/sdk` — `createMeterPal({ apiKey })` gives a merchant's server a
  chat client whose calls are metered. The secret key stays on the server; the
  client mints a per-customer virtual key on first use and caches it
  process-wide. Errors are typed, because the paywall is the product:
  `InsufficientBalanceError` carries `topUp()`, which opens the PayPal
  checkout.
- `npx @meterpal/sdk init` detects the framework (Next, Hono, Express,
  Fastify), writes the environment and a server-side handler that keeps the key
  off the browser.
- The demo app now uses the SDK instead of a hand-rolled proxy, and shows the
  merchant's own price sheet as a model picker with the charge under every
  reply.

**Gateway hardening (2026-11-02)** — P4 of the architecture plan
- The virtual key carries the tenant: `<org>:<customer>` is the key's
  identity, so the gateway resolves which merchant a call belongs to from the
  key itself. A `user` header the caller controls can no longer redirect a
  charge, and an admin key (no tenant) is refused outright
  (`missing_billing_identity` / `unresolvable_tenant`) instead of billing a
  guess.
- The gateway presents a shared `PAB_TRUST_SECRET` (single source:
  `gateway/.env`) and names the tenant it resolved; the billing server loads
  that org and looks the customer up inside it, so a request naming another
  org's customer is refused, not billed.
- The price sheet is the gateway's allow-list: each key carries the org's
  enabled upstream models, kept in sync when the merchant edits the sheet
  (`syncOrgLitellmKeys` on served-model upsert/delete).
- Two ceilings. Per customer, rpm/tpm on the key, seeded from the plan (free
  20/50k, pro 120/400k, pro_plus 300/1M, ultra 600/4M). Per org, rpm/tpm in
  the bridge, counted in the gateway's Redis so the ceiling holds across every
  gateway instance.
- `scripts/verify-tenant-isolation.ps1` drives the gateway directly and
  asserts all of it: the key beats a spoofed customer header, an admin key is
  refused, a model that is not on the price sheet is refused, and an unknown
  key is refused.

## 0.1.0-baseline — 2026-09-30 (pre-hackathon)

The starting point, predating the hackathon submission window. This baseline
was committed to the public repository on day one of new work so that all
submission-period changes are transparent in git history.

**Wallet & metering core** (fork of Autumn, Apache-2.0 — see NOTICE):
- LiteLLM bridge tables (`bridge_audit_log`, `bridge_rate_limits`,
  `wallet_ledger`, `webhook_events`) and customer bridge columns
  (`litellm_virtual_key`, `paypal_subscription_id`, `paypal_plan_id`,
  `paypal_payment_status`) — migration `0085_shallow_iron_man`.
- Virtual key provisioning (`litellmKeys.ts`, `litellmWebhookTriggers.ts`).
- Balance plumbing fixes: plpgsql function installer at boot, inline event
  batch fallback in development, Redis v2 cache pool config.

**PayPal webhook adapter** (pre-hackathon, ~630 lines):
- `external/paypal/client.ts` — OAuth + idempotent REST client (sandbox/live).
- `external/paypal/webhookSecurity.ts` — local crypto webhook signature
  verification (CRC32 + cert pinning + SHA256withRSA, timestamp freshness).
- `external/paypal/webhookRouter.ts` + `runPaypalWebhookHandlers.ts` —
  `BILLING.SUBSCRIPTION.*` / `PAYMENT.SALE.*` / `PAYMENT.CAPTURE.*` lifecycle
  wired to entitlement provisioning and wallet ledger grants (idempotent).
- `external/paypal/orders.ts` — Orders v2 create/capture/refund wrappers.

**AI gateway** (fork of LiteLLM, MIT — see NOTICE):
- `litellm/integrations/autumn_billing.py` — pre-call admission control
  (`/check` → HTTP 402 before the provider is touched), post-call usage
  tracking (`/track_tokens`, `/balances.finalize` commit/release), fail-open /
  fail-closed modes, model-id mapping. 14 unit tests.
- `config.yaml`, `.env.example` wiring.

**Customer UI components** (`apps/billing-ui`, now `sdk/typescript`):
- CreditsBadge, LowBalanceBanner, PlanCard, TopUpModal, UsageHistoryPanel,
  CostTooltip + smoke tests (known build bugs at baseline; fixed post-baseline).

**Demo** (`demo/`): mock LLM provider, bootstrap seeding, 6-phase billing-loop
walkthrough, all without real payment or provider keys.

**Docs**: `docs/plan.md`, `docs/bridge.md`, `docs/customer-ui.md`,
`docs/DEPLOY.md` (production guide; rewritten as a PayPal-native
guide during the submission period).
