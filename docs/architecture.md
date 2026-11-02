# MeterPal — Plug-and-Play AI Inference & Usage Billing

**Status:** design spec, 2026-11-02.
**Scope:** the merchant-facing product. The billing core, the Autumn↔LiteLLM contract and the
end-user billing UI are already specified in `docs/plan.md`, `docs/bridge.md` and
`docs/customer-ui.md`. This document covers what those three do **not**: how a merchant goes from
"sign up" to "serving metered AI inference" with no infrastructure of their own.

---

## 0. Decisions locked in

| Decision | Choice | Consequence for the rest of this document |
| --- | --- | --- |
| Order of work | Architecture spec first | This document. No code until it is agreed. |
| Who runs the inference gateway | **MeterPal hosts a shared, multi-tenant gateway** and holds the model provider keys | Merchants never install LiteLLM. §4.3 |
| The merchant's "one import" | **An OpenAI-compatible inference client** | `meterpal.chat.completions.create` — swap one import, billing is automatic. §4.4 |

---

## 1. The merchant journey

The product promise: **a merchant can go from signup to serving metered AI inference in under ten
minutes, running no infrastructure.**

1. **Sign up** → an org exists in the MeterPal dashboard (`billing/vite`, port 3000).
2. **Connect PayPal** → paste the PayPal REST app client id + secret. Stored per org, encrypted.
   Verified immediately by exchanging them for an access token and showing the connected account
   email. This is the only credential the merchant supplies.
