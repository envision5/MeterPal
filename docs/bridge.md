# Bridging MeterPal and LiteLLM — Integration Guide

> **Who runs the bridge:** MeterPal's own gateway operators. This runbook configures
> the shared, multi-tenant gateway that MeterPal hosts — a merchant never deploys
> the bridge or runs LiteLLM (docs/architecture.md §0: merchants install the SDK
> and swap one import). It is kept as the operator contract for the metering hook.

This is the technical bridge between the two repos you have locally. It is based on direct reads of the source code in `C:\Users\craig\Desktop\AI billing\autumn\` and `C:\Users\craig\Desktop\AI billing\litellm\`, not on documentation summaries.

The short version: **MeterPal is a merchant-side billing backend with a merchant admin dashboard.** The `vite/` dashboard is for the SaaS owner (you) to model products, plans, and prices, view customers and analytics — *not* an end-customer account portal. End customers see the LiteLLM UI you build, which calls MeterPal over HTTP for credit checks and usage recording. MeterPal ships one customer-facing surface (`apps/checkout/`, a hosted checkout page); the rest of the customer UI ("you have X credits", upgrade buttons, usage history) is yours to build into LiteLLM.

The bridge is one Python `CustomLogger` file inside LiteLLM (gates admission and forwards usage to MeterPal) and a small Hono handler inside MeterPal (provisions per-customer LiteLLM virtual keys on subscription lifecycle events). They share a stable event contract — `{customer_id, feature_id, value, idempotency_key, metadata}` for usage, and `{customer_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, request_id}` for AI usage specifically.

---

## 1. What each repo actually does

### MeterPal — `C:\Users\craig\Desktop\AI billing\autumn`

- **Stack.** TypeScript + Bun + Hono + Drizzle ORM/Postgres + Redis + Better-Auth + Zod v4 + PayPal REST SDKs + Trigger.dev + MotherDuck + Sentry/Axiom/Logtail + Infisical (secrets) + Speakeasy (SDK generator). Two surfaces in one monorepo, managed by Turborepo.
- **Layout.**
  ```
  autumn/
  ├── server/src/                  # the Hono billing API (port 8080)
  │   ├── index.ts                  # cluster fork + initInfisical
  │   ├── init.ts                   # Redis/Postgres warmup, Sentry, Trigger.dev, graceful shutdown
  │   ├── initHono.ts               # assembles the Hono app
  │   ├── honoMiddlewares/          # secretKey, customerBlock, customerJwtVersion, idempotency, rateLimit, refreshCache, requestBlock, responseFilter, errorMiddleware, routeHandler (createRoute wrapper)
  │   ├── honoUtils/                # HonoEnv type, ctx augmentation
  │   ├── routers/                  # apiRouter, publicRouter, internalRouter, rpcRouter, chatProxyRouter
  │   ├── db/                       # Drizzle init, prepared statements, replica routing, connection pools
  │   ├── external/                 # 20+ external integrations
  │   │   ├── paypal/               # PayPal REST client, webhook handlers
  │   │   ├── redis/                # Redis client (org-scoped pool, fail-open)
  │   │   ├── tinybird/, motherduck/# analytics
  │   │   ├── hatchet/, trigger.dev/# workflows + SQS batchers for high-volume events
  │   │   ├── svix/                 # outgoing webhooks
  │   │   ├── resend/               # transactional email
  │   │   ├── axiom/, sentry/, logtail/  # observability
  │   │   ├── infisical/            # secrets
  │   │   └── vercel/, aws/         # deployment
  │   ├── cron/                     # scheduled jobs (cycle resets, reconcilers)
  │   ├── queue/                    # background workers
  │   ├── trigger/                  # event triggers (subscription.created, etc.)
  │   ├── _luaScriptsV2/            # atomic Redis operations
  │   │   ├── deduction/            #   decrement balance atomically
  │   │   ├── fullSubject/          #   cached subject state + adjustSubjectBalance.lua
  │   │   ├── fullSubjectDeduction/ # combined read+deduct
  │   │   └── syncDirty/            # flush dirty state to Postgres
  │   └── internal/                 # business modules (28+)
  │       ├── balances/             #   core: track, track_tokens, check, finalizeLock, recalc, thresholdBilling, autoTopUp, usageAlerts
  │       ├── customers/            #   customer lifecycle: attach, cusProducts, pooledBalances, usageWindows
  │       ├── checkouts/            #   processor checkout flows
  │       ├── features/             #   feature definitions; GET /features/ai/model_pricing
  │       ├── products/, plans/     #   product catalog (versions)
  │       ├── events/               #   usage event ingestion + analytics
  │       ├── keys/, orgs/          #   multi-tenant org context
  │       ├── invoices/, billing/   #   invoice + billing ops
  │       ├── rewards/, entities/   #   referral, sub-billable units
  │       └── migrations/           # code-based migrations, NOT SQL files
  └── apps/
      ├── checkout/                 # **the only end-customer-facing UI MeterPal ships** (hosted checkout)
      ├── website/                  # marketing site
      ├── leaf/                     # Slack/Growth internal tool (NOT a customer UI)
      ├── scope-picker/             # dev launcher
      ├── sso-test-idp/, sdk-test/, testbench/  # testing harnesses
      └── docs/                     # documentation
  ```
- **Merchant dashboard.** `vite/` at the repo root (React/Vite SPA, port 3000). Auth via Better-Auth email-OTP/Google/SSO. Used by *you* (the SaaS owner) to model products, plans, features, prices, customers, invoices, test clocks, and view analytics.
- **End-customer surface.** **MeterPal does not ship one.** Your app (the LiteLLM UI, or your existing apps) embeds the SDK or calls the HTTP API. The only end-customer-facing UI in the MeterPal repo is `apps/checkout/` (the hosted checkout page). Everything else — "you have X credits", upgrade buttons, usage history — you build.
- **Public API auth.** Bearer `am_sk_...` (publishable) for merchant-issued keys, or per-customer JWT (`am_cu_...`). API keys carry **scopes** (`balances.read`, `balances.write`, `billing.write`) enforced by `createRoute({ scopes: [...] })`.
- **API surface.** REST routes registered in `server/src/routers/apiRouter.ts` under `balancesRouter.post("/check", ...)` etc. A parallel **RPC router** exposes verb-shaped paths under `/v1/rpc/<resource.action>` — preferred for new integrations.
- **Multi-tenant.** Every endpoint is scoped by `org_id` resolved from the `am_sk_...` key via `secretKeyMiddleware`. The same applies to customer JWTs.
- **Reservations.** Implemented in-memory in Redis as **lock receipts** (`internal/balances/utils/lockV2/saveLockReceiptV2.ts`, `buildClaimMarkerKey.ts`). `/check` with `lock.enabled=true` reserves and returns a `lock_id`. `POST /balances/finalize` (handler `handleFinalizeLock.ts`) commits or releases. There is **no separate `reservations` Postgres table** — locks live in Redis only.
- **Pricing model.** The merchant defines a **`credit_system` feature** with a `credit_schema` mapping each `model_id` (or downstream feature) to its credit cost. `/track_tokens` resolves the cost via `internal/balances/track/utils/getTokenTrackParams.ts` using `models.dev`-derived pricing. MeterPal is the source of truth for token → credit conversion.
- **PayPal.** Handled in `external/paypal/`. Webhook receiver verifies the PayPal transmission signature (CRC32 over the raw body) and dispatches via `runPaypalWebhookHandlers.ts`. Handled events include `BILLING.SUBSCRIPTION.{ACTIVATED,UPDATED,SUSPENDED,CANCELLED,EXPIRED,PAYMENT.FAILED}`, `PAYMENT.SALE.{COMPLETED,REFUNDED,REVERSED}`, `PAYMENT.CAPTURE.{COMPLETED,REFUNDED,REVERSED}`, `CHECKOUT.ORDER.APPROVED`, `INVOICING.INVOICE.PAID`. Events are deduped durably in the `webhook_events` table (ids prefixed `paypal:`).
- **Conventions.** `createRoute({ scopes, versionedBody, handler })` wraps every handler (Zod validation, scope check, telemetry, idempotency, rate limit, response version transforms). Body / query schemas live in `shared/api/<resource>/<verb>Params.ts`. Responses are flat JSON with version transforms. Path alias `@/internal/...` resolves to `server/src/internal/...`; `@autumn/shared` for `shared/`. Logging via `ctx.logger.info(...)` (Logtail), never `console.log` in production paths. Code-based migrations (Drizzle-kit-style) in `server/src/internal/migrations/`.

### LiteLLM — `C:\Users\craig\Desktop\AI billing\litellm`

- **Stack.** Python 3.10+ + FastAPI + Postgres + Redis. Prisma as the schema definition (Prisma is the source of schema; the proxy runs against the generated client).
- **Layout.**
  ```
  litellm/
  ├── litellm/                      # the SDK (client + proxy core)
  │   ├── proxy/
  │   │   ├── proxy_server.py       # main FastAPI app, ~20k lines
  │   │   ├── auth/                 # virtual keys, JWT, OAuth2, RBAC, route_checks
  │   │   ├── spend_tracking/       # budget reservation, spend events, reconciliation
  │   │   ├── hooks/                # per-feature hooks (parallel_request_limiter, max_budget, etc.)
  │   │   ├── custom_hooks/         # SSO hook, third-party custom hooks
  │   │   ├── enterprise_billing/   # LiteLLM's own billing metrics (we will REPLACE this)
  │   │   ├── management_endpoints/ # /key/generate, /key/update, /key/delete, /team/*
  │   │   ├── analytics_endpoints/  # /spend/logs, /spend/users, /spend/end_users
  │   │   ├── middleware/           # ASGI middleware (budget_reservation_release, admission_control)
  │   │   ├── anthropic_endpoints/, openai_endpoints/, google_endpoints/, ...
  │   │   ├── db/                   # Prisma client, spend counter reseed, batch writer
  │   │   ├── example_config_yaml/  # sample yaml configs (spend_tracking_config.yaml, custom_callbacks1.py)
  │   │   ├── _types.py             # type defs (UserAPIKeyAuth, SpendLogsPayload, etc.)
  │   │   └── schema.prisma         # Prisma schema (LiteLLM_* tables)
  │   ├── integrations/
  │   │   └── custom_logger.py      # the base class for ALL callbacks
  │   ├── router_utils/
  │   │   ├── pre_call_checks/      # admission checks (model_rate_limit, prompt_caching_deployment, etc.)
  │   │   └── router_callbacks/     # fallback_event_handlers, cooldown_handlers
  │   └── cost_calculator.py        # cost_per_token (line 369), completion_cost (line 1261)
  └── model_prices_and_context_window.json   # canonical pricing for 4,392 models across 80+ providers
  ```
- **Pricing source of truth.** `model_prices_and_context_window.json` at the repo root. Loaded at startup. Contains per-token rates for input, output, cache_read, cache_write, reasoning, audio for every supported model.
- **Cost capture.** `cost_calculator.completion_cost()` is called inside `proxy_track_cost_callback.py` after each request completes. Result is stored in `kwargs["response_cost"]` and written to `LiteLLM_SpendLogs.spend`.
- **Reservation pattern.** `litellm/proxy/spend_tracking/budget_reservation.py`. The four canonical functions:
  - `reserve_budget_for_request` (line 248) — atomic check-and-decrement of worst-case cost
  - `reconcile_budget_reservation` (line 380) — swap reservation with actual cost
  - `release_budget_reservation` (line 399) — refund on client disconnect / provider timeout
  - `release_budget_reservation_on_cancel` (line 406) — release on early client cancel
  Counter keys: `{prefix}{token_id}`, `{prefix}team:{team_id}`, `{prefix}user:{user_id}`, `{prefix}end_user:{end_user_id}`, `{prefix}org:{org_id}`, `{prefix}tag:{tag_name}`. Each request bumps 4–6 counters atomically via a single Redis pipeline (`increment_spend_counters_pipeline` in `proxy_server.py:3708`).
- **Hook surface.** `litellm/integrations/custom_logger.py` — the `CustomLogger` base class. The methods that matter for our bridge:
  - `async_pre_call_hook(user_api_key_dict, cache, data, call_type)` — runs after LiteLLM's own auth+reservation, before the LLM call. Raise to short-circuit with 402.
  - `async_log_success_event(kwargs, response_obj, start_time, end_time)` — runs after the final usage chunk is captured. `kwargs["response_cost"]` is populated.
  - `async_log_failure_event(kwargs, response_obj, start_time, end_time)` — runs after a failed call.
  - `async_post_call_failure_hook(request_data, original_exception, user_api_key_dict)` — runs on provider error.
- **Bridge registration.** One yaml line:
  ```yaml
  litellm_settings:
    callbacks: ["autumn_billing.AutumnBillingBridge"]
    # OR finer-grained:
    # success_callback: ["autumn_billing.AutumnBillingBridge"]
    # failure_callback: ["autumn_billing.AutumnBillingBridge"]
  ```

## 2. The API contract between the two systems

The bridge talks to MeterPal over HTTP using the existing endpoint shapes. No new endpoints are required on either side. All public calls authenticate with `Authorization: Bearer am_sk_...` (an MeterPal secret key with the right scopes) and pin to API version `V1_2` via the `am-version` query parameter.

### MeterPal's API (the surface LiteLLM calls)

All routes live under `apiRouter` (`server/src/routers/apiRouter.ts`) and are registered in `balancesRouter` (`server/src/internal/balances/balancesRouter.ts`). The exact registrations, with the source line where each one is mounted:

| Method | Path | Handler | Used by bridge |
| --- | --- | --- | --- |
| POST | `/check` | `handleCheck` (`internal/api/check/handleCheck.ts:24`) | yes — admission |
| POST | `/entitled` | `handleCheck` | (alias) |
| POST | `/track` | `handleTrack` (`internal/balances/handlers/handleTrack.ts:16`) | yes — billable event |
| POST | `/events` | `handleTrack` | (alias) |
| POST | `/track_tokens` | `handleTrackTokens` (`internal/balances/handlers/handleTrackTokens.ts:13`) | yes — AI-specific tokens |
| POST | `/balances/finalize` | `handleFinalizeLock` (`internal/balances/handlers/handleFinalizeLock.ts`) | yes — reservation completion |
| POST | `/attach` | `handleAttach` (`internal/billing/attach/handleAttach.ts:42`) | yes — top-up + plan changes |
| POST | `/balances/batch_track` | `handleBatchTrack` | (admin / aggregator) |
| POST | `/balances/batch_track_tokens` | `handleBatchTrackTokens` | (admin / aggregator) |
| GET | `/features/ai/model_pricing` | `handleGetModelPricing` | yes — fetch the credit-system price table |
| GET | `/customers/:id` | `handleGetCustomer` | yes — LiteLLM UI reads balance from here |

The same operations are also exposed via the RPC router at `/v1/rpc/customers.balances.<action>` (e.g. `customers.balances.check`, `customers.balances.track_tokens`). The RPC router is preferred for new integrations and is what the generated `@useautumn/sdk` wraps.

### The four calls the bridge needs

**Admission — `POST /check`** (`handleCheck` in `internal/api/check/`, scope `balances.read`)

```jsonc
// Request
{
  "customer_id": "cus_abc123",       // required — your stable external customer id
  "feature_id":  "ai_tokens",        // required — your credit_system feature id
  "required_balance": 1,             // optional — the minimum balance a call may start with
  "send_event":    false,            // we do NOT want a debit on admission
  "lock": { "enabled": true },        // optional — reserve against the balance (see below)
  "idempotency_key": "req_abc123",   // optional — makes the reservation idempotent
  "with_preview":  false
}

