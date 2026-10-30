# End-to-End AI Usage-Billing System: Research and Implementation Guide

This document answers one question: how do you build a system that charges
users for AI usage across multiple apps, gives them access the moment they
pay, never lets them consume more than they paid for, and survives the
concurrency of many parallel requests from the same user and from many
users at once. Everything below is grounded in the public engineering of
OpenRouter, TokenRouter, Cursor, Qoder, Stripe's usage-metering product,
LiteLLM's proxy, and the Autumn billing platform you already have cloned
locally. Where a section touches your own code, it points at the path on
your machine.

---

## 1. The bottom line

Use a three-layer stack, all running in your own infrastructure so you
keep every dollar of margin and every row of audit data.

| Layer | What it does | Concrete component |
| --- | --- | --- |
| Pricing source of truth | Maps model name to per-token price in USD/1M, plus prompt-cache, reasoning, audio, and image dimensions. Pulled from `models.dev` and pinned per request. | `pricing_registry` table + a small in-process cache |
| Metering & gateway | Receives an AI request, decides whether to admit it, calls the upstream provider, streams the response, captures final usage, emits one idempotent event. | LiteLLM proxy (`litellm/proxy/proxy_server.py`) extended with your custom admission hooks |
| Wallet & ledger | Owns "how many credits does this user have right now", serializes every grant/deduction, reconciles against the metering layer. | Autumn-style credit system (`autumn/server/src/internal/balances` and `customers`) plus a Postgres ledger |

Three guarantees fall out of this split:

1. Users never get more than they paid for because every request is
   pre-authorized against a hot wallet counter that is decremented
   atomically before the upstream call returns a token.
2. Users pay and instantly get access because the wallet is filled on the
   Stripe webhook, not after a nightly batch.
3. You never lose money because the final, precise cost is reconciled
   against the reservation in a post-call adjustment, and a daily job
   compares the metering database to Stripe's meter summary.

The hardest engineering problem is not the database or the UI — it is the
reservation pattern that prevents overshoot under concurrency. Sections
4 and 5 below make that concrete. Everything else is plumbing.

---

## 2. How the reference systems actually do it

Five companies dominate this category. Their public pricing pages and
engineering posts reveal four distinct mechanisms. Understanding which
mechanism maps to which company tells you what to copy and what to skip.

### 2.1 Cursor: a dollar-denominated pool against API list price

Cursor replaced fixed request counts with dollar-based credit pools tied
to actual model API costs in June 2025. The published price of each plan
is the size of the pool: Pro is $20/mo, Pro+ is $60/mo, Ultra is
$200/mo [1]. The "Auto" routing mode is unlimited on every paid plan
because Cursor picks the cheapest model that fits the task and does not
charge the pool for those calls; only manually selected frontier models
draw down the pool at API list price [2]. There is also a separate
Cursor Token Rate of $0.25 per million tokens on Teams and Enterprise
that surcharges third-party model usage to cover Cursor's routing cost
[1].

The mechanism to copy from Cursor: model your product as **"subscription
price = pool size, pool measured in USD, pool draws against API price at
cost"**. This is the cleanest possible mental model for end users, because
they can predict their bill from public model prices. It also gives you
a graceful fallback when the pool empties: switch the user to a cheaper
auto-routed model until they top up, or accept metered overage at the
same API price (no markup).

### 2.2 Qoder: a fixed-credit pool with expiring top-up packs

Qoder sells plans at the same price points (Pro $20, Pro+ $60, Ultra
$200) but meters usage in **internal Credits** that map to token costs
per model through a published rate table [3]. The most important detail
is the Credit Pack system: prepaid, non-refundable, valid for one month,
stackable, and consumed in expiry order ("expire-soonest-first") [4].
This gives Qoder clean revenue recognition — top-up credits are
recognized when consumed, not when paid — and protects against runaway
refund abuse.

The mechanism to copy from Qoder: **separate subscription credits
(reset monthly) from one-shot Credit Packs (expire in N days)**. Most
builders conflate these and lose either forecasting accuracy or refund
discipline.

### 2.3 Bolt.new and Lovable: pooled subscription with included usage

Both apps sell subscription tiers ($20/mo to $200/mo on Bolt) where a
pool of included usage is allocated at the start of each billing cycle
and top-ups are purchased separately when the pool empties [5]. The
implementation pattern is exactly the same as Cursor's: dollars in, USD
at-cost out, separate add-on packs for heavy users.

### 2.4 OpenRouter: pass-through provider billing, no markup

OpenRouter charges no markup on the underlying provider cost. It earns
its margin from a 5.5% fee that is taken from the user's prepaid credits
at the time of top-up, plus payment-processing fees [6]. This is the
extreme case of the **"BYOK vs. proxy-resold"** axis: OpenRouter pools
its own provider keys and bills at cost.

