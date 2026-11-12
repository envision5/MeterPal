# MeterPal

### Your own OpenRouter-style stack — serving **and** billing AI — without the hassle.

**MeterPal is a plug-and-play, self-hostable billing stack for AI inference.** Drop it
in front of any app or service and it meters every AI call per end user (tokens →
cost → credits), debits a prepaid wallet with atomic admission control, and moves
every dollar through **PayPal** — natively, out of the box.

A call that a customer can't afford is refused with **HTTP 402 before the model
provider is ever touched**. No surprise invoices, no reconciliation spreadsheets,
no "we'll meter it later".

Built natively on PayPal for the [**PayPal AI Hackathon 2026**](https://paypalaihackathon.devpost.com/).

```bash
git clone <this repo> && cd meterpal
# ~5 minutes to a metered AI call, with no accounts, keys, or cloud services.
# Full verified sequence: Quickstart below.
```

---

## Why this exists

Anyone can call an LLM. Charging for it is the hard part.

If you serve AI to other people you eventually need all of this, and none of it
comes with the model:

- **Per-token cost attribution** — whose tokens, at what price, at what markup
- **A prepaid balance** with admission control, so you never serve a request you
  can't bill
- **A payments rail** — checkout, subscriptions, overage, refunds
- **A ledger** that survives concurrency, retries, and duplicate webhooks

Most teams build a homegrown version of this, badly, twice. **OpenRouter proved the
model works** — a unified inference endpoint with metered billing on top — but
their stack is theirs. MeterPal is the same idea, packaged so you can run it
yourself: bring your own models, your own prices, your own PayPal account.

PayPal's **Usage Based Billing API v1** records usage events, settles them against a
prepaid wallet, and issues credit notes — but it does not meter AI inference.
MeterPal is the layer that turns tokens into money.

---

## What's in the box

Everything below ships in this repo and runs locally with **no PayPal account, no
provider API key, and no cloud services** — the demo uses a bundled mock LLM.

| Capability | What it does |
| --- | --- |
| **Metered gateway** | OpenAI-compatible `/v1/chat/completions` that pre-authorizes, serves, meters tokens, and debits credits — idempotently |
| **Prepaid wallet ledger** | Atomic Redis admission control; reservations that settle or release; no overspend under concurrency |
| **402 paywall** | Typed `InsufficientBalanceError` carrying `balance` and `requiredCredits`, plus `error.topUp()` returning a live PayPal checkout URL |
| **Multi-tenant PayPal** | Each merchant's own PayPal credentials, encrypted at rest, tokens cached per org; webhooks verified against *that* org's webhook id |
| **Four PayPal rails** | Orders v2 (credit packs), Subscriptions (plans), Invoicing (overage), webhooks (instant entitlement) |
| **Merchant price sheet** | `served_models` is per-org: what you charge is your decision, pinned at `/check` and used verbatim at settle |
| **Merchant dashboard** | Wallet, usage, catalog and PayPal integration panel |
| **Usage Studio** | Embedded AG Grid AG Studio surface — its multi-agent assistant is itself billed to the customer's wallet |
| **Two SDKs + a CLI** | `@meterpal/sdk` (TypeScript) and `meterpal` (Python), OpenAI-shaped, with `meterpal init` that writes the integration for your framework |
| **MCP server** | Lets any AI agent run the commercial loop — including buying its own credits when it runs out |

---

## Architecture

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

**The path of one request:** the app calls `/v1/chat/completions` with the end user's
id → the gateway asks `/check` for admission → the billing server atomically
decrements a hot wallet counter in Redis → refused with 402 if it can't cover the
call → otherwise the provider is called, tokens are metered at the org's pinned
rates, and `/track_tokens` settles the difference. The ledger is the source of
truth; the wallet is refilled by PayPal webhooks the moment money lands.

---

## Quickstart — ~5 minutes from clone to a metered AI call

You do not need a PayPal account, a provider key, or any setup to see the paywall
work. The bundled demo runs the whole loop against a mock LLM.

> **First time here? Start with [`docs/FIRST-RUN.md`](docs/FIRST-RUN.md).**
> It walks the same steps in the order that actually works, plus the parts this
> block leaves out: the merchant dashboard (:3000), the storefront demo app
> (:5173), and what the first sign-in does. The block below is the condensed CLI
> version of the same path.

**What you're running:** this repo is the full product source — billing server,
metered gateway, dashboard — cloned here for evaluation. The merchant journey in
production is shorter: sign up, install the SDK, swap one import. Merchants never
run the gateway (`docs/architecture.md` §1); running it here is how you see inside
it.

**Prerequisites:** Docker, [Bun](https://bun.sh), Python 3.11+, and
`pip install httpx fastapi uvicorn`. Commands are Git Bash / macOS / Linux syntax;
verified end-to-end on Windows (Git Bash) — other shells need their usual
`export`/`source` equivalents and should otherwise work as-is.

```bash
git clone <this repo> && cd meterpal

# 1. infrastructure (2× Postgres + 2× Redis)
docker compose up -d

# 2. config — every example is pre-filled for localhost, nothing to edit
cp billing/server/.env.example billing/server/.env
cp gateway/.env.example        gateway/.env
cp billing/vite/.env.example   billing/vite/.env

# 3. schema. A fresh database has NO tables (pg-init only installs pg_trgm),
#    so every insert below fails until this runs.
( cd billing && AUTUMN_DB_DIRECT=1 bun scripts/db/index.ts migrate --bootstrap )
#    AUTUMN_DB_DIRECT=1 keeps the script from spawning Infisical for secrets;
#    it reads DATABASE_URL from billing/server/.env, so no export is needed.
#    `python demo/bootstrap.py --migrate` does the same thing.

# 4. billing server (:8080) + the two mocks
python demo/mock_llm.py &
python demo/mock_cloud.py &
( cd billing && bun install && cd server && bun src/index.ts ) &
#    the server takes ~2 minutes to bind — wait for the port before seeding:
until (echo > /dev/tcp/127.0.0.1/8080) 2>/dev/null; do sleep 5; done

# 5. seed the org and bind the stack — must come after :8080 is up, and before
#    the gateway and the demo app, which read the key this writes at boot
python demo/bootstrap.py --admin you@example.com   # --admin: your dashboard login

# 6. gateway (:4000) + the scripted walkthrough
( cd gateway && set -a && source .env && set +a && pip install -e . \
    && litellm --config config.yaml --port 4000 ) &
until (echo > /dev/tcp/127.0.0.1/4000) 2>/dev/null; do sleep 5; done
python demo/run_demo.py

# 7. dashboard (:3000) and storefront demo app (:5173)
( cd billing/vite && bun run dev ) &
( cd demo-app && bun install && bun run dev ) &
```

**Expected:** bootstrap seeds the stack (every step ✓) and binds the demo app to
the org it just created; `run_demo.py` meters calls 1–8 at exactly $0.36 each,
**refuses call 9 with HTTP 402 before the provider is touched**, a top-up re-admits
the customer, and every call lands in the events ledger with token pools, base
cost, markup and final credits. Sign in at http://localhost:3000 with the
`--admin` address to see the same ledger in the dashboard. Full walkthroughs:
[`docs/FIRST-RUN.md`](docs/FIRST-RUN.md) for the merchant path,
[`demo/README.md`](demo/README.md) for the CLI one.

The demo app (step 7) shows the same loop in the browser — metered chat, the
paywall firing on 402 — against the mock stack. Buying credits through it creates
a real PayPal order, so that beat follows
[With PayPal sandbox keys](#with-paypal-sandbox-keys).

> **Judges: what to look at** — four files carry the work:
> [`gateway/litellm/integrations/meterpal_billing.py`](gateway/litellm/integrations/meterpal_billing.py)
> (the metering hook: admission, reservation, settle, hold release),
> [`billing/server/src/external/paypal/webhookSecurity.ts`](billing/server/src/external/paypal/webhookSecurity.ts)
> (signature-verified, idempotent webhooks),
> [`billing/server/src/internal/balances/track/utils/pinnedRatesStore.ts`](billing/server/src/internal/balances/track/utils/pinnedRatesStore.ts)
> (server-owned price pinning), and
> [`demo/run_demo.py`](demo/run_demo.py) (the scripted 402 → top-up → resume story).
>
> **To evaluate the SDKs specifically**, follow
> [`docs/JUDGE-TESTING.md`](docs/JUDGE-TESTING.md): it installs both SDKs the way a
> merchant would, runs the live checks, and asserts the paywall — ten checks in
> TypeScript, the same ten in Python, both exiting non-zero on failure.

With real money, follow [With PayPal sandbox keys](#with-paypal-sandbox-keys).

---

## Three ways to integrate

The point of MeterPal is that a developer should not have to work out how to wire a
payments rail into their app.

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
# from your app, with the SDK installed from this repo
bun add file:../meterpal/sdk/typescript
bunx meterpal init                      # add --api-url http://localhost:8080 for this stack
```

`init` detects the framework (Next, Express, Hono, Fastify, plain Node), writes the
environment and a server-side handler that keeps the secret key off the browser,
and prints the snippet to start from. It is deterministic: it does not guess, it
installs a known-good integration for the framework it found. The SDK is not on npm
yet, so it comes from this repo — `dist/` is committed, so nothing needs building
first. `bunx meterpal init --help` lists every flag.

**3. MCP — let your coding agent do it.**

The MCP server (`agent/mcp/server.ts`) exposes the merchant operations
(`meterpal_get_customer`, `meterpal_get_customer_usage`,
`meterpal_list_low_balance_customers`, `meterpal_grant_credits`,
`meterpal_create_overage_invoice`, `meterpal_create_checkout_link`) to any MCP
client. Compose it with PayPal's own remote MCP server (`mcp.paypal.com/sse`) for
native PayPal operations.

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

Then either register the webhook by hand (point it at `<public-url>/webhooks/paypal`)
or let the bootstrap do it through a tunnel:

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_WEBHOOK_URL=https://<tunnel>/webhooks/paypal \
  python demo/bootstrap.py
```

`bootstrap.py` writes the resulting `PAYPAL_WEBHOOK_ID` back into
`billing/server/.env` and the dashboard's PayPal panel shows it as **Registered**.
PayPal cannot reach `localhost`, so on a laptop without a tunnel that row stays
**Not registered** — and credits still land, because the demo app captures approved
orders on a poll instead. Say which one you are demonstrating: a localhost run is
the poll, not the webhook.

Buy credits in the demo app with a sandbox buyer account and watch the wallet credit
on capture.

**Approval is manual on purpose.** PayPal is the one place a human has to click:
the buyer agent can size a pack, open a checkout and hand it to you, but it cannot
approve it. That is the safety property the money loop is built around — an agent
that could approve its own payment is an agent that can spend without you.

There are two ways through the sandbox approval screen, and this repo only
guarantees one of them:

- **Pay with Card** (no account needed) — the tab PayPal opens on first. The sandbox
  accepts `4111 1111 1111 1111`, expiry `12/30`, CVV `123`, any name and billing
  address. The paywall card prints this hint when no buyer account is configured,
  because it is the path a judge will actually take.
- **A sandbox personal account**, if you created one. Name it and the paywall card
  will tell the viewer to approve as that account instead:

```bash
# demo-app/.env.local (or the shell) — shown on the paywall card
DEMO_PAYPAL_BUYER=sb-buyer@personal.example.com
```

Neither is a MeterPal credential. The agent holds no buyer credentials at all,
which is why it cannot approve a payment even if it wanted to.

**What can charge without a fresh click, and why it is not the agent.** The one
merchant-initiated charge in the codebase is PayPal auto top-up
(`internal/balances/autoTopUp/paypal/paypalAutoTopup.ts`): a reference transaction
against a vaulted `BA-` billing agreement. That agreement is stamped only when a
**buyer approves a subscription** — `stampPaypalBillingAgreement` runs on
activation, never at checkout — so the standing authorisation is itself a human
approval. Nothing in this repo mints one, no demo customer has one
(`paypal_billing_agreement_id` is null on every row), and the buyer agent never
touches the path. In the demo as shipped, every credit that lands came from someone
clicking Approve.

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

## API surface

The merchant-facing REST API. Every endpoint is namespaced under `/v1` except the
PayPal webhook receiver.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/check` | Pre-authorize a call — returns 402 when the wallet can't cover it |
| `POST` | `/v1/track_tokens` | Meter usage and settle against the reservation |
| `POST` | `/v1/chat/completions` | OpenAI-compatible metered inference; adds a `meterpal` cost block |
| `POST` | `/v1/attach` | Attach a payment method / billing agreement to a customer |
| `POST` | `/v1/balances/update` | Adjust a balance (grants, refunds) |
| `POST` | `/v1/balances/finalize` | Finalize a metering window |
| `GET` | `/v1/catalog` | Plans, credit packs and features for the org |
| `GET` | `/v1/customers/{id}` | Customer record with balance and usage |
| `GET` | `/features/ai/model_pricing` | The org's pinned price sheet |
| `POST` | `/v1/key/generate` | Provision a virtual key (tenant carried in the key) |
| `POST` | `/v1/key/update` · `/v1/key/block` | Re-mint or revoke a virtual key |
| `GET` | `/v1/keys` | List virtual keys |
| `POST` | `/v1/organization/paypal` | Store and verify the org's PayPal credentials |
| `DELETE` | `/v1/org/paypal` | Detach the org's PayPal account |
| `POST` | `/paypal/capture` | Capture an approved order and credit the wallet |
| `GET` | `/paypal/poll` | Poll an approval when webhooks can't reach localhost |
| `POST` | `/webhooks/paypal/{org_id}/{webhook_id}` | Signature-verified, idempotent PayPal webhook |
| `GET` | `/ready` | Readiness probe |

A machine-readable OpenAPI definition and a hosted API reference are generated with
APIMatic — see [Tools used](#tools-used).

---

## Tools used

The hackathon requires that both PayPal and AI be meaningful, and that the tools be
disclosed. Everything below is load-bearing in the demo path.

### PayPal (the money rail)

| PayPal capability | How MeterPal uses it |
| --- | --- |
| **Orders v2** | Credit packs — create order, capture, credit the wallet |
| **Subscriptions** | Plans with allowances; activation stamps the billing agreement |
| **Invoicing** | Overage invoicing from the merchant agent |
| **Webhooks** | Signature-verified, idempotent entitlement grants on capture/sale/invoice |
| **Usage Based Billing v1** | Records usage events and issues credit notes |
| **PayPal MCP server** | Composed with MeterPal's MCP server so agents can reach native PayPal ops |

All PayPal work runs against the **sandbox**. No live credentials ship in this repo.

### AI

| Tool | How MeterPal uses it |
| --- | --- |
| **LiteLLM** | The metered gateway — provider-agnostic; MeterPal adds one self-contained usage-billing hook, modifying no core files |
| **Bundled mock LLM** | Deterministic offline provider so judges can run the full loop with no keys |
| **MCP** | MeterPal exposes merchant operations as MCP tools; agents drive the commercial loop |
| **AG Grid AG Studio** | The Usage Studio dashboard surface; its multi-agent assistant is itself metered and billed |
| **Anthropic / OpenAI / Gemini / Groq** | Supported upstream providers via the gateway, configured by key in `gateway/.env` |

### Supporting

| Tool | Use |
| --- | --- |
| **APIMatic** | API documentation generated from MeterPal's OpenAPI definition |
| **Postgres + Redis** | Ledger of record and atomic admission counters |
| **Bun / TypeScript / Hono / Drizzle** | Billing server, dashboard, SDK |
| **Python / FastAPI** | Demo harness, mocks, agents |

---

## What was built during this hackathon (2026-10-01 → 2026-11-12)

MeterPal existed before this hackathon as a **fork point**: a wallet-and-metering
core, a first PayPal webhook adapter, and a LiteLLM usage bridge, committed on
**2026-09-30** as `0.1.0-baseline` so that everything after it is visible in git
history. Everything below is new work performed inside the submission window, in the
order of the architecture plan in [`docs/architecture.md`](docs/architecture.md):

| Phase | What shipped |
|---|---|
| **P0 — Live metering** | The gateway actually bills again: config in the environment, a shared `PAB_TRUST_SECRET`, the tenant carried in the key itself, per-customer and per-org rpm/tpm ceilings, and `scripts/verify-tenant-isolation.ps1` asserting a spoofed customer header, an admin key, an off-sheet model and an unknown key are all refused. |
| **P1 — Multi-tenant PayPal** | A merchant's PayPal account is theirs, not the platform's. Every call goes through a client built from the org's own row, secret encrypted at rest, token cached per org. Webhooks move to `POST /webhooks/paypal/:orgId/:webhookId` so the signature is verified against *that* org's webhook id. The dashboard gets a PayPal integration panel that verifies credentials before storing them. |
| **P2 — The merchant's price sheet** | `served_models` is the per-org price sheet: what a merchant charges is the merchant's decision, so a provider price change cannot move it. `/check` pins the unit rates and the settle uses them verbatim. Verified: a call at 20/80 cost 0.36; after setting 60/100 in the dashboard the same call cost 1.76. |
| **P3 — The inference proxy and the SDK** | `POST /v1/chat/completions` returns the OpenAI shape verbatim plus a `meterpal` block with what the call cost. `@meterpal/sdk` (TypeScript) and `meterpal` (Python) ship an OpenAI-shaped client, typed errors, and the `init` CLI. |
| **P4 — Gateway hardening** | The price sheet is the gateway's allow-list; key aliases are re-minted instead of failing forever; the subscription switch completes the whole PayPal loop against the sandbox. |
| **Usage Studio (AG Grid AG Studio)** | The merchant's usage dashboard, rebuilt as an embedded AG Grid AG Studio surface (`ag-studio-react@3.1.0` on `ag-grid-react/enterprise/stack`). Its assistant is AG Studio's own multi-agent framework, wired to MeterPal's metered endpoint: ask it for a chart and it reads the page, delegates to the page and widget agents, places the widget and maps it to the usage table — and every one of those turns is billed to the customer's wallet, with the cost of the last turn shown on screen. The read path falls back to Postgres when Tinybird is not configured, so the whole surface runs locally with no cloud dependency. |
| **PayPal subscription switch** | Real PayPal subscription on the merchant's plan → buyer approves → browser returns → plan attached with its allowance. PayPal is the authority for subscription state; the DB flag is no longer trusted. Repeat clicks reuse the pending approval instead of minting an orphan subscription. |
| **Docs, demo and packaging** | The mock-LLM demo and bootstrap, the demo app, the agent demos, and this documentation set. |

Two findings worth calling out, because they are the kind of thing only a real
sandbox integration surfaces:

- **PayPal redirects with the express-checkout token of the order it created for the
  approval — not the BA token from the approval link.** The return route now carries
  a MeterPal-minted checkout token and resolves the subscription through it, with a
  payer-match fallback for links created earlier.
- **A drizzle column-name mismatch** (`customers.litellm_virtual_key`,
  `bridge_audit_log.customer_id`) meant no customer ever received a virtual key. The
  camelCase properties were silently `undefined`.

The full record, with file-level detail, is in [`CHANGELOG.md`](CHANGELOG.md).

---

## Repository layout

| Path | What it is |
|---|---|
| `billing/` | MeterPal billing server + merchant dashboard — Apache-2.0 fork of [Autumn](https://github.com/useautumn/autumn) (upstream went private 9/2026) with the PayPal rail built on top |
| `gateway/` | Metered AI gateway — MIT fork of [LiteLLM](https://github.com/BerriAI/litellm) with the MeterPal usage-billing hook (no core files modified). LiteLLM's proprietary `enterprise/` package is not distributed here — see [`NOTICE`](NOTICE) |
| `sdk/typescript/` | `@meterpal/sdk` — OpenAI-shaped inference client, React billing components, and the `meterpal init` CLI |
| `sdk/python/` | `meterpal` — Python client + LiteLLM hook re-export |
| `agent/` | MCP server + merchant/buyer demo agents |
| `demo-app/` | The demo chat app whose AI usage is billed live |
| `demo/` | Mock LLM provider (which also plays the AG Studio agent offline), bootstrap seeding, scripted billing-loop walkthrough |
| `docs/` | Design research and the fork lineage; `docs/architecture.md` is the product design, `docs/DEPLOY.md` is the run-the-stack-yourself guide, `docs/JUDGE-TESTING.md` is the install-and-verify path for both SDKs, `docs/scaling-and-concurrency.md` is the concurrency-correctness reference |
| `LICENSES/` | Full text of the upstream Apache-2.0 and MIT licenses |

---

## Guarantees

1. **No overspend** — every request is pre-authorized against a hot wallet counter
   decremented atomically (Redis Lua) before the upstream call.
2. **Instant access after payment** — the wallet is filled by PayPal webhooks, not
   nightly batches.
3. **No double-billing** — metering events are idempotent on the gateway call id;
   webhook grants are idempotent on the capture/sale/invoice id.
4. **No cross-tenant charge** — the virtual key carries the tenant, so a
   caller-controlled `user` header cannot redirect a charge, and an admin key without
   a tenant is refused rather than billed to a guess.

---

## Documentation

| Doc | What's in it |
| --- | --- |
| [`docs/FIRST-RUN.md`](docs/FIRST-RUN.md) | The merchant path, start to finish |
| [`docs/JUDGE-TESTING.md`](docs/JUDGE-TESTING.md) | Install and verify both SDKs like a merchant would |
| [`docs/architecture.md`](docs/architecture.md) | Product design and the reasoning behind it |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Running the stack yourself |
| [`docs/scaling-and-concurrency.md`](docs/scaling-and-concurrency.md) | Concurrency correctness of the ledger |
| [`docs/SECURITY-ASSESSMENT.md`](docs/SECURITY-ASSESSMENT.md) | Security posture and threat notes |
| [`CHANGELOG.md`](CHANGELOG.md) | File-level record of hackathon work |

---

## Hackathon submission

- **Event:** [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/)
- **Category:** open — built to the "meaningfully use both PayPal and AI" requirement
- **Demo video:** <!-- TODO: replace with the public YouTube URL before submitting -->
- **Live demo:** runs locally, free, with no credentials — see [Quickstart](#quickstart--5-minutes-from-clone-to-a-metered-ai-call)

Judges can run the entire loop with zero external accounts: `docker compose up -d`,
then `python demo/bootstrap.py && python demo/run_demo.py`. The bundled mock LLM
stands in for a provider, and the 402 → top-up → resume story plays out against it.
PayPal sandbox keys are only needed for the checkout beat.

---

## License

MeterPal-authored code is licensed under the **GNU Affero General Public License,
Version 3** — see [`LICENSE`](LICENSE).

Commercial licensing is available for teams that need to use MeterPal in
closed-source products or hosted services without the AGPL's source-disclosure
obligation — see [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).

This repository vendors two third-party codebases, which keep their own licenses and
are **not** relicensed by MeterPal:

| Component | Origin | License |
| --- | --- | --- |
| `billing/` | [Autumn](https://github.com/useautumn/autumn) fork | Apache-2.0 — [`billing/LICENSE`](billing/LICENSE) |
| `gateway/` | [LiteLLM](https://github.com/BerriAI/litellm) fork | MIT — [`gateway/LICENSE`](gateway/LICENSE) |

Upstream LiteLLM's `enterprise/` package is proprietary (paid seats) and is **not
distributed** in this repository. Full attribution is in [`NOTICE`](NOTICE).