3. **Choose what they sell** → plans with a monthly credit allowance (e.g. "Pro — 100 credits/mo,
   $20"). Creating a plan **creates the matching PayPal product + plan** and records the mapping.
4. **Choose which models to serve and set their costs** → pick from the model catalog; each model
   gets an input/output price per 1M tokens (defaulted to models.dev list price) and a markup.
5. **Install** → `npm i @meterpal/sdk` then `npx @meterpal/sdk init`. The CLI writes the env file,
   generates the server-side handler for the detected framework, and prints the one-line snippet.
6. **Serve** → replace `openai` with `meterpal`. Every call is admitted, metered and charged. When
   the balance runs out the call returns `402` and the SDK raises a typed
   `InsufficientBalanceError` carrying a `topUp()` helper that opens a PayPal checkout.

Steps 2–4 are the dashboard. Steps 5–6 are the SDK. Everything else is plumbing the merchant never
sees.

---

## 2. Topology

Four planes. The merchant touches two of them (the dashboard and the SDK).

| Plane | Component | Repo | Runs where | Merchant's concern |
| --- | --- | --- | --- | --- |
| Control | Merchant dashboard | `billing/vite` | MeterPal-hosted | Where they configure everything |
| Control | Billing server (wallet, ledger, catalog, PayPal) | `billing/server` | MeterPal-hosted | — |
| Data | Shared gateway (admission + metering) | `gateway` (LiteLLM fork) | MeterPal-hosted | — |
| Edge | `@meterpal/sdk` (TS) / `meterpal` (py) | `sdk/typescript`, `sdk/python` | **Their app** | The one import |

The merchant's app contains exactly two things: a server-side handler holding the MeterPal secret
key, and a client that sends inference calls. The merchant's *users* interact with the merchant's
app; MeterPal is never in their UI unless they embed the billing components.

---

## 3. Where the code falls short today

| # | Gap | Evidence in the repo | Becomes |
| --- | --- | --- | --- |
| 1 | **PayPal is single-tenant.** One PayPal account for the whole server. | `billing/server/src/external/paypal/client.ts` reads `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` from `process.env`; one module-level `cache: TokenCache` for all callers. `isPaypalConfigured()` (`internal/billing/paypal/runPaypalCheckout.ts:52`) is process-level, and `isPaypalNativeOrg(ctx)` (`:60`) is `isPaypalConfigured() && !isStripeConnected(...)` — it takes a `ctx` and ignores it. | §4.1 |
| 2 | **Models and costs live in a YAML file.** No merchant-facing model configuration exists. | `gateway/config.yaml` `model_list` hardcodes `model_name → provider → os.environ/OPENAI_API_KEY_A`. Costs are resolved from models.dev (`internal/features/utils/getModelPricing.ts`) with plan-level overrides in `features.model_markups`. The alias→billable-id bridge is `PAB_MODEL_ID_MAP` in `gateway/.env`. | §4.2 |
| 3 | **The SDK is a billing-UI SDK, not an inference SDK.** | `sdk/typescript/src/index.ts` exports React components + `createMeterPalClient`. The client is a thin `createAutumnClient` wrapper (`sdk/typescript/src/client.ts`) that requires the host to wrap the tree in `<AutumnProvider>` *and* mount `autumn-js/backend` routes server-side. | §4.4, §4.5 |
| 4 | **No install/provision step.** | Nothing in the repo writes config or provisions an app. `demo-app/server.ts` shows the manual wiring (4 route mounts + 2 env vars) that a merchant would have to copy. | §4.5 |
| 5 | **The metering bridge is disabled in the running stack.** | The local LiteLLM logs `MeterPalBridge: PAB_API_KEY missing -- bridge disabled`. `gateway/.env` *does* define `PAB_API_KEY`; the process was launched without that file in its environment. **Real inference calls are not metered today** — the demo's usage rows are seeded by `demo/bootstrap.py`. | P0 in §6 |
| 6 | **No model allow-list or per-tenant routing in the gateway.** | `gateway/litellm/integrations/meterpal_billing.py` reads the customer from `PAB_CUSTOMER_HEADER` (default `user`) and calls `POST /check`, `POST /balances.finalize`, `POST /track_tokens`. Nothing resolves a tenant from the credential. | §4.3 |

Everything else the vision needs already exists: the PayPal subscription lifecycle (§8), the
reservation pattern and concurrency primitives (`docs/plan.md` §4–5), the Autumn↔LiteLLM contract
(`docs/bridge.md`), the customer-facing billing components (`docs/customer-ui.md`), and Autumn's
per-org Stripe model, which is the pattern to copy for PayPal.

---

## 4. Design

### 4.1 Multi-tenant PayPal

Autumn already solved multi-tenant payments for Stripe. Mirror it.

**Storage.** Add to `orgs` (table definition: `billing/shared/models/orgModels/orgTable.ts`):

```
paypal_connected : boolean  default false
paypal_config    : jsonb    -- { client_id, client_secret_enc, env, webhook_id,
                               account_email, connected_at }
```

`stripe_config` and `processor_configs` on the same table are the precedent. Encrypt
`client_secret` with the repo's existing `encryptData()` (`ENCRYPTION_PASSWORD` / `ENCRYPTION_IV`
in `billing/server/.env`) — the same helper used for the Stripe Connect connection string.

**Client.** Replace the module-global in `external/paypal/client.ts` with a per-org client:

```ts
// external/paypal/paypalClient.ts
export async function getPaypalClient({ org, env }: { org: Organization; env: AppEnv }): Promise<PaypalClient>
```

- Access tokens are cached **per `org_id:env`** in Redis, not in process memory: the billing server
  must be horizontally scalable, and a process-level cache is also a cross-tenant leak vector.
- The Redis key mirrors the existing cache-key style (`{demo-customer}:org_demo:sandbox:full_subject`).
- Token refresh keeps the current 5-minute early-refresh margin and the 401-retry path.

**Call sites.** Every one of these currently imports the global `paypalFetch` and must take a
client instead:

- `internal/billing/paypal/runPaypalCheckout.ts` (create / revise / cancel / get subscription)
- `internal/billing/paypal/paypalReturnRouter.ts` (browser return)
- `external/paypal/runPaypalWebhookHandlers.ts` (activation)
- `external/paypal/subscriptions.ts`, `orders.ts`, `invoicing.ts`

