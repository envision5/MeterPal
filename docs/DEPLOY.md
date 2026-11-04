# Deploying MeterPal

MeterPal is a metering and billing server plus a metered AI gateway. PayPal is
the money rail: **Orders v2** for credit packs, **Subscriptions** for plans,
**Invoicing** for overage, and **webhooks** that grant entitlements the moment
money lands.

```
                       +--------------------------------------------+
                       |              PayPal (sandbox)               |
                       |  Orders v2 - Subscriptions - Invoicing      |
                       +-------+----------------------+---------------+
        approval link       |                      |  webhooks
        (checkout)          |  capture / activate   |  (signature-verified,
                             v                      |   idempotent)
  +------------------+  /check +     +--------------------------------------------+
  |   your app      |  /track_tokens|          MeterPal billing server           |
  |  + @meterpal/sdk|-------------->|  wallet ledger - credit systems - catalog   |
  +------------------+   402 on broke|  PayPal adapter - gateway key provisioning|
                             |       +---------------------+------------------+
                             |                     Postgres + Redis
                             v
                  +---------------------------+
                  |  metered AI gateway        |  every call: pre-authorize ->
                  |  (LiteLLM + MeterPal      |  serve -> meter
                  |   usage hook)              |  tokens -> debit credits
                  +------------+--------------+
                               v
                    AI providers (or the mock LLM)
```

This guide describes the PayPal-native deployment. PayPal is the only payment
rail MeterPal needs; the PayPal adapter lives in
`billing/server/src/external/paypal/`.

---

## 1. Prerequisites