### 2.5 TokenRouter: pure BYOK, flat-fee SaaS on top

TokenRouter sits at the opposite end. It is a proxy that lets you bring
your own provider API keys; the platform itself charges a flat monthly
fee ($29, $99, or $499) and never sees the token bill [7]. You keep
the relationship with OpenAI/Anthropic/Google, and TokenRouter provides
budgeting, dashboards, and team features on top.

### 2.6 What the spectrum tells you

Four axes separate these products and define the design space you are
entering.

| Axis | Pole A | Pole B |
| --- | --- | --- |
| Provider key | BYOK (customer brings key) | Pooled (you hold provider keys, charge at-cost) |
| Unit of measure | Real USD against API price | Internal Credits against published rate table |
| Revenue model | Subscription pool + overage | Subscription pool + expiring Credit Packs + overage |
| Margin | Zero on tokens, fee on top-ups or flat SaaS | Zero on tokens, fee on top-ups or subscription margin |

For most builders selling their own AI apps, **the Cursor/Qoder pole** is
correct: pooled provider keys, USD-priced pools, optional expiring top-up
packs. You get simplicity for the user, a clean ledger for you, and a
defensible margin if you later want to add a small surcharge on heavy
models.

---

## 3. The architecture you are about to build

The reference systems above all converge on the same underlying shape.
Here it is in the form your team can implement this quarter.

```
┌────────────────────────────────────────────────────────────────────┐
│                         End-user apps                               │
│  (your SaaS app, a chat UI, a coding assistant, a mobile app, ...)  │
└─────────────────┬──────────────────────────────────────────────────┘
                  │  HTTPS, app_key (your virtual key)
                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                         AI Gateway / Proxy                          │
│  • admits request on (user, app) quota                             │
│  • estimates max cost, calls reservation primitive                 │
│  • streams to upstream provider                                    │
│  • captures final usage from the stream                            │
│  • reconciles: replace reservation with actual cost                │
│  • emits idempotent usage event                                    │
└─────┬───────────────────────────┬──────────────────────────────────┘
      │  hot path                  │  cold path
      ▼                            ▼
┌────────────────────┐    ┌────────────────────────────────────────┐
│  Redis             │    │  Postgres                              │
│  • hot credit      │    │  • wallet_balances (source of truth)   │
│    counter per     │    │  • wallet_ledger (append-only events)  │
│    (org, feature)  │    │  • pricing_registry                    │
│  • reservation     │    │  • usage_events (idempotent log)       │
│    set with TTL    │    │  • stripe_customers / stripe_subs      │
│  Lua atomic        │    │  • reconciliation_runs                 │
│    check-and-deduct│    │                                         │
└─────────┬──────────┘    └─────────────┬───────────────────────────┘
          │                            │
          └──────────┬─────────────────┘
                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  Stripe (payment source of truth)                                  │
│  • Checkout / Customer Portal for top-ups                          │
│  • Subscriptions for the recurring pool                            │
│  • Metered Billing for postpaid / hybrid                            │
│  • Webhooks → wallet                                              │
└────────────────────────────────────────────────────────────────────┘
```

Two specifics are worth calling out before the implementation steps.

The **pricing registry** is a small table that pins the per-token cost
for every model you will ever serve, with separate columns for input
tokens, output tokens, cache-read tokens, cache-write tokens, reasoning
tokens, and audio tokens. You populate it once from `models.dev` (or
LiteLLM's `model_prices_and_context_window.json`, which already has the
full Anthropic cache-write/cache-read split) and freeze it per billing
period so a mid-month price change by Anthropic does not retroactively
shift user invoices. LiteLLM keeps exactly this file in their repo and
exposes it through the proxy's `/model/info` endpoint [8].

The **event-emission contract** is the second non-obvious detail. Every
provider gives you a different way to learn the final token counts.
OpenAI requires `stream_options: { include_usage: true }` to send a
final usage chunk on a streaming response; Anthropic emits a
`message_start` with input tokens and a `message_delta` with output
tokens including cache_read_input_tokens and cache_creation_input_tokens
[9]. Your gateway has to normalize these into a single
`{model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
reasoning_tokens}` tuple before computing cost and emitting the event.

---

## 4. The reservation pattern: how users never exceed what they paid

This is the section that most billing-engineering guides skip, and it
is the one that determines whether your system survives a coordinated
load test from a clever user.

The pattern is a **two-phase commit on credits, mirroring credit-card
pre-authorization**. Stripe's own documentation describes this for
physical card payments: hold N dollars on the card, call the provider,
on completion capture the actual amount and release the hold [10]. The
same primitive works for digital credits.

