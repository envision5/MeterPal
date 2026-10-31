# MeterPal — the PayPal-native billing gateway for AI applications

**One SDK, and your app's AI usage bills itself through PayPal.**

MeterPal meters every AI call per end user (tokens → cost → credits), debits a
prepaid wallet with atomic admission control — a call is refused with **HTTP
402 before the model provider is touched** when the balance is too low — and
moves every dollar through PayPal: **Orders v2** for credit packs,
**Subscriptions** for plans, **Invoicing** for overage, and **webhooks** that
grant entitlements the moment money lands. An **MCP server** lets AI agents
run the whole commercial loop — including an agent that buys its own credits
when it runs out.

PayPal has no metered/usage-based billing product (there is no usage-recording
endpoint anywhere in its REST catalog). MeterPal is that missing layer.

```
                         ┌────────────────────────────────────────────┐
                         │                PayPal (sandbox)            │
                         │  Orders v2 · Subscriptions · Invoicing     │
                         └───────▲───────────────────────┬────────────┘
              approval link      │                       │ webhooks
              (checkout)         │ capture / activate    │ (signature-verified,
                                 ▼                       │  idempotent)
 ┌──────────────┐   /check +    ┌────────────────────────────────────────────┐
 │ your app     │  /track_tokens│           MeterPal billing server          │
 │ + @meterpal/ ├──────────────►│  wallet ledger · credit systems · catalog  │
 │ sdk (React)  │  402 on broke │  PayPal adapter · LiteLLM key provisioning │
 └──────┬───────┘               └───────────────┬────────────────────────────┘
        │ /v1/chat/completions                  │ Postgres + Redis
        ▼                                       └────────────────────────────
 ┌────────────────────────┐
 │ metered AI gateway     │   every call: pre-authorize → serve → meter
 │ (LiteLLM + MeterPal    │   tokens → debit credits (idempotent)
 │  usage hook)           │
 └───────────┬────────────┘
             ▼
      AI providers (or the bundled mock LLM)
```

## Quickstart (no keys of any kind)

```bash
git clone <this repo> && cd meterpal

# 1. infrastructure: 2× Postgres + 2× Redis
docker compose up -d

# 2. billing server (billing/)  — terminal 1
cd billing/server && bun install && bun run dev      # :8080

# 3. mock LLM provider              — terminal 2
python demo/mock_llm.py                              # :9999

# 4. metered gateway (gateway/)     — terminal 3
cd gateway && set -a && source .env && set +a
litellm --config config.yaml --port 4000

# 5. seed the demo org, catalog, customers
pip install -e sdk/python
python demo/bootstrap.py

# 6. watch the billing loop
python demo/run_demo.py
```

`run_demo.py` walks the whole story: balance drains per call, a call is
refused with 402 once the wallet dips below headroom, a top-up re-admits the
customer, and every call lands in the events ledger with token pools, base
cost, markup and final credits.

## With PayPal sandbox keys

```bash
# billing/server/.env
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...            # or auto-register (next line)
METERPAL_CHECKOUT_RETURN_URL=http://localhost:5173
```

Then either register the webhook by hand (point it at
`<public-url>/webhooks/paypal`) or let the bootstrap do it through a tunnel:

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_WEBHOOK_URL=https://<tunnel>/webhooks/paypal \
  python demo/bootstrap.py
```

Buy credits in the demo app with a sandbox buyer account and watch the
`PAYMENT.CAPTURE.COMPLETED` webhook credit the wallet in real time.

```bash
cd demo-app && bun install && bun run dev     # http://localhost:5173
```

## The agentic loop

```bash
# merchant agent: "show low-balance customers, invoice the overage"
export METERPAL_SECRET_KEY=am_sk_test_...
python agent/merchant_demo.py            # scripted; --llm for function calling

# agent-as-buyer: 402 → agent creates a PayPal order → webhook credits → retry
export LITELLM_MASTER_KEY=...
python agent/buyer_demo.py
```

The MCP server (`agent/mcp/server.ts`) exposes the same tools to any MCP
client; compose it with PayPal's own remote MCP server (`mcp.paypal.com/sse`)
for native PayPal operations.

## Repository layout

| Path | What it is |
|---|---|
| `billing/` | MeterPal billing server + merchant dashboard — Apache-2.0 fork of [Autumn](https://github.com/useautumn/autumn) (upstream went private 9/2026) with the PayPal rail built on top |
| `gateway/` | Metered AI gateway — MIT fork of [LiteLLM](https://github.com/BerriAI/litellm) with the MeterPal usage-billing hook (no core files modified) |
| `sdk/typescript/` | `@meterpal/sdk` — React components + client for end-user billing UI |
| `sdk/python/` | `meterpal` — Python client + LiteLLM hook re-export |
| `agent/` | MCP server + merchant/buyer demo agents |
| `demo-app/` | The demo chat app whose AI usage is billed live |
| `demo/` | Mock LLM provider, bootstrap seeding, scripted billing-loop walkthrough |
| `docs/` | Original design research (Stripe-era); see `CHANGELOG.md` for provenance |

## Guarantees

1. **No overspend** — every request is pre-authorized against a hot wallet
   counter decremented atomically (Redis Lua) before the upstream call.
2. **Instant access after payment** — the wallet is filled by PayPal webhooks,
   not nightly batches.
3. **No double-billing** — metering events are idempotent on the gateway call
   id; webhook grants are idempotent on the capture/sale/invoice id.

## License

Apache-2.0 (see `LICENSE` and `NOTICE` for the Autumn and LiteLLM fork
attributions).