// Response
{
  "allowed": true,
  "customer_id": "cus_abc123",
  "feature_id": "ai_tokens",
  "balance": { "remaining": 1247.83, "max": 2000, "units": "credits" },
  "required_balance": 1,
  "preview": null
}
```

If `allowed` is false, the bridge raises `HTTPException(402)`. If `allowed` is true, the request proceeds. **Fail-open semantics**: if the MeterPal request exceeds the 3-second timeout, the handler returns `202 Accepted` with `allowed: true` (controlled by `failOpen` on the route; see `server/src/internal/api/check/handleCheck.ts:24`).

**Optional reservation — `POST /check` with a `lock`** returns the same response plus a `lock` field
with a `lock_id`. The bridge holds onto that id until it knows the final cost, then releases it via
`/balances/finalize`.

The `lock` field takes the **object** form, `{"enabled": true}`, or the boolean shorthand `true`.
The object form is what the schema documents; the shorthand is accepted as equivalent. A bare
boolean in any other shape is a 400 — and a 400 on the admission path is swallowed by the
bridge's fail-open handling, which would admit the request with no reservation and no price pin.
Do not send `lock: true` *as a string*, and do not omit `enabled`.

```jsonc
// Request — with a reservation
{
  "customer_id": "cus_abc123",
  "feature_id": "ai_tokens",
  "required_balance": 1,
  "model_id": "openai/gpt-4o",       // optional — prices the reservation
  "input_tokens": 1200,              // optional — worst-case estimate
  "output_tokens": 800,              // optional — worst-case estimate
  "lock": {
    "enabled": true,
    "expires_at": 1794000000000      // optional — ms epoch; the hold is auto-released then
  },
  "idempotency_key": "req_abc123"    // optional — the reservation id is derived from this
}