Phase 1 (estimate and reserve). Before the gateway calls the upstream
provider, it asks the wallet primitive for a reservation against the
hot counter for the requesting user. The reservation is the worst-case
cost the upstream call could produce, given the model and the caller's
`max_tokens`. The primitive either returns a reservation token or rejects
the request with HTTP 402.

Phase 2 (reconcile on completion). When the streaming response ends and
the gateway has the final usage, it asks the wallet primitive to
**swap** the reservation for the actual cost. If actual cost is lower
than the reservation, the difference is refunded to the user's balance.
If actual cost is higher, the difference is deducted (and the request
already validated that there was enough headroom in the estimate).

The reference for this exact shape is LiteLLM, which switched on
"reservation" semantics by default in v1.100.0 [11]. The LiteLLM
implementation estimates max cost from the model's max output tokens and
multiplies by the per-token price; reserves against a Redis counter on
the hot path; reconciles in a background job that swaps reservations for
actual spend [11]. Cross-pod safety is provided by Redis acting as the
shared hot store, with Postgres as the cold reconciliation source.

A clean wallet primitive that copies this shape:

```
reserve(user_id, app_id, estimate_usd) -> reservation_id
    // atomic Lua script on Redis
    // checks available_balance >= estimate_usd
    // decrements available_balance
    // writes reservation:{reservation_id} -> {user_id, app_id, estimate_usd, created_at}
    // returns reservation_id or NIL on insufficient funds

capture(reservation_id, actual_usd)
    // atomic Lua script on Redis
    // if actual_usd <= estimate_usd: refund delta to available_balance
    // if actual_usd > estimate_usd: charge delta to available_balance (must be >= 0)
    // remove reservation key
    // append row to wallet_ledger in Postgres with (reservation_id, actual_usd, delta)

release(reservation_id)
    // called when the upstream call fails or times out before capture
    // refunds full estimate
    // append row to wallet_ledger with (reservation_id, estimate_usd, +estimate_usd)

expire_stale_reservations()
    // periodic job (every 60s) that finds reservations older than TTL (e.g. 5 minutes)
    // and releases them — protects against gateway crashes that never call capture
```

The TTL sweep is essential. Without it, a crashed gateway pod leaks
reservations until they accumulate past the user's balance and freeze
the account. The TTL is your safety valve.

The reservation pattern works under concurrency because Redis runs Lua
scripts atomically against a single shard, and `EVALSHA` does not yield
to other clients mid-script. Two parallel requests for the same user
serialize on the same Lua invocation; one wins, the other sees the
reduced balance and either succeeds against the remainder or fails with
402. LiteLLM's post-mortem on this pattern confirms the production
behavior under parallel requests [11].

For users who bring their own provider key (BYOK), the same pattern
applies but with the "estimate" set to zero — you are not on the hook
for provider spend, only for your own platform fees. Most BYOK products
simplify to a request counter and a per-request price.

---

## 5. Concurrency primitives you will need

You will need three primitives in different places. They compose, they
do not replace each other.

| Primitive | Where | What it guarantees |
| --- | --- | --- |
| Redis Lua `EVAL` | Wallet hot path | Atomic check-and-decrement under parallel requests across pods |
| Postgres `SELECT ... FOR UPDATE` | Subscription fulfillment, monthly pool reset | Single-writer per row across all gateway pods |
| Postgres `pg_try_advisory_xact_lock(key)` | Stripe webhook handlers, monthly cron | "Only one instance of this job is running" without blocking |

The Redis Lua is non-negotiable for the hot path. A naive
`UPDATE wallets SET balance = balance - $1 WHERE balance >= $1` in
Postgres is correct under serializable transactions but at AI scale the
round-trip and contention will become your latency floor before you hit
correctness issues. Redis Lua pushes the atomic step into the same
network hop as the balance read.

The Postgres advisory lock is the under-appreciated second primitive.
Use the `xact` variant, which releases at COMMIT/ROLLBACK, behind a
transaction-mode pooler like PgBouncer. The `try_` variant returns
`false` immediately and is the right tool for a webhook handler that
must not block: if you cannot get the lock, another pod is already
processing the Stripe event with the same `event.id`, return 200, drop.
Postgres documents this clearly: advisory locks are cooperative, the
server tracks them but does not enforce their meaning [12]. Use them
only for coordination that fits in one transaction.

The third primitive — `SELECT FOR UPDATE` — is for the cold path:
monthly pool reset, Stripe webhook fulfillment, refund issuance. These
do not need Redis at all. They happen at most a few times per user per
month.

A common pattern that ties all three together: the hot Redis Lua writes
to Redis only; a background worker flushes Redis deltas to the Postgres
ledger in batches; a daily reconciler compares `SUM(usage_events.value)`
in your warehouse to Stripe's meter summary and flags drift above 0.1%.
Stripe itself documents this pattern in its metering guide [13].

