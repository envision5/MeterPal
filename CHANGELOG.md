# MeterPal Changelog

All notable changes to MeterPal. Dates use 2026.

## [Unreleased] — built during the PayPal AI Hackathon submission period (2026-10-01 → 2026-11-12)

Everything from `0.1.0-baseline` onward is new work performed during the
hackathon submission window: the PayPal payment rail (Subscriptions catalog,
checkout, PayerID linking, Invoicing), the MeterPal SDKs (TypeScript + Python),
the agent layer (MCP server + demos), the end-user demo app, demo retooling,
documentation, and packaging.

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