// Response (with a reservation)
{
  "allowed": true,
  "customer_id": "cus_abc123",
  "feature_id": "ai_tokens",
  "balance": { "remaining": 1247.83, "max": 2000, "units": "credits" },
  "lock": { "lock_id": "lock_3f9a...", "expires_at": 1794000000000 }
}
```

Three things about the reservation matter:

- **The server mints the `lock_id`** when the caller does not name one. Send `idempotency_key` and
  the id is derived from it, so a repeated check for the same request resolves to the same hold
  rather than taking a second one.
- **The hold is sized from the request's price**, not from a flat amount: `model_id` plus the token
  estimates are priced at the org's rates, and that is what is held. `required_balance` is the
  *floor* — the minimum balance a call may start with — not the reservation.
- **`expires_at` bounds the hold.** Without it the reservation is only released by
  `/balances/finalize`; with it the billing server releases the hold itself when it passes, which
  is what keeps an unsettled request from holding a balance indefinitely.

**Commit/release — `POST /balances/finalize`** (`handleFinalizeLock`, scope `balances.write`)

```jsonc
// Request — release the hold (the charge already went through /track_tokens)
{
  "customer_id": "cus_abc123",
  "lock_id": "lock_3f9a...",
  "action": "release",
  "override_value": 0,               // release the hold in full; the usage is billed separately
  "feature_id": "ai_tokens"
}

// Response
{ "success": true }
```

**Order matters: charge first, release second.** The bridge calls `/track_tokens` and then
`/balances/finalize`. Releasing first put the whole balance back while the charge was still
pending, and another request could take it in that window — which is exactly how N concurrent
requests end up spending more than the balance. Charging first means the balance only ever goes
down; the release afterwards gives back what the request did not use.

Because the hold is still in place when the charge lands, `/track_tokens` must be sent with
`overage_behavior: "overflow"` when a reservation is held: the charge is allowed past the
remaining balance and the release brings it back. Capping it would leave the customer
under-charged for a request the hold already admitted.

**Billable event — `POST /track_tokens`** (`handleTrackTokens`, scope `balances.write`)

```jsonc
// Request (Zod schema in shared/api/balances/track/trackTokensParams.ts:7)
{
  "customer_id":        "cus_abc123",
  "feature_id":         "ai_tokens",
  "model_id":           "anthropic/claude-sonnet-4-5",   // '[provider]/[model]'
  "input_tokens":       1247,
  "output_tokens":       318,
  "cache_read_tokens":     0,
  "cache_write_tokens": 1024,
  "audio_input_tokens":    0,
  "audio_output_tokens":   0,
  "reasoning_tokens":      0,
  "idempotency_key": "litellm-3f9a...",
  "timestamp":       "2026-09-27T03:14:25.118Z",          // optional
  "async":           false                                 // optional — true returns 202
}