---

## 6. Stripe as the payment and subscription layer

Stripe's Billing Meter API is the canonical primitive for the metering
half of the system, and its Subscription API is the canonical primitive
for the recurring pool half. The two compose naturally and you do not
have to choose.

For the recurring pool: create a Subscription with a flat monthly price
(e.g. $20/mo Pro). On `customer.subscription.created` and
`customer.subscription.updated` with `status` ∈ `{active, trialing}`,
grant the user 20,000 credits at the start of the billing period. On
`customer.subscription.deleted` or `status = canceled`, do not delete the
balance immediately — give a grace period of 3 days, then revoke.
Stripe's docs explicitly model the `active`, `trialing`, `past_due`,
`unpaid`, `canceled`, `paused` lifecycle and the webhook events that
drive each transition [14]. Your access state machine should mirror
that.

For one-shot top-ups (the Qoder Credit Pack model): use Stripe Checkout
in `mode=payment` for a one-time charge, then on
`checkout.session.completed` with `payment_status = paid`, credit the
user's wallet with the pack amount. Always set
`client_reference_id = your_internal_user_id` so the webhook can map
back to your user. Always verify the `Stripe-Signature` header against
the raw body (the most common production bug is parsing the body with
`express.json()` before signature verification [14]).

For postpaid metered usage: create a Meter in the Stripe Dashboard
(say, "ai_credits_usd"), then for every request call
`stripe.billing.meterEvents.create({event_name, payload, identifier,
timestamp})`. The `identifier` is your idempotency key — a stable string
derived from the request, e.g.
`req:{user_id}:{request_id}:{provider_call_id}` — and Stripe
deduplicates events with the same identifier inside a 24-hour window
[13]. Up to 10,000 unique combinations per hour per meter is the
current limit [13].

For "auto top-up when low": combine a Stripe Subscription with an
add-on Metered price for overage, and listen for your own internal
"balance below threshold" event to send a one-time charge via Stripe
Checkout (or use Stripe's announced "instant low-balance alerts and
automatic credit top-ups" feature if you are on a current API version
[15]). The simpler pattern is to expose a Customer Portal page that
lets the user configure auto-top-up with a saved payment method; that
keeps Stripe in the driver seat and keeps you out of stored-card
compliance scope.

A non-obvious detail: **drive access off subscription `status`, not off
raw money events**. `invoice.payment_succeeded` is tempting but
unreliable — Stripe's `Smart Retries` re-attempt failed payments and
fires intermediate webhooks [16]. The status field on the subscription
is the consolidated truth. Your entitlement table should look like:

```
status:       Stripe API value
access_state: pending | granted | grace | revoked
mapping:
  incomplete              -> pending
  trialing, active        -> granted
  past_due                -> grace    (N days, then revoke)
  paused, unpaid, canceled -> revoked
```

This is the same shape Cursor's "grace period after credit pool runs
out" implies [2], and the same shape the Claude Code Lab "subscriptions
with Stripe" guide recommends [14].

---

## 7. The fallback path: when the pool empties

Cursor's most copied UX detail is the **"graceful degradation, not hard
wall"** rule. When a user's pool runs out, Cursor does not slam a 402 in
their face — it switches them to Auto routing (which uses cheaper
models and does not draw the pool) until the next billing cycle [2].
Qoder does the same: when premium credits are exhausted, requests
automatically switch to a basic-model service that continues to serve
the user up to a daily limit [4].

Implement this as a tier cascade at the gateway:

1. Tier 1: subscription pool credits. Draw first.
2. Tier 2: Credit Packs, in expiry order. Draw next.
3. Tier 3: Auto-routed fallback model (cheap or local) if pool + packs
   are empty and `allow_degradation = true`. Serve a header
   `X-Billing-Mode: degraded` so the UI can show a banner.
4. Tier 4: HTTP 402 with a deep link to the Customer Portal if the user
   has `allow_degradation = false` or hit the basic-model daily cap.

The cascade lives in a single function in the gateway; everything else
is configuration.

---

## 8. Build vs. buy: choosing your stack

The system you are about to build is composed of about nine
subsystems. Three of them are commoditized enough that you should
strongly consider not building them yourself.