`isPaypalConfigured()` becomes `isPaypalConnected({ org, env })` and `isPaypalNativeOrg(ctx)`
becomes `isPaypalConnected({org, env}) && !isStripeConnected({ org, env })`. The "PayPal-native"
branch in `internal/billing/v2/actions/attach/attach.ts:109` and in
`internal/billing/checkout/runCheckout.ts:57` then become genuinely per-org.

**Webhooks.** `PAYPAL_WEBHOOK_ID` is currently a single env var. Per org, each merchant registers
their own webhook. Use a URL that carries the org:

```
POST /webhooks/paypal/{org_id}/{webhook_id}
```

The handler resolves the org from the path, then verifies the signature against **that org's**
webhook id (`external/paypal/webhookSecurity.ts` already does the crypto verification — it just
needs the per-org id). Idempotency mirrors `stripe_webhook_events`: a new
`paypal_webhook_events` table keyed by PayPal's event id.

**Catalog mapping.** `paypal_catalog_map` is already org-scoped (`org_id`, `env`,
`product_id`, `paypal_product_id`, `paypal_plan_id`, `amount_usd`) — no change needed.

**Dashboard.** New `views/developer/configure-paypal/ConfigurePayPal.tsx` and
`views/settings/sections/PayPalSection.tsx`, modelled directly on
`views/developer/configure-stripe/ConfigureStripe.tsx` and
`views/settings/sections/StripeSection.tsx`. It shows: connection state, the connected PayPal
account email, sandbox/live mode, the registered webhook URL (copyable), and a "verify" button.

**Back-compat.** If `paypal_config` is absent on the org, fall back to the env vars. The current
single-tenant deployment keeps working unchanged; the demo stack needs no migration.

### 4.2 Served models & cost catalog

**Data model.** Two new tables (org-scoped, env-scoped like the rest of the catalog):

```
served_models(
  id, org_id, env,
  model_id            text   -- "openai/gpt-4o"  (the billable id the bridge prices)
  display_name        text,
  upstream_model      text   -- the LiteLLM deployment name
  enabled             boolean default true,
  input_cost_usd_1m   numeric,
  output_cost_usd_1m  numeric,
  markup_pct          numeric default 0,
  created_at, updated_at
)
```