// Response (200 sync)
{
  "id":                "evt_abc...",
  "customer_id":       "cus_abc123",
  "event_name":        "ai_tokens",
  "feature_id":        "ai_tokens",
  "balance":  { "remaining": 1247.45, "max": 2000, "units": "credits" },
  "usage":    { "used": 0.55, "limit": 2000, "interval": "month" },
  "deductions": [ { "rollover": 1247.45, "main": 0, "additional": 0 } ]
}

// Response (202 async) — same shape, indicates queueing
```

MeterPal computes the credit cost from `model_id` + the token breakdown using `models.dev`-derived pricing and the feature's `credit_schema`. The bridge does **not** send a precomputed dollar amount — MeterPal owns the price registry and the conversion.

**Generic fallback — `POST /track`** (`handleTrack`, scope `balances.write`)

```jsonc
// Request
{
  "customer_id":     "cus_abc123",
  "event_name":      "image_gen",                          // feature id
  "value":           0.0042,                                // credits
  "idempotency_key": "litellm-3f9a...",
  "timestamp":       "2026-09-27T03:14:25.118Z"
}
```

Use only for non-token costs (e.g., a flat per-image feature). For AI, prefer `track_tokens`.

**Price-table fetch — `GET /features/ai/model_pricing`** (`handleGetModelPricing`, scope `balances.read`)

```jsonc
// Response — every model_id -> credit cost mapping
[
  { "model_id": "anthropic/claude-sonnet-4-5",  "input_credits": 0.003, "output_credits": 0.015, ... },
  { "model_id": "anthropic/claude-haiku-4-5",   "input_credits": 0.001, "output_credits": 0.005, ... },
  { "model_id": "openai/gpt-4o",               "input_credits": 0.005, "output_credits": 0.015, ... },
  ...
]
```

The bridge calls this at startup to cache the price table. MeterPal is still the source of truth — the cache is only for fast admission estimates.

### LiteLLM's API (the surface MeterPal calls)

LiteLLM's management API is at `/key/*` and uses `Bearer <master_key>` auth. These are the calls MeterPal makes to provision per-customer virtual keys.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/key/generate` | Mint a new virtual key for a customer |
| POST | `/key/update` | Update budget / metadata on an existing key |
| POST | `/key/block` | Disable a key (subscription cancelled, fraud, etc.) |
| POST | `/key/delete` | Hard-delete a key (use sparingly) |
| GET | `/key/info?key=...` | Look up a key's current state (spend, budget) |
| POST | `/spend/logs` | Pull per-request spend history (for reconciliation) |

**Mint a key on customer signup:**

```jsonc
// POST /key/generate  (Authorization: Bearer sk-litellm-master-...)
{
  "user_id":   "cus_abc123",            // the MeterPal customer id
  "team_id":   "team_xyz",              // optional, if multi-tenant
  "max_budget": 2000.0,                 // USD, soft cap from MeterPal subscription
  "budget_duration": "30d",
  "key_alias": "autumn:cus_abc123",     // for traceability
  "metadata": { "autumn_customer_id": "cus_abc123", "plan": "pro" }
}

// Response
{
  "key": "sk-vkey-...",   // store on MeterPal customer record
  "key_name": "...",
  "expires": "2026-10-27T..."
}
```

**Update on plan change:**

```jsonc
// POST /key/update  (Authorization: Bearer sk-litellm-master-...)
{
  "key": "sk-vkey-...",
  "max_budget": 6000.0,
  "budget_duration": "30d"
}
```

**Block on cancellation:**

```jsonc
// POST /key/block  (Authorization: Bearer sk-litellm-master-...)
{ "key": "sk-vkey-..." }
```

## 3. The bridge code — LiteLLM CustomLogger

Drop this file at `C:\Users\craig\Desktop\AI billing\litellm\litellm\integrations\autumn_billing.py`. It is structured to match the conventions in `litellm/integrations/custom_logger.py` and `litellm/proxy/hooks/proxy_track_cost_callback.py`.

```python
# litellm/integrations/autumn_billing.py
"""
MeterPal-backed CustomLogger for the LiteLLM proxy.

Responsibilities (mirrors proxy_track_cost_callback.py):
  1. async_pre_call_hook        -> MeterPal POST /check            (admission, optional lock)
  2. async_log_success_event    -> MeterPal POST /balances/finalize (commit) +
                                    POST /track_tokens            (analytics + per-token deduction)
  3. async_log_failure_event    -> MeterPal POST /balances/finalize (release) +
                                    POST /track_tokens with status="failure"
  4. async_post_call_failure_hook -> release any LiteLLM reservation if we raised

Configuration (env):
  AUTUMN_BASE_URL        default https://api.useautumn.com/v1
  AUTUMN_API_KEY         required — bearer token (am_sk_...)
  AUTUMN_FEATURE_ID      the credit_system feature_id to charge against (e.g. "ai_tokens")
  AUTUMN_CUSTOMER_HEADER header carrying the MeterPal customer id  (default: "user")
  AUTUMN_ADMIT_MODE      "block" (default) or "soft" (admit + log)
  AUTUMN_CHECK_TTL_SEC   cache /check responses for N seconds (default: 1.0)
  AUTUMN_TIMEOUT_SEC     HTTP timeout                              (default: 2.0)
  AUTUMN_FAIL_MODE       "open" (default) or "closed" — on MeterPal unreachable
  AUTUMN_USE_LOCK        "true" to use lock-based reservation (default: false for v1)
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import HTTPException

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy.proxy_server import DualCache, UserAPIKeyAuth


def _env(name: str, default: str | None = None) -> str | None:
    val = os.environ.get(name, default)
    return val if val else default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AutumnBillingBridge(CustomLogger):
    """CustomLogger that delegates admission + metering to MeterPal.

    Compatible with LiteLLM's reservation system. If you set
    general_settings.disable_budget_reservation: true, this becomes the
    sole admission controller. Otherwise it layers MeterPal's per-customer
    balance on top of LiteLLM's per-key / per-team / per-org budgets.
    """

    def __init__(self) -> None:
        self.api_key: str = _env("AUTUMN_API_KEY", "") or ""
        self.base_url: str = (
            _env("AUTUMN_BASE_URL", "https://api.useautumn.com/v1") or ""
        )
        self.feature_id: str = _env("AUTUMN_FEATURE_ID", "ai_tokens") or "ai_tokens"
        self.customer_header: str = _env("AUTUMN_CUSTOMER_HEADER", "user") or "user"
        self.admit_mode: str = _env("AUTUMN_ADMIT_MODE", "block") or "block"
        self.check_ttl: float = float(_env("AUTUMN_CHECK_TTL_SEC", "1.0") or "1.0")
        self.timeout: float = float(_env("AUTUMN_TIMEOUT_SEC", "2.0") or "2.0")
        self.fail_mode: str = _env("AUTUMN_FAIL_MODE", "open") or "open"
        self.use_lock: bool = (_env("AUTUMN_USE_LOCK", "false") or "false").lower() == "true"

        # per-process short-circuit cache for /check
        self._check_cache: dict[str, tuple[float, tuple[bool, Optional[str]]]] = {}
        self._cache_lock = asyncio.Lock()

        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            params={"am-version": "V1_2"},
            timeout=self.timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ─── helpers ───────────────────────────────────────────────────────
    def _customer_id(
        self,
        data: dict | None,
        user_api_key_dict: UserAPIKeyAuth | None,
    ) -> str | None:
        if data:
            for key in (self.customer_header, "user", "user_id", "end_user_id"):
                if val := data.get(key):
                    return str(val)
            md = data.get("metadata") or {}
            if isinstance(md, dict) and md.get("autumn_customer_id"):
                return str(md["autumn_customer_id"])
        if user_api_key_dict and getattr(user_api_key_dict, "end_user_id", None):
            return user_api_key_dict.end_user_id
        return None

    def _litellm_metadata(self, kwargs: dict | None) -> dict:
        if not kwargs:
            return {}
        return kwargs.get("metadata") or kwargs.get("litellm_params", {}).get("metadata") or {}

    async def _autumn_check(self, customer_id: str) -> tuple[bool, Optional[str]]:
        """Returns (allowed, lock_id). lock_id is non-None only when AUTUMN_USE_LOCK=true."""
        now = time.monotonic()
        async with self._cache_lock:
            cached = self._check_cache.get(customer_id)
            if cached and (now - cached[0]) < self.check_ttl:
                return cached[1]

        body: dict[str, Any] = {"customer_id": customer_id, "feature_id": self.feature_id}
        if self.use_lock:
            body["lock"] = True

        try:
            resp = await self._client.post("/check", json=body)
            resp.raise_for_status()
            payload = resp.json()
            allowed = bool(payload.get("allowed", False))
            lock_id = (payload.get("lock") or {}).get("lock_id") if self.use_lock else None
        except httpx.HTTPError as exc:
            await self._log(f"autumn /check failed: {exc!r}")
            allowed = self.fail_mode == "open"
            lock_id = None

        async with self._cache_lock:
            self._check_cache[customer_id] = (now, (allowed, lock_id))
        return (allowed, lock_id)

    async def _autumn_finalize(self, customer_id: str, lock_id: str, action: str) -> None:
        try:
            await self._client.post(
                "/balances/finalize",
                json={
                    "customer_id": customer_id,
                    "lock_id": lock_id,
                    "action": action,
                    "feature_id": self.feature_id,
                },
            )
        except httpx.HTTPError as exc:
            await self._log(f"autumn /balances/finalize failed: {exc!r}")

    async def _autumn_track_tokens(
        self,
        *,
        customer_id: str,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        audio_input_tokens: int = 0,
        audio_output_tokens: int = 0,
        reasoning_tokens: int = 0,
        cost_usd: float = 0.0,
        request_id: str,
        status: str,
        error_type: str | None = None,
    ) -> None:
        try:
            await self._client.post(
                "/track_tokens",
                json={
                    "customer_id": customer_id,
                    "feature_id": self.feature_id,
                    "model_id": model_id,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_tokens": cache_read_tokens,
                    "cache_write_tokens": cache_write_tokens,
                    "audio_input_tokens": audio_input_tokens,
                    "audio_output_tokens": audio_output_tokens,
                    "reasoning_tokens": reasoning_tokens,
                    "idempotency_key": request_id,
                    "timestamp": _now_iso(),
                    "metadata": {
                        "cost_usd": cost_usd,
                        "litellm_call_id": request_id,
                        "status": status,
                        "error_type": error_type,
                    },
                },
            )
        except httpx.HTTPError as exc:
            await self._log(f"autumn /track_tokens failed: {exc!r}")

    async def _log(self, msg: str) -> None:
        try:
            from litellm._logging import verbose_proxy_logger
            verbose_proxy_logger.info(f"[AutumnBillingBridge] {msg}")
        except ImportError:
            pass

    # ─── Hook 1: admission ────────────────────────────────────────────
    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: Any,
    ) -> dict:
        customer_id = self._customer_id(data, user_api_key_dict)
        if not customer_id or not self.api_key:
            return data

        # mirror the customer id so LiteLLM populates LiteLLM_EndUserTable.user_id
        data[self.customer_header] = customer_id
        data["user"] = customer_id

        allowed, lock_id = await self._autumn_check(customer_id)
        if not allowed and self.admit_mode == "block":
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_balance",
                    "customer_id": customer_id,
                    "feature_id": self.feature_id,
                },
            )

        # stow the lock_id for the post-call hook to release/commit
        if lock_id:
            md = data.setdefault("metadata", {})
            md["_autumn_lock_id"] = lock_id
            md["_autumn_customer_id"] = customer_id
        return data

    # ─── Hook 2: billable success ──────────────────────────────────────
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        if not self.api_key:
            return
        customer_id = (
            kwargs.get("user_api_key_end_user_id")
            or self._customer_id(kwargs.get("litellm_params") or {}, None)
        )
        if not customer_id:
            return
        md = self._litellm_metadata(kwargs)
        lock_id = md.get("_autumn_lock_id")
        if self.use_lock and lock_id:
            await self._autumn_finalize(customer_id, lock_id, "commit")
        await self._autumn_track_tokens(
            customer_id=customer_id,
            model_id=str(kwargs.get("model") or ""),
            input_tokens=int(kwargs.get("prompt_tokens") or 0),
            output_tokens=int(kwargs.get("completion_tokens") or 0),
            cache_read_tokens=int(kwargs.get("cache_read_input_tokens") or 0),
            cache_write_tokens=int(kwargs.get("cache_creation_input_tokens") or 0),
            reasoning_tokens=int(kwargs.get("reasoning_tokens") or 0),
            cost_usd=float(kwargs.get("response_cost") or 0.0),
            request_id=str(kwargs.get("litellm_call_id") or ""),
            status="success",
        )

    # ─── Hook 3: failure path ──────────────────────────────────────────
    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        if not self.api_key:
            return
        customer_id = (
            kwargs.get("user_api_key_end_user_id")
            or self._customer_id(kwargs.get("litellm_params") or {}, None)
        )
        if not customer_id:
            return
        md = self._litellm_metadata(kwargs)
        lock_id = md.get("_autumn_lock_id")
        if self.use_lock and lock_id:
            await self._autumn_finalize(customer_id, lock_id, "release")
        exc = kwargs.get("exception")
        await self._autumn_track_tokens(
            customer_id=customer_id,
            model_id=str(kwargs.get("model") or ""),
            input_tokens=int(kwargs.get("prompt_tokens") or 0),
            output_tokens=int(kwargs.get("completion_tokens") or 0),
            cache_read_tokens=int(kwargs.get("cache_read_input_tokens") or 0),
            cache_write_tokens=int(kwargs.get("cache_creation_input_tokens") or 0),
            reasoning_tokens=int(kwargs.get("reasoning_tokens") or 0),
            cost_usd=0.0,
            request_id=str(kwargs.get("litellm_call_id") or ""),
            status="failure",
            error_type=exc.__class__.__name__ if exc else None,
        )


# module-level singleton — referenced from yaml as
# `autumn_billing.AutumnBillingBridge`
autumn_bridge_instance = AutumnBillingBridge()
```

Register it in your `config.yaml`:

```yaml
litellm_settings:
  callbacks: ["autumn_billing.AutumnBillingBridge"]
  # optional: scope to just success/failure
  # success_callback: ["autumn_billing.AutumnBillingBridge"]
  # failure_callback: ["autumn_billing.AutumnBillingBridge"]

general_settings:
  # OPTION A — keep LiteLLM's per-key budget enforcement, layer MeterPal on top:
  # (no disable_budget_reservation)
  # OPTION B — let MeterPal be the sole admission controller (recommended for v1):
  disable_budget_reservation: true
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL

  # mirror the autumn customer id into LiteLLM's per-end-user tables so the
  # admin UI's /spend/end_users view stays consistent with MeterPal.
```

## 4. The other direction — MeterPal provisioning LiteLLM keys

When a customer signs up or changes plan in MeterPal, MeterPal needs to mint / update / block the LiteLLM virtual key for that customer. This is the **provisioning path**, which lives in MeterPal.

Add a new handler in `billing/server/src/internal/keys/` (you already have this folder) — call it `litellmKeys.ts`. Wire it into the existing event triggers in `trigger/` so that customer lifecycle events fan out to LiteLLM.

```typescript
// billing/server/src/internal/keys/litellmKeys.ts
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

const LITELLM_BASE = process.env.LITELLM_BASE_URL!;
const LITELLM_MASTER = process.env.LITELLM_MASTER_KEY!;
const LITELLM_BUDGET_PER_PLAN: Record<string, number> = {
  free: 5,
  pro: 20,
  pro_plus: 60,
  ultra: 200,
};

async function litellmFetch(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${LITELLM_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`litellm ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

/** Called from trigger/ on customer.subscription.created */
export async function provisionLitellmKey(
  ctx: AutumnContext,
  args: { customerId: string; planKey: string; existingKey?: string },
) {
  const budget = LITELLM_BUDGET_PER_PLAN[args.planKey] ?? 5;
  if (args.existingKey) {
    return litellmFetch("/key/update", {
      key: args.existingKey,
      max_budget: budget,
      budget_duration: "30d",
    });
  }
  const out = await litellmFetch("/key/generate", {
    user_id: args.customerId,
    max_budget: budget,
    budget_duration: "30d",
    key_alias: `autumn:${args.customerId}`,
    metadata: { autumn_customer_id: args.customerId, plan: args.planKey },
  });
  // persist out.key on the MeterPal customer record
  await ctx.db
    .updateTable("customers")
    .set({ litellm_virtual_key: out.key })
    .where("id", "=", args.customerId)
    .execute();
  return out;
}