| Subsystem | Build | Buy (best option in 2026) |
| --- | --- | --- |
| Wallet / ledger (credits, reservations, expiry) | Fine, this is your moat | Autumn self-host (you have it locally) — has all the primitives |
| Pricing registry (model -> USD/1M tokens) | Fine, one table | LiteLLM proxy ships `model_prices_and_context_window.json` [8] |
| Gateway (admission, streaming, usage capture) | Multi-month build | LiteLLM proxy (you have it locally) — supports 100+ providers, virtual keys, team budgets [11] |
| Stripe integration | Fine | Use Stripe Billing Meter + Subscriptions directly [13] |
| Customer portal | Use Stripe's hosted portal — free | Stripe Customer Portal |
| Usage analytics / dashboards | Build light or buy | ClickHouse + Tinybird; or Stripe's built-in usage views |
| Subscription dunning | Use Stripe's Smart Retries | Stripe built-in [16] |
| Webhook reliability | Build a tiny worker | Best to build (5–10 lines of code with an idempotency table) |
| Tax / VAT / compliance | Buy | Stripe Tax |

Two strong "buy" candidates are worth calling out separately.

**Orb** is a usage-billing platform built specifically for AI. It
ingests events with HTTP POST or batched ingestion, supports volumetric
pricing with tiered and bulk discounts, and handles the aggregation
fully on its side [17]. If your team is small and you want zero in-house
ledger code, Orb removes about three weeks of work.

**Lago** is the open-source equivalent to Orb. It has a wallet/credit
primitive built in and supports metered events over HTTP [18]. It is
the right pick if you want OSS licensing but do not want to write the
ledger yourself.

Stripe's own Billing Meter product is the third option and the one most
teams underestimate. It now ships with low-balance alerts and automatic
top-ups in private preview [15], which is exactly the Cursor-style UX.
If your product can express the entire billing model as Stripe
subscriptions + Stripe metered billing, you can ship in days, not
weeks. The cost is that you give up some of the in-product UX control
and have to live with Stripe's mental model for some things.

My recommendation for your situation, given the local repos:

- **LiteLLM proxy** as the gateway. It already implements the
  reservation pattern, virtual keys, per-user budget enforcement, and
  multi-provider support [11].
- **Autumn self-hosted** as the wallet / ledger / pricing layer. Your
  local checkout at `C:\Users\craig\Desktop\AI billing\autumn` already
  has `track`, `check`, and `attach` endpoints with the credit-pool
  primitives; it is a self-hostable Postgres + Redis + React stack and
  its codebase is explicitly designed to be extended.
- **Stripe** for payments, subscriptions, customer portal, dunning, and
  tax. You do not need Orb or Lago unless you outgrow Stripe's model.
- A thin **app-specific shim** (yours to build, ~200 LOC) that bridges
  your apps' auth layer to LiteLLM virtual keys and to Autumn customer
  IDs.

This stack gives you everything Bolt, Cursor, and Lovable have, with
the engineering choices already battle-tested in production. The total
new code is the shim, plus a few Autumn endpoints you customize for
your pricing rules.

---

## 9. Step-by-step implementation

These are the steps in the order they unblock each other. Each step
ends with a concrete verification you can run before moving on.

### Step 1 — Pick the canonical pricing registry

Freeze a single source of truth for model pricing. The lowest-risk
choice is the file
`litellm/litellm/model_prices_and_context_window.json` in the LiteLLM
repo you have locally. It already encodes the Anthropic prompt-cache
split (cache_creation_input_tokens and cache_read_input_tokens billed
separately), the OpenAI cached-input price, and the reasoning-token
premium [8].

Copy the file into your own repo, load it into Postgres at boot time,
and expose `GET /v1/pricing` from your gateway so the rest of the
system reads from there. Pin it once per calendar month: when a
provider changes price mid-month, new requests use the new file but
already-emitted usage events keep their original pricing. This
prevents retroactive invoice corrections.

Verify: `curl localhost:8080/v1/pricing | jq '.data["claude-sonnet-4-5"]'`
returns the cache_read and cache_write fields.

### Step 2 — Bring up Postgres, Redis, and the schema

Run Postgres and Redis. The schema is the heart of the system. Eight
tables is enough; resist the temptation to add more.

```
-- Pricing (cold, rarely written)
pricing_registry (
  id, model_name, vendor,
  input_per_1m, output_per_1m,
  cache_read_per_1m, cache_write_per_1m,
  reasoning_per_1m, audio_per_1m,
  effective_from, effective_to,
  UNIQUE(model_name, effective_from)
)

-- Wallet (cold, source of truth)
wallets (
  id, org_id, app_id, feature_id,
  subscription_credits, pack_credits, free_credits,
  low_balance_threshold, allow_degradation,
  created_at, updated_at,
  UNIQUE(org_id, app_id, feature_id)
)

-- Ledger (append-only, never updated, never deleted)
wallet_ledger (
  id, wallet_id, ts, kind, amount_usd, credits_delta,
  reservation_id, request_id, provider_call_id, idempotency_key,
  metadata jsonb
)

-- Reservations (short-lived)
reservations (
  id, wallet_id, estimate_usd, captured_usd,
  status, model, max_tokens, created_at, expires_at, captured_at
)

-- Usage events (idempotent log)
usage_events (
  id PRIMARY KEY,  -- this is your idempotency key
  org_id, app_id, model,
  input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens,
  cost_usd, request_id, provider_call_id,
  occurred_at, ingested_at
)

-- Stripe state (cold)
stripe_customers (org_id, stripe_customer_id)
stripe_subscriptions (org_id, stripe_subscription_id, status, current_period_end)

-- Webhook idempotency
stripe_webhook_events (event_id PRIMARY KEY, processed_at, payload jsonb)
```

