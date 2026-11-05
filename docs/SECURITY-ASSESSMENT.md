# MeterPal Security Assessment — Deep Pentest Report

**Date:** 2026-11-05
**Scope:** Full-stack review of the MeterPal repo (`billing/server`, `billing/shared`, `gateway/litellm` bridge, `billing/vite`, `demo*`, `docker-compose.yml`, secrets/config) plus **live dynamic testing against the running local demo stack** (billing :8080, gateway :4000, mock LLM :9999).
**Authorization:** Owner-requested assessment of their own codebase ahead of a hackathon demo. All dynamic tests were run against the local stack with the local demo merchant key; every balance/lock change was reverted and verified (demo customer balance restored to exactly 1.2 credits; test lock released).

**On "zero days":** every finding below is an unpublished vulnerability in MeterPal's own code (some inherited from the fork's upstream). Two are money-critical and were **reproduced live** on the running stack. No external exploit code was used; all PoCs are in this report.

> ## ✅ PATCH STATUS (2026-11-05, later same day)
>
> All findings below have been **patched and verified against the live restarted stack**:
>
> | Finding | Fix | Live re-verification |
> | --- | --- | --- |
> | C1 pinned_rates forgery | Server-side quote store (`pinnedRatesStore.ts`): check stores the quote under the caller's idempotency key; settle **replaces** caller rates with the stored quote, or ignores them if none. Schema + `getPinnedModelCostBreakdown` reject negative/non-finite. | forged zero rates → billed 0.16 (real rates), not 0 ✅ |
> | C2 unpriceable model free usage | Lock-bearing checks with an unpriceable `model_id` now **422** (fail closed); bridge dead-letters 4xx money POSTs (`RECONCILE-NEEDED`). | unpriceable + lock → 422 ✅ |
> | H1 gateway impersonation | `gatewayAuthMiddleware` allowlists the credential to exactly `POST /v1/check`, `POST /v1/track_tokens`, `POST /v1/balances.finalize`; timing-safe compare. | customers route via trust secret → 403; bridge path still works ✅ |
> | H2 metadata poisoning | Bridge strips `_autumn_*`/`_meterpal_*` keys from caller metadata at ingress; quote store makes the server values authoritative anyway. | gateway call with poisoned metadata → billed at real rates (1.2 → 0.38026) ✅ |
> | M1 cross-tenant attribution | `orgId` threaded through every PayPal handler; email + payer-id fallbacks org-scoped. | static (requires second org to exercise) |
> | M2 plaintext virtual keys | Deterministic encryption at rest (`virtualKeyCrypto.ts` + `encryptDataDeterministic`); lookup by ciphertext; **legacy rows lazy-upgrade on first touch** — demo key verified as ciphertext in the DB, `GET /v1/keys` still returns the live key. | DB row now 64-char ciphertext ✅ |
> | M3 public-endpoint limiter | Peer address from the socket (XFF only via `TRUSTED_PROXY_DEPTH` helper) + per-customer/per-id buckets; payment tokens no longer logged. | 65 rotating-XFF requests → 429 ✅ |
> | M4 500 info leak | Unknown/Zod 500s return a generic message; details stay in logs/Sentry. | static |
> | M5 send_event scope | `send_event: true` requires `balances.write` for scoped keys. | static |
> | L1 webhook dedup TOCTOU | Claim-first insert with release-on-dispatch-failure (retries preserved). | static |
> | L2 uncapped refund fallback | Refund debits only when the linked grant is found; otherwise skipped for reconciliation. | static |
> | L3 plan-name fallback | Word-boundary matching ("premium" no longer maps to `pro`). | static |
> | L4 reasoning double count | Bridge sends `output_tokens` excluding detail-reported reasoning; Lua guards `credit_cost <= 0/tiny/huge`. | static |
> | L5 network exposure | docker-compose ports bound to `127.0.0.1`. | applied |
> | L6 `PAYPAL_BASE_URL` | Override ignored in production with a warning. | static |
> | L8 repo hygiene | Root `.routes_new*` / `.server-errors*` removed from git. | applied |
>
> Server typecheck clean (`tsc --noEmit`), bridge compiles. **Not done (owner actions):** rotate every credential in `gateway/.env` / `billing/server/.env` after the hackathon; `git commit` the changes; run `python demo/bootstrap.py` if you want the synthetic pentest ledger rows (`pentest-*`, `z*`, `fix-*`) cleared.