/** Called from trigger/ on customer.subscription.deleted or status=paused */
export async function blockLitellmKey(ctx: AutumnContext, customerId: string) {
  const cust = await ctx.db
    .selectFrom("customers")
    .select("litellm_virtual_key")
    .where("id", "=", customerId)
    .executeTakeFirst();
  if (!cust?.litellm_virtual_key) return;
  return litellmFetch("/key/block", { key: cust.litellm_virtual_key });
}
```

Wire the trigger in `trigger/subscriptions.ts` (or wherever subscription lifecycle events fire):

```typescript
// billing/server/src/trigger/subscriptions.ts — append
import { provisionLitellmKey, blockLitellmKey } from "@/internal/keys/litellmKeys.js";

on("customer.subscription.created", async (ctx, evt) => {
  await provisionLitellmKey(ctx, {
    customerId: evt.customer_id,
    planKey: evt.plan_key,
    existingKey: evt.litellm_virtual_key,
  });
});

on("customer.subscription.updated", async (ctx, evt) => {
  if (evt.status === "active" || evt.status === "trialing") {
    await provisionLitellmKey(ctx, {
      customerId: evt.customer_id,
      planKey: evt.plan_key,
      existingKey: evt.litellm_virtual_key,
    });
  } else if (evt.status === "canceled" || evt.status === "paused") {
    await blockLitellmKey(ctx, evt.customer_id);
  }
});
```

Add a `litellm_virtual_key text` column to the `customers` table via Drizzle migration:

```typescript
// billing/server/src/drizzle/migrations/000X_litellm_keys.ts
import { sql } from "drizzle-orm";