Two invariants the schema enforces at the database level, not in code:

1. `usage_events.id` is the primary key, so duplicate ingestion is a
   unique-constraint violation that the gateway handles as "already
   processed, ignore".
2. `wallet_ledger` rows are never UPDATEd or DELETEd. Corrections are
   new rows with a `kind = 'correction'` that references the original.

Verify: insert a duplicate `usage_events` row and confirm the second
insert fails with a unique-constraint error.

### Step 3 — Stand up LiteLLM proxy with virtual keys

In your local LiteLLM repo, configure the proxy with a Postgres-backed
config and Redis as the spend store:

```yaml
litellm_settings:
  drop_params: true
  set_verbose: false
  database_url: postgresql://...   # config + spend log
  cache: true
  cache_params:
    type: redis
    host: redis
general_settings:
  master_key: os.environ/PROXY_MASTER_KEY
  database_url: postgresql://...
  proxy_budget_rescheduler_min_time: 60
  proxy_budget_rescheduler_max_time: 120
  redis_host: redis
  redis_port: 6379
```

For each (org, app) pair you onboard, call
`/key/generate` to mint a virtual key with `max_budget` set to that
user's pool. The proxy will enforce the budget across pods via Redis
[11]. Confirm with `curl -H "Authorization: Bearer <vkey>" localhost:4000/v1/models`.

### Step 4 — Deploy Autumn as your wallet / ledger service

In your local Autumn repo, point it at the same Postgres and Redis. The
key endpoints to use are:

- `POST /attach` — when a user picks a plan, returns the Stripe
  Checkout URL or applies the upgrade directly.
- `POST /check` — feature gate; with `send_event = true` and
  `value_to_use` set, atomically deducts from the credit pool.
- `POST /track` — record a usage event outside of the feature gate
  (used when cost is known after the fact, e.g. usage-based features).