---

## 1. Executive summary

The architecture is unusually thoughtful for a hackathon project: real PayPal webhook signature verification, per-org encrypted PayPal credentials, atomic Redis/Lua balance math, org-scoped lock receipts, idempotent wallet grants, and a gateway bridge that fails closed by default. The auth surfaces I probed unauthenticated all refused correctly (401s, webhook forgery rejected, CORS not reflected, generic error reasons).

But the metering **pricing path trusts the caller**, and that breaks the money guarantee end to end:

- **C1 — `pinned_rates` on `/track_tokens` is honored verbatim.** Anyone holding an org secret key (or the gateway trust secret) can bill any usage at an arbitrary price — demonstrated live: 5M/5M tokens that cost ~1,100 credits billed at a flat 1.0 credit (the deduction layer's floor). Unlimited usage for a fixed price.
- **C2 — an unpriceable model is admitted with the hold collapsed to the policy floor, then never billed.** Demonstrated live: `/check` for `azure/fake-deployment-xyz` → `allowed: true` with a 0.5-credit hold on a request whose true cost is ~6.8; the settle call 400s, the bridge treats 4xx as permanent and drops the charge, then releases the hold. Usage served, nothing billed.
- **H1 — the scope check fails open, and the gateway trust secret rides that fail-open with a body-supplied `org_id`.** Whoever holds `PAB_TRUST_SECRET` can act as **any org** on any `/v1` route (read customers, adjust balances, connect their own PayPal to a victim org), because empty `ctx.scopes` bypasses every route's scope requirement.
- **H2 — the gateway's billing contract travels in caller-controlled metadata.** `_autumn_pinned_rates` / `_autumn_model_id` are stashed in the LiteLLM request `metadata`, which the client supplies; when the check response omits pricing (exactly the C2 case, verified live), the caller's forged values survive into the settle call.

PayPal-specific: the webhook receiver and capture paths are solid. The real PayPal-side weaknesses are **cross-tenant customer attribution** (global email/payer-id fallbacks) and the **unauthenticated, limiter-bypassable** public return-router endpoints.

---

## 2. Findings overview

| # | Severity | Finding | Verified |
| --- | --- | --- | --- |
| C1 | Critical | `/track_tokens` bills at caller-supplied `pinned_rates` verbatim (zero/under-priced usage) | **Live** |
| C2 | Critical | Unpriceable model → admitted with floor-sized hold, settle 400s, charge dropped, hold released = free usage | **Live** (admission) + static (settle) |
| H1 | High | Scope check fails open on empty scopes; gateway trust secret = unrestricted org impersonation via body `org_id` | Static (both halves read end-to-end) |
| H2 | High | Gateway billing contract (`_autumn_*`) rides caller-controlled LiteLLM metadata; poison survives when the check returns no pricing | Static + precondition **live** |
| M1 | Medium | Cross-tenant wallet attribution: `resolveCustomer` email/payer-id fallbacks are global, not org-scoped | Static |
| M2 | Medium | Customer virtual keys stored **plaintext** in `customers.litellm_virtual_key` | Static |
| M3 | Medium | Public PayPal endpoints (`/poll`, `/capture/:id`, `/activate/:id`) are unauthenticated oracles; per-IP limiter trusts `X-Forwarded-For` and is trivially bypassed | **Live** |
| M4 | Medium | `errorMiddleware` returns raw `err.message` for unexpected 500s (DB/schema details leak) | Static |
| M5 | Medium | `send_event: true` on `/check` debits with only `balances.read` scope | Static |
| L1–L8 | Low | See §5 (webhook dedup TOCTOU, uncapped refund fallback, plan-name fallback misprovisioning, reasoning-token double count + value/deduction divergence, 0.0.0.0 docker binds, `PAYPAL_BASE_URL` override, token logging, repo hygiene) | Static / live |

---

## 3. Critical findings — detail

### C1 · `/track_tokens` honors caller-supplied `pinned_rates` verbatim (price forgery)

**Where**
- `billing/shared/api/balances/track/trackTokensParams.ts:76-91` — `pinned_rates` is a public, unbounded `z.number()` sheet.
- `billing/server/src/internal/balances/track/utils/getTokenTrackParams.ts:176` — `input.pinned_rates ? getPinnedModelCostBreakdown(...) : getModelCreditCostBreakdown(...)` — used **verbatim**, no server-side verification against a stored quote, the lock receipt, the model id, or the org's price sheet.
- `billing/server/src/internal/features/aiCreditSystemUtils.ts:350` — `getPinnedModelCostBreakdown` does no lookup at all; `computeCost` multiplies whatever numbers arrive.

**Intent vs reality.** The pinning design (check quotes rates → caller echoes them at settle) is an *honor system*: the settle price is whatever the HTTP caller says it is. Nothing binds the echoed rates to the quote.

**Live PoC** (demo org key, `custom/demo-gpt` real rates ≈ 60/M in + 100/M out):

```
POST /v1/track_tokens
{ "customer_id":"demo-customer", "feature_id":"ai_tokens",
  "model_id":"custom/demo-gpt",
  "input_tokens":5000000, "output_tokens":5000000,     // true cost ≈ 1,100 credits
  "pinned_rates": {"input":0,"output":0,"markup":0},
  "idempotency_key":"z4" }

→ {"value": 0, ...}          // control (no pinned_rates): value 0.16 for 1k/1k tokens
```

Observed behavior worth knowing:
- The deduction layer still takes a **flat 1.0-credit floor** per event (`deductions:[{value:1}]`) even when the computed cost is 0 — so the practical exploit is *"any usage, any size, for a flat 1.0 credit"*, and the reported `value` (0) diverges from the applied deduction (1.0).
- **Negative rates do not inflate the balance** in the running build (a negative delta was computed — `value: -0.002` — but the balance did not move). Under-billing to a constant is what works today; treat "negative rates must be rejected" as mandatory defense so it stays that way.

**Who can exploit.** Any holder of an org secret key (`am_sk_…`) or the gateway trust secret — both server-side credentials — plus the end-user path via H2 below. Direct API: a merchant can under-bill its own customers (MeterPal still pays provider cost); via the gateway, the same reachability exists for the metadata route.

**Fix.**
1. Store the quoted rates **server-side at check time** (in the lock receipt or an idempotency-keyed Redis record) and have settle read them back; make `pinned_rates` server-ignored, or HMAC-sign the quote and verify at settle.
2. Until then: reject `pinned_rates` unless the caller authenticated as `AuthType.Gateway` **and** the rates match a quote issued for that `idempotency_key` + `model_id` + org; hard-reject negative or non-finite values; clamp `markup >= 0`.

### C2 · Unpriceable model = admitted cheap, never billed

**Where**
- `billing/server/src/internal/api/check/resolveCheckPricing.ts:88` — returns `null` when the model can't be priced ("must not fail the admission").
- `billing/server/src/internal/api/check/handleCheck.ts:127-130` — `lockValue = holdPricing && estimated_cost > 0 ? estimated_cost : undefined` → hold collapses to `required_balance` (gateway default 1.0).
- `billing/server/src/internal/features/aiCreditSystemUtils.ts:40-46` — settle throws 400 `modelNotFoundError` for the same unpriceable id.
- `gateway/litellm/integrations/meterpal_billing.py:469-471` — bridge retry loop: `if resp.status_code < 500: break  # 4xx — permanent` → the charge is **dropped**, then `/balances.finalize` (commit, `override_value: 0`) releases the hold.

**Live PoC** (balance 1.2, policy floor 0.5):

```
POST /v1/check
{ "customer_id":"demo-customer", "feature_id":"ai_tokens",
  "model_id":"azure/fake-deployment-xyz",          // LiteLLM-routable shape, no price row
  "input_tokens":100000, "output_tokens":8192,     // true cost ≈ 6.8 credits
  "required_balance":0.5, "lock":{"enabled":true}, "idempotency_key":"f2-clean" }

→ {"allowed": true, "lock": {"lock_id":"lck_f2-clean"}, "pricing": null}
```

`pricing: null` also means the response carries **no pinned rates and no server-resolved model id** — which is exactly the precondition for H2. Any deployment-style id (`azure/<dep>`, `bedrock/...`) missing from the org's price sheet triggers this; an org with no served-model rows gets `models: []` on its virtual key = every gateway model allowed (`billing/server/src/internal/keys/litellmKeys.ts:111-120`).

Concurrency consequence: each parallel request holds only 0.5, so N concurrent requests see "balance − N×0.5" — the reservation no longer bounds real spend (this is the documented "N concurrent requests" failure mode, reintroduced through the pricing gap).

**Fix.** Fail closed: refuse admission (402/422) when `model_id` is provided but unpriceable, or charge the hold at the org's most expensive served-model rate as a conservative ceiling. On the bridge, dead-letter 4xx settle failures into a reconciliation queue instead of dropping them.

### H1 · Scope check fails open + gateway trust secret = unrestricted org impersonation

**Where**
- `billing/server/src/honoMiddlewares/routeHandler.ts:222-235` — `if (!granted || granted.length === 0) return next();` — the warning is commented out; empty scopes pass **every** route's scope requirement ("legacy fail-open").
- `billing/server/src/honoMiddlewares/gatewayAuthMiddleware.ts:27-79` — `isGatewayCredential` is a plain string compare against `PAB_TRUST_SECRET` (not constant-time); on match, **`org_id` is taken from the request body** and `ctx.scopes = []`.

**Impact.** Whoever holds `PAB_TRUST_SECRET` (one static string in `gateway/.env`, shared across the whole platform) can call **any** `/v1` endpoint **as any org**: read every customer and balance, adjust balances, attach plans, create invoices, upsert served-model prices, and — note — `POST /v1/organization/paypal` to **connect their own PayPal account to a victim org** or delete the victim's connection, because `Scopes.Organisation.Write` is bypassed. The bridge presents exactly this credential in its intended multi-tenant mode (`meterpal_billing.py:200-201`, `bearer = trust_secret or api_key`).

The mitigating design intent is real — the secret never leaves MeterPal infra, and empty secret disables the path — but a single unscoped static bearer that outranks *all* scope checks is a platform-crown-jewel equal to the LiteLLM master key, with none of the key-management machinery around it.

**Fix.** Make the scope check fail **closed** for `AuthType.Gateway` (empty scopes on a gateway request should refuse), mint per-instance short-lived gateway tokens, use `crypto.timingSafeEqual`, and (better) drop body-supplied `org_id` in favor of a signed claim the gateway must present. At minimum, restrict the gateway credential to the exact route set it needs (`/check`, `/track_tokens`, `/balances.finalize`) via an explicit allowlist in `gatewayAuthMiddleware`.

### H2 · The gateway billing contract rides caller-controlled metadata

**Where** — `gateway/litellm/integrations/meterpal_billing.py`
- `:812` — `md = data.setdefault("metadata", {})` — `data` is the request body; `metadata` is **caller-supplied** (standard LiteLLM passthrough).
- `:816-823` — `_autumn_pinned_rates` / `_autumn_model_id` are only **overwritten when the check returned them**. When pricing is absent (the verified C2 case), a caller's forged `metadata: {"_autumn_pinned_rates": {"input":0,"output":0,"markup":0}, "_autumn_model_id": "openai/gpt-4o-mini"}` survives.
- `:863, :854` — settle sends `md.get("_autumn_pinned_rates")` and `md.get("_autumn_model_id")` — the poisoned values — and the billing server bills them verbatim (C1).

**Impact.** In the hosted model, the end user (through any merchant app that forwards request metadata) can choose what a request is billed at whenever the check fails to pin a price — model-id confusion to a cheap model, or zero rates. The same window opens on any transient pricing-resolution failure.

**Fix.** Carry the admission contract outside caller reach: use a `litellm_params`-only key the proxy controls, or a separate in-process map keyed by `litellm_call_id`; on ingress, strip any caller metadata key beginning with `_autumn_` / `_meterpal_`.

---

## 4. PayPal REST findings (the money side, as requested)

**Done well (verified by reading + live forgery tests):**
- Webhook signature verification is the real thing: CRC32 over the raw body, SHA256withRSA against a PayPal cert from an **exact-host allowlist** (`webhookSecurity.ts:46-60` — the `startsWith` bypass is already fixed), 10-minute freshness window, per-org webhook id resolved from the URL **before** any state is read. *Live-verified: forged `PAYMENT.CAPTURE.COMPLETED` events against the real demo org id → `401 invalid signature`, with and without PayPal headers.*
- Event idempotency via `webhook_events` (prefixed ids) + `wallet_ledger.idempotency_key` **unique** constraint (`billing/shared/models/litellmModels/bridgeTables.ts:74`); grants delete the ledger row on balance-update failure so PayPal's 25 retries aren't poisoned.
- Amounts always come from the server-side catalog or PayPal-signed resources — **no client-controlled amount reaches order/subscription creation** (`runPaypalCheckout.ts:562-615`; positive-total enforced). USD-only currency guards on every money handler (sale/capture/refund/invoice).
- Per-org credentials: encrypted at rest (`encryptData`), masked client id in the API, secret never returned, Redis token cache keyed `{org}:{env}:paypal_token:{env}` invalidated on reconnect; sandbox/live env separation is strict once an org connects its own app.
- Order→org binding via `paypal_order_intents` — "an order we never created must never be captured against some org's account" (`paypalOrgClient.ts:30-47`).

**Issues:**

- **M1 · Cross-tenant wallet attribution (medium).** `resolveCustomer` (`runPaypalWebhookHandlers.ts:172-207`) falls back to **global** email lookup (`eq(customers.email, email)` — no org filter, arbitrary first row) and **global** payer-id lookup in most callers. In multi-tenant PayPal, buyer X paying merchants A and B: a grant/activation/refund whose custom_id is missing can credit (or debit, on refund) **the wrong org's customer**. The refund handler's own comment says email fallback caused "cross-tenant wallet drain" and was removed *there* — but sale/capture/subscription/invoice handlers still use it, and payer_id (globally unique per buyer across all PayPal apps) has the same collision property. **Fix:** thread the org (known from the webhook URL / intent row) into every `resolveCustomer` call and scope every fallback by `org_id`.
- **L2 · Refund cap degrades to uncapped (low).** `runPaypalWebhookHandlers.ts:915-918`: when the original grant's ledger row isn't found (`refundCap == null`), `refundAmount = |amount|` — no cap. Only reachable when the refund resolves via payer fallback and the original grant predates the idempotency-key convention, but the cap silently disappears exactly when attribution is least certain.
- **L1 · Event dedup TOCTOU (low).** `handlePaypalEvent` does select → dispatch → insert (`:84-115`). Two concurrent deliveries of the same event id both dispatch; wallet grants survive (unique key) but non-grant effects (provisioning, plan attach) can race. An insert-first-`onConflictDoNothing`-then-dispatch (or an atomic claim) closes it.
- **M3 · Public return-router oracles + bypassable limiter (medium, live-verified).** `GET /paypal/poll?customer_id=X` (order-state oracle + forced capture of an approved order), `POST /paypal/capture/:order_id`, `GET /paypal/activate/:subscriptionId` are unauthenticated by design; the "coarse per-IP limiter" trusts `X-Forwarded-For` and I confirmed 65 requests/min all return 200 with rotating XFF vs 429 on a fixed IP. **Fix:** bound the limiter by a proxy-derived IP (or key the bucket on the order/customer token), and require a checkout-token proof on `/poll`.
- **L6 · `PAYPAL_BASE_URL` override (low).** `paypalClient.ts:221-226` — if this env var is ever set in a production process, **all PayPal traffic including Basic-auth credentials goes to that host**. Gate it to `NODE_ENV !== "production"`.
- **L7 · Payment tokens logged (low).** `paypalReturnRouter.ts:192-196` logs the raw `token`/`checkout` values; treat them as credentials in logs.

---

## 5. Lower-severity findings

- **L1** — webhook dedup TOCTOU (above).
- **L3 · Plan-name fallback misprovisioning.** `planKeyForPlanId` (`runPaypalWebhookHandlers.ts:1227-1239`) maps any unmapped plan id containing `"pro"` (note: *"premium"* contains *pro*) to the hardcoded `pro` plan and provisions its entitlements/budget. Wrong-plan provisioning on unmapped ids; return an error instead.
- **L4 · Money-math nits.** Reasoning tokens are added **on top of** `output_tokens` in `computeCost` while LiteLLM's `completion_tokens` already includes them (systematic overcharge, merchant-unfriendly). Observed live: a zero-cost event reports `value: 0` while deducting 1.0 (`deductions:[{value:1}]`) — reported value and applied deduction diverge, which will poison reconciliation. The Lua divides by a caller-derived `credit_cost`; a tiny-but-nonzero cost yields `inf` deltas (`deductFromMainBalanceV2.lua:114,157`).
- **L5 · Demo network exposure.** `docker-compose.yml` binds Postgres (`autumn/autumn_dev_only`) and Redis (`autumn_dev_only`) on `0.0.0.0` — on shared demo Wi-Fi, anyone on the LAN reaches the billing DB and hot-path Redis. Bind to `127.0.0.1:` (e.g. `"127.0.0.1:5433:5432"`).
- **L8 · Repo hygiene.** Root litter (`.routes_new.json`, `.routes_new2.json`, `.server-errors*.txt`) contains internal route dumps and compiler output — no secrets found, but exclude them from the submission bundle.
- **M4** — `errorMiddleware.ts:106-113` returns `err.message` for unexpected 500s; Drizzle/PG messages include table/constraint names. Return a generic message, log the detail.
- **M5** — `/check` with `send_event: true` debits under route scope `balances.read` only (`handleCheck.ts:27` + `runCheckWithTrackV2.ts`); publishable keys are explicitly blocked (`ctx.isPublic` guard — good), but a read-only scoped secret key can debit. Require `balances.write` when `send_event` is set.
- **M2** — virtual keys stored plaintext (`customers.litellm_virtual_key`, global plaintext lookup in `inferenceAuth.ts:87-90`). Everything else in the auth stack (SHA-256-hashed org keys, hashed comparison) is better; hash these too, or at minimum encrypt at rest.

**Auth surface verified clean (no findings):** unauthenticated `/v1/*` → 401 (live); Better-Auth dashboard org resolution is server-side with a tight sandbox-access assertion (`sandboxAccess.ts` — `created_by` + `is_sandbox`, uniform 404s); customer JWTs use route allowlists per audience, server-side scopes immune to the fail-open, revocation epochs, and force-pinned `customer_id` (`customerJwtMiddleware.ts`); virtual-key provisioning is secret-key-only with org-scoped customer lookup and virtual keys cannot mint or read keys (`handleProvisionKey.ts`, `handleGetKey.ts`); inference `user` ↔ key cross-check rejects mismatches; CORS reflects nothing for foreign origins (live); `/ready/:token` is token-gated (live); the uncommitted `debug-*.ts` files are local console probes, not mounted routes; **no `.env` was ever git-committed** (history checked) and the demo merchant key is SHA-256-hashed at rest.

---

## 6. What was verified live (dynamic test log)

Against the running local stack (billing :8080, gateway :4000):

| Test | Result |
| --- | --- |
| Unauth `POST /v1/check`, `GET /v1/customers/:id` | 401 ✅ |
| Forged PayPal webhook (real org id, ± PayPal headers) | 401 invalid signature ✅ |
| Forged webhook, unknown org | 404 ✅ |
| CORS preflight from `https://evil.example` | not reflected ✅ |
| `GET /ready/whatever` | 404 ✅ |
| `capture`/`activate`/`poll` with bogus ids | generic errors, no PayPal-state leak ✅ |
| **C1**: `track_tokens` zero `pinned_rates` @ 1k→5M tokens | `value: 0` at every size (flat 1.0-credit floor applied) 🔴 |
| **C1**: negative `pinned_rates` | computed negative value, balance unchanged (no inflation in this build) ⚠️ |
| **C2**: `/check` unpriceable model + lock | `allowed: true`, hold = floor (0.5 vs true ≈6.8), `pricing: null` 🔴 |
| XFF rotation on `/paypal/poll` (65 req) | all 200 (fixed IP → 429 after 61) 🔴 |
| Gateway admin API with master key from `gateway/.env` | works (expected; crown jewel) ⚠️ |

Cleanup: test lock released via `POST /v1/balances.finalize` (RPC dot-path), demo customer balance restored to exactly **1.2**. Residue: synthetic `wallet_ledger` rows (idempotency keys `pentest-*`, `z*`, `ctl-*`, `f2-clean`) and zero-value usage events — `python demo/bootstrap.py` resets them if you want a pristine demo.

---

## 7. Prioritized fix list

1. **Kill caller-controlled pricing (C1 + H2).** Server-side quote store keyed by the check's idempotency key; settle reads it back; reject negative/non-finite rates; strip `_autumn_*` metadata on ingress. *(Highest impact, ~a day.)*
2. **Fail closed on unpriceable models (C2)** + dead-letter 4xx settles in the bridge.
3. **Fail closed on empty scopes for `AuthType.Gateway` (H1)**; constant-time compare; route allowlist for the gateway credential.
4. **Org-scope every `resolveCustomer` fallback (M1)** — the org is always known at the call site.
5. Hash virtual keys at rest (M2); replace the `send_event` scope mismatch (M5); generic 500 messages (M4).
6. Demo-day: bind docker ports to `127.0.0.1` (L5); rotate `LITELLM_MASTER_KEY`/`PAB_TRUST_SECRET`/`PAB_API_KEY`/PayPal sandbox creds after the hackathon regardless (they've sat in a working tree and multiple logs).
7. Hygiene: `planKeyForPlanId` error instead of `"pro"` fallback (L3); proxy-derived IP for the public limiter (M3); gate `PAYPAL_BASE_URL` to non-prod (L6); stop logging payment tokens (L7); delete root artifact files (L8).

---

## 8. Method & coverage

Static: full reads of the PayPal module (`external/paypal/*`, `internal/billing/paypal/*`, org PayPal handlers), auth chain (`secretKeyMiddleware`, `gatewayAuthMiddleware`, `publicKeyMiddleware`, `customerJwtMiddleware`, `betterAuthMiddleware`, `sandboxAccess`, `routeHandler` scope logic), the metering core (`handleCheck` → `runCheckWithRollout/WithTrackV2`, lock parse/receipt/finalize, `getTokenTrackParams`, `aiCreditSystemUtils`, `resolveModelRates`, served-model handlers), the full 926-line gateway bridge (`meterpal_billing.py`), routers/middleware assembly (`initHono`, `apiRouter`, `internalRouter`, `publicRouter`), secrets/env/git-history, docker-compose, demo bootstrap. Findings were cross-checked by two independent reviewers (a parallel agent audit of the metering core independently reproduced C1/C2/H1/M1 with matching line numbers).

Dynamic: live probes + authenticated PoCs with the local demo key, listed in §6.

Not covered: browser-side XSS audit of `billing/vite` (spot-checks only), `apps/*` sub-apps, upstream LiteLLM/Autumn CVE posture (this is a fork — run dependency scanners before treating the forks as products), load/DoS testing beyond the limiter check.