| Need | Notes |
|---|---|
| [Bun](https://bun.sh) | Runs the billing server |
| Python 3.10+ | Runs the gateway proxy and the demo scripts |
| Docker + Docker Desktop | Postgres and Redis for the local stack |
| A PayPal developer account | Sandbox is enough for everything below |

PayPal sandbox credentials live in the Developer Dashboard under **Apps &
Credentials -> Sandbox**. You need a client id and secret. If you cannot
complete account sign-up from your country, the PayPal hackathon Discord is
the place to ask -- see the README.

---

## 2. Phase 1 -- Infrastructure

```bash
docker compose up -d
```

That brings up four services:

| Service | Purpose |
|---|---|
| `postgres-billing` | MeterPal billing DB (port 5433) |
| `postgres-gateway` | LiteLLM proxy DB (port 5434) |
| `redis-billing` | MeterPal hot path: atomic wallet debits, admission control (port 6380) |
| `redis-gateway` | LiteLLM spend counters (port 6381) |

Run the database migrations:

```bash
cd billing
bun install
bun run db                 # schema migrations
bun run migrate-functions  # plpgsql functions used by the deduction path
```

The deduction functions live outside the schema migrations, so
`migrate-functions` is required -- without it every debit 500s.

---

## 3. Phase 2 -- The billing server

```bash
cd billing/server
cp .env.example .env       # then fill it in (see below)
bun run dev                # http://localhost:8080
```

The `.env` that matters most:

```bash
# --- PayPal ---
PAYPAL_ENV=sandbox                       # or live
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...                    # or let the bootstrap register it
PAYPAL_CERT_CACHE_DIR=./.cache/paypal-certs

# --- What PayPal money funds ---
METERPAL_CREDIT_FEATURE_ID=ai_tokens     # 1 credit = 1 USD of computed model cost

# --- Where the buyer lands after approving ---
METERPAL_CHECKOUT_RETURN_URL=https://app.yourdomain.com

# --- Public base URL of THIS server (PayPal redirects the browser here) ---
METERPAL_PUBLIC_URL=https://billing.yourdomain.com
```

### Webhook endpoint

The server exposes one webhook endpoint in three shapes:

| Route | Use |
|---|---|
| `POST /webhooks/paypal` | single-tenant |
| `POST /webhooks/paypal/{org_id}` | per-tenant, id-less |
| `POST /webhooks/paypal/{org_id}/{webhook_id}` | per-tenant, merchant-pasted form |

MeterPal subscribes to exactly the event types it handles -- the list is
defined once in `billing/server/src/external/paypal/webhookEventTypes.ts` so
registration and dispatch can never drift:

- Subscription lifecycle: `BILLING.SUBSCRIPTION.CREATED / ACTIVATED /
  RE-ACTIVATED / UPDATED / SUSPENDED / CANCELLED / EXPIRED /
  PAYMENT.FAILED`
- Money in and out: `PAYMENT.SALE.COMPLETED / REFUNDED / REVERSED`,
  `PAYMENT.CAPTURE.COMPLETED / REFUNDED / REVERSED`
- Disputes: `CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED`
- Overage: `INVOICING.INVOICE.PAID`
- Early signal: `CHECKOUT.ORDER.APPROVED`

Register the webhook in the PayPal Developer Dashboard (or let
`demo/bootstrap.py` do it through a tunnel) pointing at
`https://billing.yourdomain.com/webhooks/paypal`.

---

## 4. Phase 3 -- The metered gateway

The gateway is the LiteLLM proxy with the MeterPal usage-billing hook. No
LiteLLM core files are modified.

```bash
cd gateway
cp .env.example .env
pip install -e .
litellm --config config.yaml --port 4000
```

The bridge configuration:

```bash
PAB_BASE_URL=http://localhost:8080/v1
PAB_API_KEY=am_sk_...
PAB_FEATURE_ID=ai_tokens
PAB_CUSTOMER_HEADER=user       # which header identifies the end user
PAB_ADMIT_MODE=block           # block = refuse with 402, instead of letting it through
PAB_REQUIRED_BALANCE=1.0       # minimum headroom a call may consume
PAB_FAIL_MODE=closed           # fail closed in production; open serves unbilled inference
PAB_MODEL_ID_MAP={"my-alias":"custom/my-model"}
```

Two of these carry real money consequences:

- `PAB_ADMIT_MODE=block` is what turns a low balance into a **402 before the
  provider is touched**. With `allow`, the call goes through unbilled.
- `PAB_FAIL_MODE=closed` means a MeterPal outage refuses traffic instead of
  serving it for free. `open` is a development convenience, not a production
  setting.

---

## 5. Phase 4 -- Customer UI integration

The SDK ships customer-facing React components and an inference client. It is
workspace-local, not published to npm yet:

```bash
# from the repo root
bun add file:./sdk/typescript
```

The React components (`CreditsBadge`, `LowBalanceBanner`, `PlanCard`,
`TopUpModal`, `UsageHistoryPanel`, `CostTooltip`) read credits, plans and
usage through your app's own backend routes, so the secret key never ships to
the browser.

The components build on `autumn-js` -- the upstream client library MeterPal
inherits from its fork -- so the provider component is still `<AutumnProvider>`
and the backend adapter is still `autumn-js/backend` (express / hono / next /
fetch). See `docs/customer-ui.md`.

Mount a customer-portal page at `/account/billing` in each app, and ship the
`meterpal` CLI with it:

```bash
bunx meterpal init          # detects the framework, writes the handler + env
```

For the server side, the inference client is OpenAI-shaped:

```ts
import { createMeterPal } from "@meterpal/sdk";

const meterpal = createMeterPal({ apiKey: process.env.METERPAL_SECRET_KEY });

const completion = await meterpal.chat.completions.create({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "hi" }],
	user: "cus_123",          // the end user being billed
});
// completion.meterpal.credits_charged
```

A `402` surfaces as `InsufficientBalanceError`, carrying `balance` and
`requiredCredits`, and `error.topUp()` returns the PayPal checkout URL.

---

## 6. Phase 5 -- Going to live

1. Switch `PAYPAL_ENV` to `live` and use live client id / secret.
2. In the PayPal Developer Dashboard, move the app to a live account and
   complete business verification.
3. Register the live webhook endpoint and confirm every event type in
   `PAYPAL_WEBHOOK_EVENT_TYPES` is subscribed.
4. Test a real $1 charge end to end (refund it after) before opening traffic.
5. Set `PAB_FAIL_MODE=closed` and `PAB_ADMIT_MODE=block`.

---

## 7. Production checklist

### Secrets
- [ ] No secrets in the repo. `.env`, `.env.*` and `*.session_token` are
      gitignored; only `.env.example` is tracked.
- [ ] PayPal client secret, `METERPAL_SECRET_KEY`, `ENCRYPTION_PASSWORD` and
      `BETTER_AUTH_SECRET` sourced from Vault / AWS Secrets Manager / Infisical
- [ ] `ENCRYPTION_PASSWORD` is 32+ random bytes, not a passphrase
- [ ] No `live` PayPal credentials or `sk_live_*` patterns anywhere in the tree

### Webhooks
- [ ] PayPal webhook signatures verified (`webhookSecurity.ts`), with the
      signing certificates cached under `PAYPAL_CERT_CACHE_DIR`
- [ ] Every handler idempotent on the PayPal event / capture / invoice id
- [ ] Webhook endpoint reachable from PayPal over TLS

### Money correctness
- [ ] `PAB_ADMIT_MODE=block` and `PAB_FAIL_MODE=closed`
- [ ] `bun run migrate-functions` ran in the deploy (deduction functions are
      not part of the schema migrations)
- [ ] Metering events dedupe on the gateway call id, so bridge retries cannot
      double-bill
- [ ] Redis is configured for persistence (`--appendonly yes`)

### Data and access
- [ ] TLS 1.2+ enforced; reverse proxy sends
      `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a CSP
- [ ] MeterPal API keys scoped minimally (`balances.read`, `balances.write`)
- [ ] No PII in logs -- request bodies, customer names, emails
- [ ] Per-tenant PayPal credentials are isolated per org

### Compliance
- [ ] Terms of Service and Privacy Policy published
- [ ] Data Processing Agreements signed with the model providers you call

---

## 8. Operator action list

The build is complete and the test suites are written. To actually run it:

1. **Start Docker Desktop**, then `docker compose up -d`.
2. **Get a PayPal sandbox app.** Copy the client id and secret into
   `billing/server/.env`.
3. **Get provider API keys** in test mode (OpenAI, Anthropic, Google all offer
   free test keys). Drop them into `gateway/.env`.
4. **Register the webhook** and set `METERPAL_CHECKOUT_RETURN_URL` /
   `METERPAL_PUBLIC_URL`.
5. **Run the demo** to see the billing loop with no keys at all:
   `python demo/bootstrap.py && python demo/run_demo.py`.

### Verified

- PayPal subscription loop end to end against the sandbox, including the
  buyer-facing approval and the EC-token return mapping
- Webhook signature verification and idempotency
  (`billing/server/tests/paypal_webhook.test.ts`)
- The gateway metering bridge (`gateway/tests/test_meterpal_billing.py`,
  15 tests)

### Not done (needs your action)

- Docker daemon not started in this environment, so the full integration
  suite has not been executed end to end here
- Real end-to-end charge not executed with live PayPal keys
- Production hosting not provisioned -- this guide describes the path but does
  not execute it
- Browser-driven UI testing not performed