- `POST /track_tokens` — specifically for AI token accounting
  with `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, and model name (resolved via
  `models.dev`).
- `GET /entitled` — list features and remaining allowance.

The local source under `autumn/server/src/internal/balances` and
`autumn/server/src/internal/customers` is where you extend the schema
and the reservation primitive if you need to.

Verify: `curl -X POST localhost:8080/check -d '{"customer_id":"u_1","feature_id":"ai_credits","send_event":true,"value_to_use":100}'` returns
`allowed: true` and reduces the balance by 100.

### Step 5 — Wire the Stripe webhook to the wallet

Implement one webhook handler at `POST /webhooks/stripe` with these
properties:

1. Mount with `express.raw({type: 'application/json'})` before any
   global `express.json()` (the most common bug per Stripe's
   documentation [14]).
2. Verify with `stripe.webhooks.constructEvent(payload, sig, secret)`.
   Return 400 on failure.
3. Insert into `stripe_webhook_events (event_id, payload)` with a
   unique constraint on `event_id`. If insert fails, return 200 and
   drop — this is a retry.
4. Dispatch on `event.type`:
   - `checkout.session.completed` → grant Credit Pack to wallet via
     Autumn `POST /track`.
   - `customer.subscription.created` / `.updated` (status ∈
     {active, trialing}) → reset pool to plan amount at
     `current_period_start`.
   - `customer.subscription.deleted` → start grace countdown.
   - `invoice.payment_failed` → set `access_state = grace`, send
     dunning email.
   - `invoice.paid` → clear grace.

Verify: `stripe trigger checkout.session.completed` from the CLI and
confirm the user's wallet incremented by the expected amount.

### Step 6 — Build the gateway bridge

The bridge is the only piece of new code you cannot avoid. It is
roughly 200 LOC and lives between your apps and LiteLLM. Its job:

1. Resolve `(org_id, app_id) -> virtual_key` (cache in Redis).
2. Resolve `model -> pricing` (cache in Redis with monthly TTL).
3. Compute `estimate_usd = max_output_tokens * output_per_1m / 1e6 +
   input_tokens * input_per_1m / 1e6` (worst case for the call).
4. Call Autumn `POST /check` with `value_to_use = estimate_usd` and
   `send_event = true`. If `allowed = false`, return HTTP 402.
5. Stream the request to LiteLLM with `stream_options.include_usage =
   true` (OpenAI) or the equivalent Anthropic header.
6. On the final usage chunk, compute `actual_usd` and call Autumn
   `POST /track_tokens` with the precise token breakdown. Autumn
   handles the reservation-vs-actual reconciliation internally when
   you pass the `idempotency_key` you generated in step 4.

Verify: hit the gateway with two parallel requests from the same user
whose balance barely covers one. Exactly one returns 200; the other
returns 402. Repeat 100 times; results are consistent.

### Step 7 — Add the Customer Portal and auto-top-up

Embed Stripe's hosted Customer Portal link in your settings UI. Enable
"Customers can update payment methods, cancel subscriptions, and view
invoices" with the defaults. For auto-top-up, you have two options:

- **Stripe-driven**: add a metered add-on price to the subscription
  ($0.50 per 1,000 credits after the pool runs out). Use Stripe Smart
  Retries to recover failed auto-payments [16].
- **App-driven**: emit a "low balance" event from your gateway when
  `balance < low_balance_threshold`, send the user to a one-time
  Checkout session for a Credit Pack. Stripe's 2026 announcement of
  "instant low-balance alerts and automatic credit top-ups" hints this
  will become a first-class Stripe feature [15].

Verify: simulate a low-balance event and confirm the user receives a
Checkout link in under 30 seconds.

### Step 8 — Reconciliation and observability

Run a daily reconciliation job that, per active user, compares:

1. `SUM(wallet_ledger.credits_delta WHERE kind in ('usage','correction'))`
   against your Stripe meter summary for the same window.
2. `wallets.subscription_credits + wallets.pack_credits + wallets.free_credits`
   against `SUM(wallet_ledger.credits_delta WHERE kind in ('grant','reset'))`.

Flag any divergence above 0.1% and post to a Slack channel. This is
the only way to catch a Redis eviction that lost the hot counter, a
provider billing change you missed, or a customer who tampered with the
client. Stripe's own metering guide describes the same three-layer
reconciliation [13].

Verify: deliberately cause a 1% divergence by editing a ledger entry,
run the reconciler, confirm the alert fires.

### Step 9 — UX, in-product

The end-user surface is small but matters:

- A "Credits" widget on every app showing `remaining / monthly_pool`,
  refresh rate ≤ 5 s.
- A 20%, 10%, and 0% low-balance banner with a deep link to the
  Customer Portal or your top-up page.
- A "Why did this cost N credits?" tooltip per request that resolves
  `model -> pricing -> tokens -> cost_usd -> credits` (5 fields, all
  cached).
- A monthly invoice that itemizes by model and by day, generated from
  `wallet_ledger`.

Verify: a new user can buy a $20 plan, use the app until credits are
gone, get redirected to top-up, complete payment, and resume usage in
under 60 seconds.

---

## 10. Pitfalls and the guarantees they break

Seven pitfalls are responsible for almost every production incident in
this category. Each is preventable.

**Stripe webhook body parsing.** Express's `express.json()` mounted
before the webhook route silently mangles the signature, and
`constructEvent` returns 400 only at runtime. Mount
`express.raw({type: 'application/json'})` on the webhook route first
[14].

**Redis as the only source of truth.** Redis can evict, restart, or
lose a shard. The hot counter is a cache; the Postgres ledger is the
truth. A user who "loses" credits after a Redis flush has a real
complaint that your ledger can answer.

**Mid-month pricing changes.** When Anthropic drops cache-write prices,
you must freeze the previous price for events that already happened.
Stripe's correction-event pattern handles this: emit a new
`usage_events` row tagged `kind = correction` referencing the original,
and never rewrite the original row [13].

**Provider usage arrives late.** Anthropic occasionally sends a final
usage chunk a few hundred ms after the stream end-of-stream marker.
Your gateway must hold the response open until either the usage chunk
or a 5-second timeout fires, then capture. Streaming tokens and not
capturing is the single largest source of revenue leak in production.

**Streaming response ends with cancellation.** A user closes their
browser mid-stream. Your gateway must still capture whatever usage
already happened and not let the reservation leak. Set TTL to 5 minutes
and run the expire sweep every 60 seconds.

**Prompt cache cost direction.** Anthropic charges the cache-write on
the request that wrote the cache and the cache-read on the request
that read it. If you only bill cache-read and forget cache-write, you
will under-charge by 30–60% on cache-heavy workloads. LiteLLM's pricing
file models this correctly [8].

**Reservation vs. actual cost in offline mode.** If your gateway goes
offline for ten minutes and queues requests, do not retry them with
their old reservation IDs. Re-authorize on the other side of the
outage and emit usage events with new IDs; the original reservations
will expire on their TTL.

---

## 11. What you can launch in 30 days

A realistic ramp-up, calibrated to your local repos:

- **Days 1–3**: stand up Postgres, Redis, Stripe in test mode. Load the
  pricing registry from LiteLLM's JSON file. Build the schema.
- **Days 4–7**: deploy LiteLLM proxy with one provider (start with
  OpenAI; add Anthropic and Google in week 2). Confirm virtual keys and
  budget enforcement work end-to-end.
- **Days 8–12**: deploy Autumn. Wire `POST /check` and `POST /track` to
  your apps' test users. Build the gateway bridge.
- **Days 13–17**: implement the Stripe webhook handler, the Customer
  Portal embed, and the auto-top-up rule.
- **Days 18–22**: build the daily reconciliation job and the in-app
  Credits widget. Add observability dashboards (Grafana on top of the
  Postgres ledger).
- **Days 23–30**: load test with a parallel-request harness. Hammer the
  gateway with 100 RPS from 50 simulated users. Confirm the
  reservation pattern holds, the wallet never goes negative, and the
  reconciler reports zero drift.

At the end of 30 days you will have a billing system that is at least
as precise as Cursor's, at least as forgiving as Qoder's, and at least
as cheap to operate as Bolt's. The marginal engineering cost after that
is per-UX-feature, not per-billing-feature, because the hard parts
(reservation, idempotency, reconciliation, top-up expiry) are done.

---

## 12. Concrete file pointers in your local repos

Two paths on your machine map directly to the design above.

`C:\Users\craig\Desktop\AI billing\litellm\litellm\proxy\spend_tracking`
contains the budget-reservation, cross-pod spend counter, and
Redis-backed hot-spend code path. This is the file you read first to
see exactly how the reservation pattern is implemented in production
[11].

`C:\Users\craig\Desktop\AI billing\autumn\server\src\internal\balances`
and `C:\Users\craig\Desktop\AI billing\autumn\server\src\internal\customers`
contain the credit-pool, attach/check/track, and Stripe-webhook
fulfillment logic. This is the file you read second to see exactly how
the wallet primitives expose themselves to your gateway and to Stripe
events.

You do not need to fork either repo to ship. You will, however, want to
read both codebases end-to-end before writing the gateway bridge, so
your bridge matches their semantics rather than re-inventing them.

---

## References

[1] Cursor, "Models & Pricing", Cursor Docs.
    <https://cursor.com/docs/models-and-pricing>

[2] Cursor, "Clarifying our pricing", Cursor Blog, June 2025.
    <https://cursor.com/blog/june-2025-pricing>

[3] Qoder, "Credits", Qoder Docs.
    <https://docs.qoder.com/Credits>

[4] Qoder, "Pricing", Qoder Docs.
    <https://docs.qoder.com/account/pricing>

[5] Bolt.new / Lovable pricing pages (current as of late 2026);
    cross-referenced via Coworker AI and LowCode Agency pricing
    analyses.
    <https://coworker.ai/blog/cursor-pricing>

[6] OpenRouter, "Pricing", OpenRouter Docs.
    <https://openrouter.ai/docs/pricing>

[7] TokenRouter, "Pricing", TokenRouter Docs.
    <https://docs.tokenrouter.ai/>

[8] LiteLLM, "model_prices_and_context_window.json", repository file.
    <https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json>

[9] LiteLLM, "Cost tracking", LiteLLM Docs.
    <https://docs.litellm.ai/docs/completion/json_mode#cost-tracking>

[10] Stripe, "How authorization and capture work", Stripe Docs.
     <https://docs.stripe.com/payments/place-a-hold-on-a-payment-method>

[11] LiteLLM, "Budget Reservation" and "Setting Max Budget Per User",
     LiteLLM Docs (v1.100.0+).
     <https://docs.litellm.ai/docs/proxy/users>

[12] PostgreSQL Global Development Group, "Explicit Locking" and
     "System Administration Functions", PostgreSQL Documentation.
     <https://www.postgresql.org/docs/current/explicit-locking.html>

[13] Stripe, "Record usage for billing with the API", Stripe Docs.
     <https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api>

[14] Stripe, "Using webhooks with subscriptions", Stripe Docs.
     <https://docs.stripe.com/billing/subscriptions/webhooks>

[15] Stripe, "Everything we announced at Sessions 2026", Stripe Blog
     (auto credit top-ups and low-balance alerts).
     <https://stripe.com/blog/everything-we-announced-at-sessions-2026>

[16] Stripe, "Automate payment retries", Stripe Docs.
     <https://docs.stripe.com/billing/revenue-recovery/smart-retries>

[17] Orb, "Ingest events for usage-based pricing", Orb Docs.
     <https://docs.withorb.com/docs/event-ingestion>

[18] Lago, "Metered billing and wallet architecture", Lago Docs and
     GitHub repository.
     <https://docs.getlago.com/>