`model_id` is the exact `<provider>/<model>` string the bridge already prices by
(`meterpal_billing.py`, "exact `<provider>/<model>` lookup against models.dev, or
`custom/<name>`"). Default costs are seeded from models.dev at connect time; the merchant's edits
are stored per org and win over the live feed.

**Pricing resolution.** Two prices, not one:

- **base cost** = `served_models.input_cost_usd_1m` (merchant's price for the token)
- **plan multiplier** = `features.model_markups[model_id].markup` (already exists)

`internal/features/utils/getModelPricing.ts` currently resolves the *provider's* cost from
models.dev. It becomes the **seed source**, not the runtime authority: at request time the price
comes from `served_models` (plus the feature markup), so a models.dev change cannot silently move
a merchant's prices.

**Price pinning.** The reserve and the settle must use the same price. The gateway already sends
the model id on `/check`; the reservation must carry the **unit price** it reserved at, and the
settle must use the pinned value. `docs/plan.md` §4 covers this pattern — it is the one place
where "live pricing" and "reserved pricing" must not diverge.

**Gateway consumption.** The gateway stops owning the model list in YAML. It polls
`GET /v1/catalog?served_models=1` from the billing server (Redis-cached, short TTL, e.g. 30s),
building its LiteLLM `model_list` dynamically, with the static YAML as a fallback when the billing
server is unreachable. `PAB_MODEL_ID_MAP` becomes unnecessary: the id the gateway serves *is* the
billable id.

**Dashboard.** A "Served models" tab under `views/products/`: a searchable catalog (from models.dev
plus the models MeterPal operates), toggles for what to serve, inline-editable input/output price
and markup, a "sync list prices" button, and a margin preview.

### 4.3 The shared, multi-tenant gateway

MeterPal runs one LiteLLM deployment for all merchants. Four isolation requirements:

**1. The credential must identify the tenant.** Today the demo sends the LiteLLM **master key**
plus a `user:` header (`demo-app/server.ts:179`) — any merchant could bill any customer. Replace
it with a per-customer **virtual key**:

- `customers.litellm_virtual_key` already exists and is provisioned by
  `internal/keys/litellmKeys.ts` ✓
- the key's LiteLLM `user_id` must carry **both** org and customer, e.g. `org_demo:demo-customer-2`
- the gateway resolves `virtual key → (org, customer)` **before** admission and never trusts a
  header for the customer id when the key carries one
- the master key stays inside MeterPal's infrastructure; merchant apps never see it

**2. Model allow-list per org.** The gateway serves only the models that org has enabled. LiteLLM
supports per-key `models`; the resolved org's `served_models` (enabled only) becomes that list.
An unknown model returns `404`, not a silent bill.

**3. Rate limits per org and per customer.** LiteLLM `rpm`/`tpm` per key, seeded from the org's
plan. A single merchant cannot exhaust the shared provider quota.

**4. Token cache must be shared.** Per-org PayPal tokens (§4.1) and the model catalog (§4.2) live
in Redis so multiple gateway/billing instances agree.

**Provider keys.** MeterPal holds `OPENAI_API_KEY_A/B/C` etc. and spreads load across them
(three `gpt-4o` deployments in `gateway/config.yaml` today). The merchant's margin is
`merchant price − provider cost`; both are visible in the dashboard.

**The bridge is the contract, and it stays.** `gateway/litellm/integrations/meterpal_billing.py`
already does admission (`/check` → `402` before any provider spend), commit/release
(`/balances.finalize`) and per-token debit (`/track_tokens`). The multi-tenant work is in *how the
gateway identifies the tenant*, not in the bridge's logic.

### 4.4 The SDK: an OpenAI-compatible inference client

New surface in `sdk/typescript` (and the Python equivalent):

```ts
import { createMeterPal } from "@meterpal/sdk";

const meterpal = createMeterPal({
  apiKey: process.env.METERPAL_SECRET_KEY!,   // server-side only
  baseURL: process.env.METERPAL_BASE_URL,     // default https://api.meterpal.dev
});

const completion = await meterpal.chat.completions.create({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "hi" }],
  user: "cus_123",          // the end user being billed
});
```

**Request.** `POST {baseURL}/v1/chat/completions`, `Authorization: Bearer <virtual key>` (the SDK
provisions it on first use and caches it server-side), `model` = a model id from the merchant's
served catalog. The end user id travels in `user` and is cross-checked against the key.

**Response.** The OpenAI response shape verbatim, plus a `meterpal` block:

```jsonc
{ "id": "...", "model": "openai/gpt-4o", "choices": [...],
  "usage": { "prompt_tokens": 12, "completion_tokens": 40, "total_tokens": 52 },
  "meterpal": { "credits_charged": 0.31, "balance_after": 99.69, "customer_id": "cus_123" } }
```

**Errors.** Typed, and each one carries the next action:

| HTTP | SDK error | Action |
| --- | --- | --- |
| 402 | `InsufficientBalanceError` | carries `topUp()` → opens the PayPal checkout; also `requiredCredits` |
| 401 | `AuthenticationError` | the secret key is wrong |
| 403 | `ModelNotEnabledError` | the model is not in this merchant's served catalog |
| 404 | `ModelNotFoundError` | unknown model |
| 429 | `RateLimitError` | the customer's plan limit |

A `402` is the **paywall**: it means the end user must pay more. That is the whole point of the
product, so it gets first-class SDK support rather than a raw HTTP error.

**Streaming.** SSE passthrough, with usage extracted from the final chunk.

**The React components stay.** `@meterpal/sdk` continues to export `PlanCard`, `TopUpModal`,
`CreditsBadge`, `UsageHistoryPanel`, `LowBalanceBanner`, `CostTooltip` and
`createMeterPalClient`. The inference client is additive — a merchant can use one, the other, or
both.

### 4.5 Install & provisioning

`npx @meterpal/sdk init` (also `bunx`, `pnpm dlx`, `yarn dlx`):

1. Detects the framework (Next.js route handler, Express, Hono, Fastify) from the dependencies.
2. Prompts for the MeterPal secret key — or prints a dashboard link that mints one.
3. Writes `.env` / `.env.local`: `METERPAL_SECRET_KEY`, `METERPAL_API_URL`, `METERPAL_BASE_URL`.
4. Generates the server-side handler. Today the merchant must wire `autumn-js/backend` themselves
   (`sdk/typescript/src/client.ts` documents this, and `demo-app/server.ts` shows a working Hono
   version). The CLI writes it, wired to the detected framework, with the secret key injected
   server-side and the end-user id resolved from the request.
5. Prints the `meterpal.chat.completions.create` snippet and the dashboard link to watch usage.

**It must not require infrastructure.** No Docker, no gateway to install, no database. The merchant
runs their existing app.

### 4.6 The onboarding wizard

In the dashboard, each step ends in a verifiable state:

| Step | Verify |
| --- | --- |
| 1. Connect PayPal | Exchange the credentials for a token; show the connected account email |
| 2. Create a plan | Auto-create the PayPal product + plan; show the PayPal plan id |
| 3. Choose models & costs | Show the served catalog and the effective price per 1M tokens |
| 4. Install | Copyable snippet + `npx @meterpal/sdk init` command, with the right secret key |
| 5. Smoke test | The dashboard fires one real inference call at the merchant's endpoint and shows the credits charged |

Step 5 is what makes it "plug and play": the merchant sees a real, metered, billed call before
writing any application code.

`views/onboarding4/` already contains an AI-assisted onboarding (chat + pricing preview + plan
cards) — the wizard should reuse that machinery rather than invent a second one.

### 4.7 Data model changes

| Change | Where |
| --- | --- |
| `orgs.paypal_connected`, `orgs.paypal_config` | new migration on `orgs` |
| `paypal_webhook_events` | new table (idempotency, mirrors `stripe_webhook_events`) |
| `served_models` | new table |
| `virtual_key` → org mapping | either a column on `customers` (`paypal_*` columns already sit there) or a new table |
| *(none)* `paypal_catalog_map` | already org-scoped |

### 4.8 API surface

**Billing server (merchant-facing, secret-key auth):**

```
GET    /v1/org/paypal              connect/disconnect state
POST   /v1/org/paypal              connect (client id, secret, env)
DELETE /v1/org/paypal              disconnect
GET    /v1/org/paypal/verify       re-verify credentials against PayPal
GET    /v1/catalog?served_models=1 served model catalog for the gateway
GET    /v1/served-models           CRUD for the merchant's served models
POST   /v1/served-models
PATCH  /v1/served-models/:id
POST   /v1/keys                    provision a customer virtual key (SDK-facing)
GET    /v1/keys/:id
```

**Gateway (MeterPal-hosted, virtual-key auth):**

```
POST /v1/chat/completions          OpenAI-compatible, metered
GET  /v1/models                    the caller's allowed models
```

**Webhook (PayPal → MeterPal):**

```
POST /webhooks/paypal/{org_id}/{webhook_id}
```

---

## 5. Tenant isolation & security

This is the highest-risk area, and the failure mode is silent: one merchant billing another.

- **Virtual keys only.** Merchant apps never hold the LiteLLM master key or any PayPal secret. A
  virtual key resolves to exactly one `(org, customer)`; the gateway refuses a key it cannot
  resolve rather than falling back to a header.
- **Model allow-list.** A model not enabled for the org is a `404`, not a charge.
- **Credential encryption.** PayPal secrets encrypted at rest with `encryptData()`; never logged,
  never returned by an API — only booleans and the account email.
- **Webhook verification per org.** The signature is verified against that org's webhook id, and
  the org is resolved from the URL before any state is read.
- **Rate limits** per org (protect MeterPal's provider quota) and per customer (protect the
  merchant from a runaway user).
- **No secret in the browser.** The SDK's server handler injects the secret key; the browser only
  ever sees the customer-scoped routes.
- **Audit.** Every config change (connect, disconnect, served model edit, price change) writes to
  the existing audit log with the acting user.

---

## 6. Phased rollout

Each phase is independently shippable and has an acceptance test you can run.

**P0 — Make the existing loop measurable.** *(~1 day)*
Start LiteLLM with `gateway/.env` loaded so the bridge is live; make the master-key drift
impossible (one source of truth for `LITELLM_MASTER_KEY`); run one real metered call and show the
credit debit.
*Accept:* a chat call through the gateway debits the wallet; `MeterPalBridge` logs no
"disabled" warning.

**P1 — Multi-tenant PayPal.** *(~1–2 weeks)*
Per-org `paypal_config` + encrypted storage; `getPaypalClient` with a Redis token cache; every
call site converted; `isPaypalConnected`/`isPaypalNativeOrg` become per-org; per-org webhook URLs
and `paypal_webhook_events`; the `ConfigurePayPal` dashboard section.
*Accept:* two orgs with different PayPal accounts run side by side in one billing server; a
subscription created for org A is invisible to org B; webhooks route to the right org.

**P2 — Served models & cost catalog.** *(~1–2 weeks)*
`served_models` table; dashboard tab with inline price editing; `GET /v1/catalog`; the gateway
builds its model list from the catalog with a YAML fallback; the reserve path pins the price.
*Accept:* a merchant edits a model's price; the next call charges the new price; the reserve and
the settle agree.

**P3 — The SDK surface.** *(~1–2 weeks)*
`createMeterPal` with `chat.completions.create`; typed errors; `402` → `InsufficientBalanceError`
with `topUp()`; streaming; the `init` CLI with framework detection and handler generation.
*Accept:* a fresh app does `npm i @meterpal/sdk && npx @meterpal/sdk init`, swaps `openai` for
`meterpal`, and gets a metered call with no other work.

**P4 — Hosted gateway hardening.** *(~1 week)*
Virtual-key ⇒ org resolution; per-org model allow-list; per-org and per-customer rate limits;
shared Redis caches; multi-instance token cache.
*Accept:* a key from org A cannot bill org B's customer; a model org A has not enabled 404s.

**P5 — Onboarding wizard + smoke test.** *(~1 week)*
The six-step wizard; the dashboard-fired smoke test; install snippets per framework.
*Accept:* a new merchant goes signup → metered call with no engineering help.

**P6 — Package and publish.** *(~1 week)*
Publish `@meterpal/sdk` and the Python package; `meterpal` CLI; hosted gateway endpoints;
`docs/DEPLOY.md` updated for the hosted topology.
*Accept:* `npm i @meterpal/sdk` works from the public registry.

---

## 7. Risks and open questions

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Tenant isolation** | A leaked master key lets one tenant bill another. Silent, and it is the end of the business. | Virtual keys only; per-org allow-lists; no master key in merchant apps; a CI test that asserts cross-org keys are rejected. |
| **Price drift** between reserve and settle | models.dev moves mid-flight; the customer is charged a different price than they were admitted at. | Pin the unit price on the reservation; the settle uses the pinned value. |
| **PayPal app review** per merchant | Live-mode merchants need their own PayPal app reviewed; that is a multi-day wait and out of our control. | Sandbox is instant and verifiable in the dashboard; live mode is a clearly-labelled separate step. One PayPal app owned by MeterPal with a **platform** arrangement is the alternative — needs legal/commercial input. |
| **PayPal webhook routing** | PayPal webhooks are per-app; with one app and many merchants there is no built-in tenant routing. | URL carries `{org_id}/{webhook_id}`; resolve org before reading state. |
| **LiteLLM fork drift** | The gateway is a fork; upstream releases are not authoritative for it. | Keep the fork thin — the bridge is one file (`meterpal_billing.py`); keep MeterPal-specific logic in the billing server. |
| **Autumn fork drift** | `billing/` is a fork of Autumn. | Same: new MeterPal logic lives in MeterPal-named modules, upstream is reference-only. |
| **Open:** does the merchant ever hold their own provider keys? | Decided: MeterPal holds them. But a large merchant may demand BYOK for compliance. | Design §4.3 so `upstream_key_ref` can later point at a merchant-held key without changing the billing path. |
| **Open:** is one MeterPal PayPal app with many merchants legally workable? | PayPal's platform product covers this, but it carries a contractual review. | Phase P1 supports per-org apps (the general case). Treat the platform question as a commercial decision, not an engineering one. |

---

## 8. What already exists — do not rebuild it

| Subsystem | Where |
| --- | --- |
| The PayPal subscription lifecycle (create / revise / cancel, approval → activation → plan attach, the redirect-token resolution) | `billing/server/src/internal/billing/paypal/`, `billing/server/src/external/paypal/` |
| The Autumn↔LiteLLM contract (`/check`, `/balances.finalize`, `/track_tokens`) | `docs/bridge.md`, `gateway/litellm/integrations/meterpal_billing.py` |
| The reservation pattern, concurrency primitives, the 402 wall | `docs/plan.md` §4–5, §7 |
| The customer-facing billing components and their contract | `docs/customer-ui.md`, `sdk/typescript/src/components/` |
| The per-org payment-processor pattern to copy | `billing/shared/models/orgModels/orgTable.ts` (`stripe_config`), `billing/vite/src/views/developer/configure-stripe/` |
| The metering bridge (admission, commit/release, per-token debit) | `gateway/litellm/integrations/meterpal_billing.py` |
| Per-customer virtual key provisioning | `billing/server/src/internal/keys/litellmKeys.ts` |
| The model pricing feed | `billing/server/src/internal/features/utils/getModelPricing.ts` |
| Plan-level model markups | `features.model_markups` (`markup`, `input_cost`, `output_cost`) |
| The AI-assisted onboarding machinery | `billing/vite/src/views/onboarding4/` |
| Deployment | `docs/DEPLOY.md` |

---

## Appendix — file pointer index

| Area | Key files |
| --- | --- |
| PayPal | `billing/server/src/external/paypal/{client,subscriptions,orders,runPaypalWebhookHandlers}.ts`, `internal/billing/paypal/{runPaypalCheckout,paypalReturnRouter,decideSubscriptionAction}.ts` |
| Org / tenant | `billing/shared/models/orgModels/orgTable.ts`, `billing/server/src/internal/orgs/orgUtils.ts` |
| Catalog & pricing | `billing/shared/models/featureModels/featureTable.ts` (`model_markups`), `internal/features/utils/{getModelPricing,isBillableModelCost}.ts`, `internal/features/aiCreditSystemUtils.ts` |
| Admission & metering | `billing/server/src/internal/api/check/`, `internal/balances/track/utils/getTokenTrackParams.ts`, `gateway/litellm/integrations/meterpal_billing.py` |
| Virtual keys | `billing/server/src/internal/keys/litellmKeys.ts`, `internal/keys/litellmWebhookTriggers.ts` |
| Dashboard | `billing/vite/src/views/{developer,settings,products,onboarding4}/` |
| SDK | `sdk/typescript/src/{index,client}.ts`, `sdk/typescript/src/components/`, `sdk/python/src/meterpal/` |
| Gateway | `gateway/config.yaml`, `gateway/litellm/integrations/meterpal_billing.py` |
| Reference implementation | `demo-app/server.ts` (the manual wiring a merchant should not have to do) |
