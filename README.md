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
 │ sdk  ·  CLI  │  402 on broke │  PayPal adapter · gateway key provisioning │
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

---

## Try it in 60 seconds

You do not need a PayPal account, a provider key, or any setup to see the
paywall work. The bundled demo runs the whole loop against a mock LLM:

```bash
git clone <this repo> && cd meterpal
docker compose up -d                      # 2× Postgres + 2× Redis
cd billing/server && bun install && bun run dev   # :8080
# in another terminal:
python demo/mock_llm.py                   # :9999 — stands in for OpenAI
cd gateway && set -a && source .env && set +a && litellm --config config.yaml --port 4000
# and in a third:
pip install -e sdk/python && python demo/bootstrap.py && python demo/run_demo.py
```

`run_demo.py` walks the story: the balance drains per call, a call is **refused
with 402 once the wallet dips below headroom**, a top-up re-admits the customer,
and every call lands in the events ledger with token pools, base cost, markup
and final credits. Full walkthrough: [`demo/README.md`](demo/README.md).

With real money, follow [With PayPal sandbox keys](#with-paypal-sandbox-keys).

---

## Three ways to integrate

The point of MeterPal is that a developer should not have to work out how to
wire a payments rail into their app.

**1. The SDK — one OpenAI-shaped call, billed to the end user.**

```ts
import { createMeterPal } from "@meterpal/sdk";

const meterpal = createMeterPal({ apiKey: process.env.METERPAL_SECRET_KEY });

const completion = await meterpal.chat.completions.create({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "hi" }],
	user: "cus_123",              // the end user being billed
});
completion.meterpal.credits_charged;
```

The key never reaches the browser. A `402` surfaces as `InsufficientBalanceError`
carrying `balance` and `requiredCredits`, and `error.topUp()` returns the PayPal
checkout URL.

**2. The CLI — let the tool write the integration.**

```bash
npx @meterpal/sdk init
```

`init` detects the framework (Next, Express, Hono, Fastify, plain Node), writes
the environment and a server-side handler that keeps the secret key off the
browser, and prints the snippet to start from. It is deterministic: it does not
guess, it installs a known-good integration for the framework it found.

**3. MCP — let your coding agent do it.**

The MCP server (`agent/mcp/server.ts`) exposes the merchant operations
(`meterpal_get_customer`, `meterpal_get_customer_usage`,
`meterpal_list_low_balance_customers`, `meterpal_grant_credits`,
`meterpal_create_overage_invoice`, `meterpal_create_checkout_link`) to any MCP
client. Compose it with PayPal's own remote MCP server (`mcp.paypal.com/sse`)
for native PayPal operations.

---

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

---

## The agentic loop

```bash
# merchant agent: "show low-balance customers, invoice the overage"
export METERPAL_SECRET_KEY=am_sk_test_...
python agent/merchant_demo.py            # scripted; --llm for function calling

# agent-as-buyer: 402 → agent creates a PayPal order → webhook credits → retry
export LITELLM_MASTER_KEY=...
python agent/buyer_demo.py
```

---

## What was built during this hackathon (2026-10-01 → 2026-11-12)

MeterPal existed before this hackathon as a **fork point**: a wallet-and-metering
core, a first PayPal webhook adapter, and a LiteLLM usage bridge, committed on
**2026-09-30** as `0.1.0-baseline` so that everything after it is visible in git
history. Everything below is new work performed inside the submission window,
in the order of the architecture plan in [`docs/architecture.md`](docs/architecture.md):

| Phase | What shipped |
|---|---|
| **P0 — Live metering** | The gateway actually bills again: config in the environment, a shared `PAB_TRUST_SECRET`, the tenant carried in the key itself, per-customer and per-org rpm/tpm ceilings, and `scripts/verify-tenant-isolation.ps1` asserting a spoofed customer header, an admin key, an off-sheet model and an unknown key are all refused. |
| **P1 — Multi-tenant PayPal** | A merchant's PayPal account is theirs, not the platform's. Every call goes through a client built from the org's own row, secret encrypted at rest, token cached per org. Webhooks move to `POST /webhooks/paypal/:orgId/:webhookId` so the signature is verified against *that* org's webhook id. The dashboard gets a PayPal integration panel that verifies credentials before storing them. |
| **P2 — The merchant's price sheet** | `served_models` is the per-org price sheet: what a merchant charges is the merchant's decision, so a provider price change cannot move it. `/check` pins the unit rates and the settle uses them verbatim. Verified: a call at 20/80 cost 0.36; after setting 60/100 in the dashboard the same call cost 1.76. |
| **P3 — The inference proxy and the SDK** | `POST /v1/chat/completions` returns the OpenAI shape verbatim plus a `meterpal` block with what the call cost. `@meterpal/sdk` (TypeScript) and `meterpal` (Python) ship an OpenAI-shaped client, typed errors, and the `init` CLI. |
| **P4 — Gateway hardening** | The price sheet is the gateway's allow-list; key aliases are re-minted instead of failing forever; the subscription switch completes the whole PayPal loop against the sandbox. |
| **PayPal subscription switch** | Real PayPal subscription on the merchant's plan → buyer approves → browser returns → plan attached with its allowance. PayPal is the authority for subscription state; the DB flag is no longer trusted. Repeat clicks reuse the pending approval instead of minting an orphan subscription. |
| **Docs, demo and packaging** | The mock-LLM demo and bootstrap, the demo app, the agent demos, and this documentation set. |

Two findings worth calling out, because they are the kind of thing only a real
sandbox integration surfaces:

- **PayPal redirects with the express-checkout token of the order it created for
  the approval — not the BA token from the approval link.** The return route now
  carries a MeterPal-minted checkout token and resolves the subscription through
  it, with a payer-match fallback for links created earlier.
- **A drizzle column-name mismatch** (`customers.litellm_virtual_key`,
  `bridge_audit_log.customer_id`) meant no customer ever received a virtual key.
  The camelCase properties were silently `undefined`.

The full record, with file-level detail, is in [`CHANGELOG.md`](CHANGELOG.md).

---

## Repository layout

| Path | What it is |
|---|---|
| `billing/` | MeterPal billing server + merchant dashboard — Apache-2.0 fork of [Autumn](https://github.com/useautumn/autumn) (upstream went private 9/2026) with the PayPal rail built on top |
| `gateway/` | Metered AI gateway — MIT fork of [LiteLLM](https://github.com/BerriAI/litellm) with the MeterPal usage-billing hook (no core files modified) |
| `sdk/typescript/` | `@meterpal/sdk` — OpenAI-shaped inference client, React billing components, and the `meterpal init` CLI |
| `sdk/python/` | `meterpal` — Python client + LiteLLM hook re-export |
| `agent/` | MCP server + merchant/buyer demo agents |
| `demo-app/` | The demo chat app whose AI usage is billed live |
| `demo/` | Mock LLM provider, bootstrap seeding, scripted billing-loop walkthrough |
| `docs/` | Design research and the fork lineage; `docs/architecture.md` is the product design, `docs/DEPLOY.md` is the PayPal-native deployment guide |

---

## Guarantees

1. **No overspend** — every request is pre-authorized against a hot wallet
   counter decremented atomically (Redis Lua) before the upstream call.
2. **Instant access after payment** — the wallet is filled by PayPal webhooks,
   not nightly batches.
3. **No double-billing** — metering events are idempotent on the gateway call
   id; webhook grants are idempotent on the capture/sale/invoice id.
4. **No cross-tenant charge** — the virtual key carries the tenant, so a
   caller-controlled `user` header cannot redirect a charge, and an admin key
   without a tenant is refused rather than billed to a guess.

---

## License

Apache-2.0 (see `LICENSE` and `NOTICE` for the Autumn and LiteLLM fork
attributions).
