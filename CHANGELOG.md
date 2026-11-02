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

## 0.1.0-baseline — 2026-09-30 (pre-hackathon)

The starting point, predating the hackathon submission window. This baseline
was committed to the public repository on day one of new work so that all
submission-period changes are transparent in git history.

**Wallet & metering core** (fork of Autumn, Apache-2.0 — see NOTICE):
- LiteLLM bridge tables (`bridge_audit_log`, `bridge_rate_limits`,
  `wallet_ledger`, `stripe_webhook_events`) and customer bridge columns
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
`docs/DEPLOY.md` (Stripe-era production guide; superseded by the root README).