export async function up(db) {
  await db.execute(sql`
    ALTER TABLE customers
    ADD COLUMN litellm_virtual_key TEXT;
  `);
}

export async function down(db) {
  await db.execute(sql`
    ALTER TABLE customers DROP COLUMN litellm_virtual_key;
  `);
}
```

## 5. Shared infrastructure

Both repos use Postgres + Redis. The bridge does not require them to share a database — but there are two integration choices, each with tradeoffs.

| Choice | Pros | Cons |
| --- | --- | --- |
| **Separate Postgres, separate Redis** (recommended for v1) | Clean blast radius. MeterPal's Drizzle migrations are independent of LiteLLM's Prisma migrations. You can swap either side without touching the other. | Two databases to operate. Reconciler must compare cross-DB row counts. |
| **Same Postgres, separate schemas, shared Redis** | One connection pool. Cross-system analytics simpler. | Migration tools conflict (Drizzle + Prisma on same DB is workable but quirky). Schema-name collisions possible. |

For v1, run them with separate Postgres + separate Redis. Each owns its data:

```
postgres-billing      Postgres for MeterPal (customers, balances, events, invoices, ...)
postgres-litellm     Postgres for LiteLLM (LiteLLM_SpendLogs, LiteLLM_VerificationToken, ...)

redis-billing         Redis for MeterPal Lua scripts (fullSubject, deduction, syncDirty)
redis-litellm        Redis for LiteLLM spend counters (spend_counter_cache, budget_reservation)
```

Operationally, point each app at its own DB / Redis URL. The only shared state is the customer_id / virtual_key mapping, which lives in **both** systems (MeterPal stores it on the customer row; LiteLLM stores it on the `LiteLLM_EndUserTable.user_id`).

The LiteLLM-side spend counter uses the prefix from `proxy_server.py:2988-3000`. MeterPal's Lua scripts use their own prefixes — no collision risk even if you ever share Redis.

## 6. End-to-end request trace, after integration

A user in your app types a prompt. The journey:

```
[App]     POST /v1/chat/completions  Authorization: Bearer sk-vkey-...
          body: {model: "claude-sonnet-4-5", messages: [...], user: "cus_abc123"}

