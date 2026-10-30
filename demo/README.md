# Local demo — the billing loop with no real keys

A self-contained dry run of the whole stack: chat completions flow through
LiteLLM, Autumn admits / meters / debits them, and you watch a wallet drain
until admission control refuses the next call — all with a mock LLM provider
instead of OpenAI/Anthropic and no Stripe/PayPal at all.

```
demo-customer ──► LiteLLM :4000 ──► mock LLM :9999        (stands in for providers)
                     │  ▲
        /check,      │  │  /track_tokens, /balances.finalize
        402 deny     ▼  │
                  Autumn :8080 ──► Postgres :5433 / Redis :6380
```

## Run it

```bash
# 1. Infrastructure (postgres x2, redis x2)
docker compose up -d

# 2. Autumn billing server   (terminal 1)
cd autumn/server
NODE_ENV=development bun src/index.ts

# 3. Mock LLM provider       (terminal 2)
python demo/mock_llm.py

# 4. LiteLLM proxy           (terminal 3) — loads litellm/.env
cd litellm
set -a && source .env && set +a
litellm --config config.yaml --port 4000

# 5. Seed the demo data, then walk through the story
python demo/bootstrap.py
python demo/run_demo.py
```

Prereqs: Python 3.12 with the `litellm` package installed (`pip install -e
"../litellm[proxy]"` from `litellm/` — brings httpx/uvicorn used here),
[Bun](https://bun.sh), and the LiteLLM + Autumn DBs already migrated (see
`../DEPLOY.md`).

## What `bootstrap.py` seeds

A fresh Autumn DB has no organization, so the script:

1. **psql** — inserts org `demo` + a sandbox secret key (`am_sk_test_…`,
   stored hashed, same SHA-256 scheme as `server/src/internal/dev/apiKeys`).
   The same key is the bridge's `AUTUMN_API_KEY` in `litellm/.env`.
2. **`POST /v1/features`** — creates `ai_tokens` of type
   `ai_credit_system`, with `model_markups` pricing `custom/demo-gpt` at
   $20/M input, $80/M output. 1 credit = $1 of computed model cost.
3. **`POST /v1/plans`** — free plan `demo-starter` granting 2.00
   credits/month of `ai_tokens` with `auto_enable: true`.
4. **`POST /v1/customers`** — creates `demo-customer`; the auto-enable plan
   attaches on creation and grants the credits (in production this attach is
   what a Stripe/PayPal subscription webhook triggers).
5. **`POST /v1/check`** — verifies admission would allow the customer.

Idempotent: re-running resets to the same state.

## What `run_demo.py` shows

| Phase | What happens |
|---|---|
| 1 | Starting balance: 2.00 credits |
| 2 | Chat calls through LiteLLM; balance drops by the computed cost after each. A call with 8,000 of 10,000 input tokens **cached** bills only the fresh tokens |
| 3 | A second model (`gpt-4o-mini-mock`) billed from **models.dev list rates** with zero pricing config |
| 4 | Drain: once the balance is below `AUTUMN_REQUIRED_BALANCE` (0.5 here), the NEXT call is refused with **HTTP 402 before any provider is touched** |
| 5 | Top-up via `POST /v1/customers/:id/balances` — the call a payment webhook would trigger — and the customer is admitted again |
| 6 | The usage ledger: every call in the `events` table with token pools, base cost, markup, and final credits |

Usage is controlled from the prompt; `demo/mock_llm.py` parses directives
like `[usage: in=10000 out=2000 cache_read=8000]` (stripped from the reply).

## Knobs worth knowing

- `litellm/.env` — all bridge config. `AUTUMN_REQUIRED_BALANCE` (minimum
  headroom for admission), `AUTUMN_MODEL_ID_MAP` (LiteLLM alias →
  Autumn-billable id), `AUTUMN_FAIL_MODE=open|closed` (an Autumn outage
  serves unbilled inference when `open`; use `closed` in production).
- `demo/mock_llm.py` — add models/usage shapes freely; anything served here
  is billed through the exact same path as a real provider.
- The `events` ledger dedupes on `idempotency_key` (the LiteLLM call id), so
  bridge retries can't double-bill.

## Fixes made while building this demo (all upstream-relevant)

1. **Usage source** — current LiteLLM hands `async_log_success_event` a
   `response_obj` whose `.usage` holds the tokens; `kwargs["usage"]` is
   `None`. The bridge now reads `response_obj.usage` first.
2. **Model id mapping** — LiteLLM passes bare aliases / provider-echoed
   names (`demo-gpt`, `gpt-4o-mini`); Autumn needs `<provider>/<model>` or
   `custom/<name>`. New `AUTUMN_MODEL_ID_MAP` bridges them; unmapped ids pass
   through. `AUTUMN_REQUIRED_BALANCE` likewise makes the headroom explicit.
3. **Redis v2 pool** — without `CACHE_V2_DRAGONFLY_URL`, the full-subject
   cache pool dials ioredis's default `127.0.0.1:6379` and every
   customer read sheds with 503. Added to `autumn/server/.env` +
   `.env.example`.
4. **plpgsql functions** — `deduct_from_cus_ents` and friends live in
   `server/src/internal/balances/utils/sql/`, outside drizzle migrations,
   and had no installer: every deduction 500'd. `initializeDatabaseFunctions()`
   now runs at server boot (dev + prod).
5. **Event batching without a queue** — event inserts are enqueued
   (`InsertEventBatch`); with `SQS_QUEUE_URL_V2` unset they were silently
   dropped, so usage was deducted but never recorded. In development the
   batch now inserts inline (mirroring track's own sync fallback).
6. **Missing-queue 500s** — plan create hard-failed on `addTaskToQueue`'s
   throw when no queue is configured. Development now logs and continues;
   production still throws.

Bridge changes are covered by `litellm/tests/test_autumn_billing.py`
(14 tests, `pytest tests/test_autumn_billing.py -q`).

## Not covered by the demo

- Real Stripe/PayPal webhook flows (subscription lifecycle, top-ups, the
  `litellm_virtual_key` provisioning in `litellmKeys.ts`). Everything is in
  place — swap the mocked "money in" step for real keys when ready.
- Multi-tenant isolation in the UI (the demo identifies customers by the
  OpenAI `user` field on the request; production binds virtual keys).