[LiteLLM proxy]
 1. FastAPI receives, parses body.
 2. user_api_key_auth resolves sk-vkey-... against Redis (UserApiKeyCache),
    reads LiteLLM_VerificationToken, sees user_id=cus_abc123, end_user_id=cus_abc123,
    max_budget=2000, current_spend=12.47.
 3. _run_centralized_common_checks fires. With disable_budget_reservation=true,
    this only does auth + rate-limit checks; the budget reservation is skipped
    because MeterPal is the source of truth.
 4. CustomLogger.async_pre_call_hook(AutumnBillingBridge) fires.
    - extracts customer_id=cus_abc123 from data["user"]
    - calls MeterPal POST /check  →  {allowed: true, balance: {remaining: 1987.53}}
    - returns data with mirrored customer_id; admits.
 5. Router picks model+deployment (load balance across 3 OpenAI orgs, etc.).
 6. Provider call (streaming).
 7. Stream ends; final usage chunk arrives.
 8. proxy_track_cost_callback fires:
    - reads kwargs["response_cost"] = 0.0042
    - enqueues LiteLLM_SpendLogs row (for LiteLLM-side analytics)
    - reconciles LiteLLM budget reservation (if any)
 9. CustomLogger.async_log_success_event(AutumnBillingBridge) fires.
    - extracts customer_id from kwargs["user_api_key_end_user_id"]
    - calls MeterPal POST /track_tokens
      {customer_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, idempotency_key}
    - MeterPal decrements balance by $0.0042 via _luaScriptsV2/deduction
    - MeterPal returns {ok: true, balance: {remaining: 1987.49}}
10. Stream chunks forwarded to [App].
11. [App] shows user the response.
```

If MeterPal is unreachable at step 4 (network blip), `AUTUMN_FAIL_MODE=open` admits the request. The /track_tokens call at step 9 may also fail; in that case LiteLLM still has its own SpendLog row, and a nightly reconciliation job (covered below) catches the divergence.

## 7. Idempotency and reconciliation

**Idempotency.** LiteLLM emits a stable `litellm_call_id` (UUID) per request, exposed in `kwargs["litellm_call_id"]`. The bridge forwards it as `idempotency_key` to MeterPal. MeterPal's `handleTrackTokens` is built on a unique-constraint insert; a duplicate `idempotency_key` returns `idempotent: true` and does not double-debit.

If the bridge receives a retry from a transient HTTP error (e.g. MeterPal returned 502 mid-write), the next attempt is naturally idempotent. No special retry logic is needed in the bridge; just make sure `httpx.AsyncClient` retries on connection errors (default `retry=0` is fine; LiteLLM's outer retry envelope will replay the request).

**Reconciliation.** Run a daily cron that catches any drift between LiteLLM's per-customer spend and MeterPal's per-customer spend:

```typescript
// billing/server/src/cron/reconcileLitellmSpend.ts
import { Cron } from "@/cron/Cron.js";
import { litellmFetch } from "@/internal/keys/litellmKeys.js";
import { getAdminDb } from "@/db/initDrizzle.js";

export const reconcileLitellmSpend = new Cron({
  name: "litellm_spend_reconcile",
  schedule: "0 4 * * *",  // 4am daily
  run: async () => {
    const db = getAdminDb();
    const litellmRows = await litellmFetch("/spend/logs", {
      start_date: yesterday(),
      end_date: today(),
      group_by: "end_user",
    });
    for (const row of litellmRows) {
      const autumnRows = await db
        .selectFrom("wallet_ledger")
        .select(eb => eb.fn.sum("credits_delta").as("sum"))
        .where("customer_id", "=", row.end_user_id)
        .where("kind", "in", ["usage", "correction"])
        .where("ts", ">=", yesterday())
        .where("ts", "<", today())
        .executeTakeFirst();
      const litellmSpend = row.total_spend;
      const autumnSpend = Number(autumnRows?.sum ?? 0);
      const drift = Math.abs(litellmSpend - autumnSpend);
      if (drift / Math.max(litellmSpend, 0.01) > 0.001) {
        await alertSlack(`drift >0.1% for ${row.end_user_id}: litellm=${litellmSpend} autumn=${autumnSpend}`);
      }
    }
  },
});
```

This three-layer reconciliation pattern is documented in `docs/plan.md` — the same shape, applied to the external processor.

## 8. The setup, in order

Run these steps in sequence. Each step ends with a verification you can perform before moving on.

1. **Bring up shared infrastructure.** Two Postgres (one for MeterPal, one for LiteLLM) and two Redis instances. Recommended: Docker compose locally, RDS/ElastiCache in production. Verify: `psql` to each, `redis-cli ping` to each.

2. **Run migrations.**
   ```bash
   cd C:\Users\craig\Desktop\AI billing\autumn
   bun run db:migrate
   # add the litellm_virtual_key column manually:
   psql $AUTUMN_DB -f server/src/drizzle/migrations/000X_litellm_keys.sql

   cd C:\Users\craig\Desktop\AI billing\litellm
   litellm --use_prisma_db
   # (creates the LiteLLM_* tables from schema.prisma)
   ```
   Verify: `\dt` in each Postgres shows the expected tables.

3. **Configure MeterPal.**
   ```bash
   # .env in billing/server/
   LITELLM_BASE_URL=https://api.your-saas.com  # the LiteLLM proxy URL
   LITELLM_MASTER_KEY=sk-litellm-master-...
   ```
   Verify: hit `POST /attach` with a test customer; the `trigger/subscriptions.ts` handler should fire and create a LiteLLM virtual key.

4. **Install the bridge file** (gateway operators only — merchants never do this).
   ```bash
   cp litellm/integrations/autumn_billing.py C:\Users\craig\Desktop\AI billing\litellm\litellm\integrations\autumn_billing.py
   ```
   Verify: `python -c "from litellm.integrations.autumn_billing import autumn_bridge_instance; print(autumn_bridge_instance.base_url)"` imports cleanly.

5. **Configure LiteLLM.**
   ```yaml
   # litellm config.yaml
   litellm_settings:
     callbacks: ["autumn_billing.AutumnBillingBridge"]
     drop_params: true
     cache: true
     cache_params:
       type: redis
       host: os.environ/REDIS_HOST_LITELLM

   general_settings:
     master_key: os.environ/LITELLM_MASTER_KEY
     database_url: os.environ/DATABASE_URL_LITELLM
     disable_budget_reservation: true   # let MeterPal be the sole admission controller

   model_list:
     - model_name: claude-sonnet-4-5
       litellm_params: { model: anthropic/claude-sonnet-4-5, api_key: os.environ/ANTHROPIC_API_KEY }
     - model_name: gpt-4o
       litellm_params: { model: openai/gpt-4o, api_key: os.environ/OPENAI_API_KEY_A }
     - model_name: gpt-4o
       litellm_params: { model: openai/gpt-4o, api_key: os.environ/OPENAI_API_KEY_B }

   router_settings:
     routing_strategy: simple-shuffle
     num_retries: 2
     timeout: 30
     cooldown_time: 60
   ```
   Verify: `curl http://localhost:4000/v1/models -H "Authorization: Bearer sk-litellm-master-..."` returns the configured models.

6. **Run end-to-end test.** Sign up a test customer in MeterPal. Send a chat request through LiteLLM with the customer's virtual key. Confirm:
   - The request is admitted (MeterPal `/check` returns `allowed: true`)
   - The response streams correctly
   - MeterPal's customer balance is debited (check the dashboard at `apps/leaf`)
   - The `wallet_ledger` table has a new row with `kind='usage'`
   - The `LiteLLM_SpendLogs` table has a matching row

7. **Run reconciliation.** Wait 24 hours (or temporarily change the cron schedule to `*/5 * * * *` for testing). Confirm zero drift alerts. Reset the schedule to daily.

8. **Wire the rest of your apps.** Each of your apps authenticates the user, reads the LiteLLM virtual key from the MeterPal customer record, and forwards the request. The MeterPal customer record carries the `litellm_virtual_key` field; your app's auth layer reads it from MeterPal's `/customers/:id` endpoint at session-start.

## 9. Where every piece lives in the two repos

For the integrator, this is the file map.

### Files you will create

| Path | Purpose |
| --- | --- |
| `C:\Users\craig\Desktop\AI billing\litellm\litellm\integrations\autumn_billing.py` | The CustomLogger (200 LOC, given above). |
| `C:\Users\craig\Desktop\AI billing\litellm\config.yaml` | LiteLLM proxy config (model_list, callbacks, general_settings). |
| `C:\Users\craig\Desktop\AI billing\autumn\server\src\internal\keys\litellmKeys.ts` | The provisioning handler (provisionLitellmKey, blockLitellmKey). |
| `C:\Users\craig\Desktop\AI billing\autumn\server\src\drizzle\migrations\000X_litellm_keys.sql` | Adds `litellm_virtual_key` column to `customers`. |
| `C:\Users\craig\Desktop\AI billing\autumn\server\src\cron\reconcileLitellmSpend.ts` | Daily drift reconciler. |
| `C:\Users\craig\Desktop\AI billing\autumn\server\src\trigger\subscriptions.ts` (extend existing) | Wire customer lifecycle events to provisioning. |
| `C:\Users\craig\Desktop\AI billing\autumn\server\.env` | LITELLM_BASE_URL, LITELLM_MASTER_KEY. |
| `C:\Users\craig\Desktop\AI billing\litellm\.env` | AUTUMN_BASE_URL, AUTUMN_API_KEY, AUTUMN_FEATURE_ID, provider keys. |

### Files you will read but not modify

| Path | Why |
| --- | --- |
| `autumn\server\src\routers\apiRouter.ts` | Confirm route registration and middleware order. |
| `autumn\server\src\internal\balances\balancesRouter.ts` | Confirm the `/check` and `/track_tokens` mounts. |
| `autumn\server\src\internal\balances\track\handlers\handleTrackTokens.ts` | Read the request schema MeterPal expects. |
| `autumn\server\src\internal\balances\check\handleCheck.ts` | Read the response shape MeterPal returns. |
| `autumn\server\src\_luaScriptsV2\fullSubject\adjustSubjectBalance.lua` | Confirm the atomic decrement script that runs on every track. |
| `litellm\litellm\integrations\custom_logger.py` | Base class your bridge inherits from. |
| `litellm\litellm\proxy\hooks\proxy_track_cost_callback.py` | Mirror its structure for `async_log_success_event` / `async_log_failure_event`. |
| `litellm\litellm\proxy\spend_tracking\budget_reservation.py` | Understand the reservation semantics even though you will skip them with `disable_budget_reservation: true`. |
| `litellm\litellm\proxy\_types.py` (UserAPIKeyAuth, SpendLogsPayload) | Type defs for kwargs in your hook methods. |
| `litellm\model_prices_and_context_window.json` | The pricing source of truth that LiteLLM uses for `response_cost`. |
| `litellm\litellm\cost_calculator.py` (`completion_cost` at line 1261) | The function that produces `kwargs["response_cost"]` — same value MeterPal receives. |

### What you do NOT touch

- MeterPal's PayPal handler (`external/paypal/`) — already wired, no change.
- MeterPal's customer lifecycle (`internal/customers/`) — no change; you only subscribe via `trigger/`.
- LiteLLM's proxy core (`proxy_server.py`) — no change; you only add a config line.
- LiteLLM's existing reservation system (`budget_reservation.py`) — you opt out of it via `disable_budget_reservation: true` rather than modifying it.
- LiteLLM's per-key budget table — kept for admin observability but not used for admission.

## 10. Failure modes and how the bridge handles them

| Failure | What happens | What the bridge does |
| --- | --- | --- |
| MeterPal is unreachable at admission | `/check` HTTP fails | `AUTUMN_FAIL_MODE=open` admits by default. Set `=closed` to deny on MeterPal unreachable (recommended for production after the dashboard is reliable). |
| MeterPal is unreachable at tracking | `/track_tokens` HTTP fails | Logged; LiteLLM's own SpendLog is still written. Reconciler catches the drift in the next 24h. |
| Network blip mid-write | Idempotency key replays cleanly | MeterPal returns `idempotent: true` on retry; no double-debit. |
| LiteLLM crashes mid-request | Reservation released by `BudgetReservationReleaseMiddleware` | With `disable_budget_reservation: true`, no LiteLLM-side reservation to release. MeterPal-side, nothing was debited at admission (we set `send_event: false` on `/check`), so no release needed. |
| Provider returns mid-stream error | LiteLLM fires `async_log_failure_event` | Bridge calls `/track_tokens` with `cost=0` and `error_type` set. MeterPal records the failed attempt for analytics. |
| Customer upgrades plan mid-month | PayPal webhook → MeterPal `trigger/` → `provisionLitellmKey` | New `max_budget` pushed to LiteLLM via `/key/update`. Next request uses the new budget. |
| Customer cancels subscription | PayPal webhook → MeterPal `trigger/` → `blockLitellmKey` | LiteLLM key blocked. Next request returns 401 from auth (before pre_call_hook even runs). |
| Bridge crashes between success and track | LiteLLM has the SpendLog; MeterPal does not | Reconciler catches the divergence within 24h. |

The architecture is fault-tolerant by design: every state is independently reconstructible from the message logs on either side. The bridge is the thinnest possible layer — it does not own state, it only translates events.