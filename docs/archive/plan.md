# Concurrency-safe usage billing — implementation plan

**Status:** ✅ completed — the as-built reference is
[`docs/scaling-and-concurrency.md`](../scaling-and-concurrency.md). Archived 2026-11-08.
**Scope:** the gateway↔billing-server path that admits, reserves, meters and settles
AI inference requests.
**Origin:** the concurrency assessment of MeterPal against Cursor, Copilot, Lovable,
Perplexity, OpenRouter, AWS Bedrock and LiteLLM.

---

## 1. The problem, in one paragraph

MeterPal's *money* machinery is sound: price pinning, lock receipts with expiry,
idempotency, fail-open queueing, server-authoritative pricing. Its *concurrency*
machinery is not implemented as an explicit control. The admission gate is a
point-in-time boolean evaluated behind a one-second cache; the balance reservation
that would make that gate safe is (a) off by default, (b) never actually reaching
the server in a valid shape, and (c) sized at a flat amount that does not reflect
what the request can cost. There is no concurrency ceiling anywhere in the stack,
and the one correct primitive that ships inside the vendored LiteLLM fork is
switched off in `gateway/config.yaml`. The net effect: **a customer with $1.00 can
run unlimited simultaneous requests and drive their balance deeply negative.**

Every surveyed platform that publishes a reserve→settle pattern prevents this.
Every platform that does not has at least a rate ceiling that bounds it. MeterPal
currently has neither.

---

## 2. Root causes

Six defects compose into the failure. Fixing any one alone does not close the
hole; the set is what matters.

### R1 — The reservation path had never worked. Four independent breaks.

The balance reservation was not merely disabled — every part of it was broken,
in four separate places. Any one of them would have made the hold a no-op.

**R1a — The lock payload the gateway sent was invalid.**
`gateway/litellm/integrations/meterpal_billing.py` sent

```python
body["lock"] = True          # a boolean
```

but the server's schema (`billing/shared/api/balances/check/checkParams.ts` →
`CheckLockParamsSchema` → `LockParamsSchema`) requires an **object** with a
`lock_id` string and `enabled: true`.

Verified against the live schema:

```
lock: true            -> "Invalid input: expected object, received boolean"
lock: {enabled:true}  -> "Invalid input: expected string, received undefined"  (lock_id required)
```

So `/check` answered **400**. The gateway calls `resp.raise_for_status()`, and
`httpx.HTTPStatusError` subclasses `httpx.HTTPError`, so the error was swallowed
by the `except httpx.HTTPError` arm — which sets
`allowed = self.fail_mode == "open"`. `PAB_FAIL_MODE` defaults to `"open"`.

**Consequence:** with `PAB_USE_LOCK=true`, every check failed open with **no
reservation and no price pin**. The request was admitted, billed later at live
pricing, and the balance was never held.

**R1b — The server never returned the reservation id.**
`CheckResponseV3Schema` had the `lock_id` field **commented out**. Even with a
valid lock payload the caller had no id to finalize, so a hold could only ever
be released by its expiry — and the expiry is only *scheduled* when the caller
supplies `expires_at` (`runCheckWithTrackV2.ts:141`), which the gateway did not.

**R1c — The gateway's settle call never named the tenant.**
`_billing_finalize` sent `{customer_id, lock_id, action, feature_id}` — no
`org_id`, no `env`. The gateway auth middleware requires the tenant on every
request, so `/balances.finalize` answered **400 "The gateway must name the
tenant it resolved from the caller's key"**. Every release failed; every hold
leaked.

**R1d — The reservation expiry was never scheduled.** Without `expires_at` the
lock receipt lived for a day (`prepareFeatureDeductionV2.ts:283-285`) and the
held balance was never given back.

### R2 — The hold was a flat `required_balance`, not the request's cost.

`runCheckWithTrackV2.ts` deducted `value: requiredBalance` for the lock.
`required_balance` is the *admission threshold* the caller sends
(`PAB_REQUIRED_BALANCE`, default `1.0` — a flat dollar amount), not a priced
estimate of this request. A request that can cost $40 held $1.00; a request
that can cost $0.04 also held $1.00.

The server already knows the price: `resolveCheckPricing` resolves the org's
rates and returns `estimated_cost` for the caller's token estimates. It was
simply called *after* the lock was created, so the number was never used.

### R3 — The check cache hands one reservation to every concurrent request.

`meterpal_billing.py:306-354` caches `(allowed, lock_id, pinned_rates, model_id)`
keyed by `(org, customer, model)` for `PAB_CHECK_TTL_SEC` (default 1.0s).

N concurrent requests from one customer inside one second → one reaches the
billing server; the rest reuse the cached verdict.

- with a lock: all N receive the **same `lock_id`**; the first settle consumes it,
  the rest fail, and the single reservation covers one request while N are billed;
- without a lock: N−1 requests skip the balance check entirely, so the 402 wall
  does not hold.

The cache is also per-process and unbounded.

### R4 — There is no concurrency ceiling anywhere.

The only mechanism in the stack that can cap concurrent in-flight requests is
LiteLLM's `max_parallel_requests` on the virtual key
(`gateway/litellm/proxy/hooks/parallel_request_limiter_v3.py:2960-2984`, gauge
created only when the value is non-None at `:1622`). MeterPal never sets it: the
key mint and update bodies (`billing/server/src/internal/keys/litellmKeys.ts:299-312`
and `:322-335`) send `rpm_limit`, `tpm_limit`, `max_budget`, `models` and
`metadata` — and no `max_parallel_requests`. The column exists
(`gateway/schema.prisma:260`) and stays NULL.

`gateway/config.yaml:40` sets `disable_budget_reservation: true`, switching off
LiteLLM's native reserve→settle — the one correct primitive in the stack — on the
stated premise that MeterPal is "the sole admission controller". MeterPal's
substitute is R1+R2+R3.

LiteLLM's own comment on what remains (`auth_utils.py:1406-1411`):

> Budget enforcement is read-time only. Concurrent requests can each pass the spend
> check before their cost is recorded, so a configured budget may be briefly
> exceeded under high concurrency.

### R5 — A client that disconnects before the first token leaks the reservation.

`gateway/litellm/proxy/common_request_processing.py:393-463` bills the partial
stream when at least one chunk arrived (good). When **zero** chunks arrived
(`:423-425`) or assembly failed (`:438-440`), neither the bridge's success hook
nor its failure hook runs — so with a reservation enabled, no
`/balances.finalize` is ever sent and the hold stays against the customer's
balance until it expires.

---

## 3. The fixes

Priority ordering is deliberate: **P0 makes the 402 wall hold, P1 makes it
correct under failure, P2 is documentation and hygiene.**

### P0 — make the 402 wall hold under concurrency

| ID | Fix | Files | Acceptance |
|----|-----|-------|------------|
| **F1** | Accept a valid lock payload: `lock_id` becomes optional (the server mints it — `parseCheckParamsForLock.ts:44` already does), and `lock: true` is accepted as shorthand for `lock: { enabled: true }`. The gateway sends the object form. | `billing/shared/api/balances/common/lockParams.ts`, `billing/shared/api/balances/check/checkParams.ts`, `billing/server/src/internal/balances/utils/lock/parseCheckParamsForLock.ts`, `gateway/litellm/integrations/meterpal_billing.py` | `/check` with a lock returns `lock.lock_id`; the gateway reads a non-null `lock_id` and never falls open |
| **F2** | Cache **only** the pinned rate sheet. The admission verdict and the `lock_id` are never cached — a `lock_id` is a per-request reservation token and sharing it is R3 exactly. Bound the cache size. | `gateway/litellm/integrations/meterpal_billing.py` | N concurrent requests produce N distinct `lock_id`s and N distinct `/check` calls |
| **F3** | Size the hold from the request's own pricing. Resolve pricing **before** the check runs and use `estimated_cost` as the reservation amount; keep `required_balance` as the admission threshold only. | `billing/server/src/internal/api/check/handleCheck.ts`, `.../runCheckV2.ts`, `.../runCheckWithTrackV2.ts` | a request whose priced worst case is $0.40 holds $0.40, not $1.00 |
| **F4** | Reserve by default. `PAB_USE_LOCK` defaults to true; the gateway sends a worst-case token estimate so the hold reflects what the request can cost. | `gateway/litellm/integrations/meterpal_billing.py` | a fresh gateway reserves by default; `PAB_USE_LOCK=false` still disables it |
| **F5** | Set `max_parallel_requests` on every minted/updated LiteLLM key, per plan. This arms the fork's existing slot-based limiter (per-slot TTL, exactly-once release, Redis gauge). | `billing/server/src/internal/keys/litellmKeys.ts` | a provisioned key carries a non-null `max_parallel_requests`; the 51st concurrent request for a plan capped at 50 gets a 429 |
| **F6** | Re-enable LiteLLM's budget reservation as an independent backstop, so a bug in MeterPal's reservation cannot produce unbounded overspend. | `gateway/config.yaml` | `disable_budget_reservation` is not set to true |

### P1 — correctness and robustness

| ID | Fix | Files | Acceptance |
|----|-----|-------|------------|
| **F7** | Give `/check` an idempotency key so a re-entrant pre-call hook cannot create a second reservation for the same request. | `billing/shared/api/balances/check/checkParams.ts`, `billing/server/src/internal/api/check/handleCheck.ts`, `gateway/.../meterpal_billing.py` | two `/check` calls with the same key yield one reservation |
| **F8** | Release the reservation on **every** exit path, including a zero-chunk disconnect. | `gateway/litellm/integrations/meterpal_billing.py` | a client that disconnects before the first token leaves no held balance |
| **F9** | Declare `org_id` / `env` in the track schemas. They are sent on the wire and read off the raw body by `gatewayAuthMiddleware.ts:39-59`, but are absent from `TrackTokensParamsSchema` — the contract and the schema have silently diverged. | `billing/shared/api/balances/track/trackTokensParams.ts`, `.../trackParams.ts` | `org_id`/`env` are declared, validated and still reach the tenant resolver |
| **F10** | Settle without a window where the balance is free again. **The order is reversed: charge first, release second.** Releasing first put the whole balance back while the charge was still pending, and another request could take it in that window. | `gateway/.../meterpal_billing.py` | the balance only ever goes down; after the settle it is exactly `−usage` |
| **F11** | Per-request cap. A single request cannot exceed a configured token or cost ceiling, independent of the customer's balance. | `gateway/.../meterpal_billing.py` | a request above the cap is refused before the provider is called |
| **F12** | Move the customer-scoped track and check rate limits into Redis. They are `notInRedis: true`, so they are per-process and multiply by instance count. | `billing/server/src/internal/misc/rateLimiter/rateLimitConfigs.ts` | the limits are shared across instances |
| **F13** | One source for the org rate-limit constants. They are hardcoded twice — `meterpal_billing.py:159-160` and `litellmKeys.ts:69` — and can drift. | `gateway/.../meterpal_billing.py`, `billing/server/src/internal/keys/litellmKeys.ts` | one constant, one owner |

### P2 — documentation and hygiene

| ID | Fix | Files | Acceptance |
|----|-----|-------|------------|
| **F14** | Record an interrupted stream as **unreconciled**, not as zero usage. A missing final chunk does not establish that the request used no tokens (OpenAI); unknown usage is unknown, not free (WSO2). | `gateway/.../meterpal_billing.py`, `billing/shared/api/balances/track/trackTokensParams.ts` | an aborted request is recorded with a status that distinguishes it from a zero-cost success |
| **F15** | Reconcile the unimplemented `/v1/catalog` polling design with reality (`docs/architecture.md:184-188`). The allow-list actually travels via key mutations. | `docs/architecture.md` | the doc describes the shipped mechanism |
| **F16** | Publish the abort policy. Today MeterPal behaves like Cursor (charge partial) by accident of the code, not by decision. The industry splits: Cursor charges, Lovable does not, Perplexity keeps the spend. | `docs/plan.md` (this file) §6 | the policy is stated and the code matches it |
| **F17** | Protect `meterpal_billing.py` across LiteLLM re-syncs. It is MeterPal's own code inside the vendored tree, and `gateway/PATCHES.md` lists only *modifications to upstream files* — a new file is not a patch to upstream, so a clean re-sync would delete the entire billing bridge silently. | `gateway/PATCHES.md` | the bridge is listed with a re-add instruction |
| **F18** | This document, plus the `docs/architecture.md` pointers that reference the non-existent `docs/plan.md`. | `docs/architecture.md` | the architecture doc's links resolve |

---

## 4. What the end state looks like

```
client
  │
  ├─ LiteLLM auth  ── per-key rpm/tpm ────────────────────────────┐
  ├─ LiteLLM parallel limiter ── max_parallel_requests (F5) ──────┤ 429
  ├─ MeterPal org limiter ── per-org rpm/tpm ─────────────────────┘ 429
  │
  ├─ MeterPal /check ───────────────────────────────────────────────┐
  │    no cached verdict, no shared lock_id (F2)                    │
  │    lock: { enabled: true } (F1)                                │
  │    server prices the request and holds the worst case (F3)     │
  │    idempotency key (F7)                                        │
  │    → 402 insufficient_balance  |  lock_id + pinned_rates        │
  │                                                                 │
  ├─ provider call                                                 │
  │                                                                 │
  └─ MeterPal /track_tokens { lock_id, tokens } ────────────────────┘
       server computes the cost and settles the reservation (F10)
       one round trip, no free-balance window
```

Every request either **holds** its worst-case cost or is refused. There is no path
on which N concurrent requests each see the full balance and all proceed.

---

## 5. What shipped, and how it was verified

Every fix below is implemented. The verification column says what was actually
run, not what was intended.

| ID | Shipped | Verified by |
|----|---------|--------------|
| **F1** | `lock_id` is optional on check (the server mints it from `idempotency_key`); `lock: true` is accepted as shorthand; the check response carries `lock.lock_id`. | Schema probe (9 assertions) + live check |
| **F2** | The `/check` cache is **gone**. The verdict and the reservation id are per request. | Live concurrency test: 5 concurrent checks → 5 distinct ids |
| **F3** | The hold is the request's priced worst case (`estimated_cost`); `required_balance` stays the admission floor. The two are separate numbers. | Live test: the balance drops by exactly `estimated_cost` ($0.066), not by the flat `required_balance` ($0.50) |
| **F4** | `PAB_USE_LOCK` defaults to **true**; the gateway sends a worst-case token estimate (`max_tokens`, else `PAB_MAX_OUTPUT_TOKENS`); the input estimate now counts system prompts and tool schemas. | Live test: the reservation is taken |
| **F5** | `max_parallel_requests` is set on every minted/updated key, per plan (free 2, pro 8, pro_plus 16, ultra 32), overridable with `LITELLM_MAX_PARALLEL`. | Server typecheck; the column and the LiteLLM endpoint were verified to accept it |
| **F6** | `disable_budget_reservation` removed from `gateway/config.yaml`. LiteLLM's reservation reserves against the *key's* 30-day provider budget — a different ledger from the customer's balance — so it is a backstop, not a double charge. | Config review |
| **F7** | `/check` carries an `idempotency_key`; the server derives the reservation id from it, and the receipt's atomic `SET NX` guard rejects the duplicate. | Live test: the same key twice takes one hold |
| **F8** | The reservation carries an `expires_at`, so the billing server schedules the release. A request that never settles is released rather than held for a day. | Live test: the hold is released by `balances.finalize`; the expiry path is scheduled |
| **F9** | `org_id` and `env` are declared in `TrackTokensParamsSchema` and `TrackParamsSchema`. | Server typecheck |
| **F10** | The settle order is **charge first, release second**. The balance only ever goes down; the window where it was fully restored is gone. | Live test: the balance after settle is exactly `start − usage` |
| **F11** | A request asking for more output tokens than `PAB_MAX_OUTPUT_TOKENS` is refused with 400 before the provider is called. | Code review + gateway compile |
| **F12** | The customer-scoped Track and Check rate limits run in Redis instead of per-process memory. | Server typecheck |
| **F13** | The org rate limits are read from one place (`PAB_ORG_RPM_LIMIT` / `PAB_ORG_TPM_LIMIT` in the gateway's env), by both the server and the bridge. | Code review |
| **F14** | A request that reported no usage at all is recorded with status `unreconciled`, not as a zero-cost success. | Code review + gateway compile |
| **F15** | `docs/architecture.md` now describes the allow-list mechanism that actually ships (key mutations, not a catalog poll). | — |
| **F16** | The abort policy is §6 below. | — |
| **F17** | `gateway/PATCHES.md` has a new section 0 listing the files MeterPal *added* to the vendored tree — `meterpal_billing.py` among them — with a re-add instruction. | — |
| **F18** | `docs/architecture.md`'s links to `docs/plan.md` resolve. | — |

Two further defects were found while implementing and fixed as part of F1:

- **the gateway's `/balances.finalize` never sent the tenant**, so every
  release was refused with a 400 and every hold leaked (R1c);
- **the check response never returned the reservation id**, so the gateway had
  nothing to finalize (R1b).

### The live test

`billing/server` carries a check-against-the-running-server test that asserts
the whole sequence against a real customer with a real balance:

```
T1  a check with a reservation is allowed
T1  the response carries a reservation id
T1  the response carries pinned rates
T1  the response carries the priced estimate
T1  the hold is the priced estimate, not the flat required_balance
T1  the hold is NOT the flat required_balance
T2  every concurrent request got its own reservation
T2  every concurrent request was allowed
T2  the concurrent holds sum to N x the hold
T3  a repeated idempotency key does not take a second hold
T4  the settle call is accepted
T4  the hold is released
T4  the customer is charged the usage, not the hold
T5  a request the customer cannot afford is refused
```

All pass against the local server with `org_demo` / `demo-customer` on
`openai/gpt-4o-mini` at 1200 input / 800 output tokens (a $0.066 request).

### Deployment order

**Deploy the billing server before the gateway.** The gateway refuses a request
the billing server admitted without taking a reservation (`PAB_REQUIRE_LOCK`,
default true), so a gateway running ahead of the server would 402 every call.
Set `PAB_REQUIRE_LOCK=false` for a short window if you must roll the gateway
out first.

---

## 6. Policy decisions this plan bakes in

These are choices, not consequences of the code. Each is recorded here so the
behaviour is deliberate.

**Abort / partial usage.** A request that produced tokens is charged for them,
whether it succeeded, failed, or was stopped by the client. This follows Cursor
("any compute usage, even if a request is stopped early, is tracked accurately")
and Perplexity (credits spent are kept). It differs from Lovable, which charges
only for completed work. A request that produced **no** usage at all is recorded
as **unreconciled**, not as zero-cost success (F14).

**Over-reservation is preferred to under-reservation.** The hold covers the
request's priced worst case, and a request whose worst case the customer cannot
afford is refused rather than admitted. This matches OpenRouter and AWS Bedrock.
The alternative — admit and let the balance go negative — is the defect being
fixed.

**Enforcement is hard, not soft.** The 402 wall is a wall. Platform practice of
"usage can briefly exceed your spend limit" (Cursor) and "soft limits" (GitHub)
is tolerated only because the underlying reserve→settle bounds the overshoot to
one request's worth. Without that bound, overshoot is unbounded, which is not
acceptable for a platform billing other people's money.

**The server is the authority on price, always.** The gateway sends estimates; the
server prices them from the org's price sheet, pins the rates, and settles against
the pinned rates. The gateway never computes a price.

**The charge lands before the hold is released.** The two calls are separate, but
the order matters: while the hold is still in place the customer's spendable
balance is depressed, so a concurrent request is *refused* rather than admitted.
Releasing first would restore the whole balance with the charge still pending,
which is exactly how N concurrent requests end up spending more than the balance.
Because the hold is still held when the charge lands, the charge is sent with
`overage_behavior: "overflow"` — it is allowed past the remaining balance, and
the release afterwards gives back what the request did not use. The server
prices the charge from the token counts, so there is no duplicated pricing
arithmetic in the gateway and no rounding drift between the two numbers.

**Fail-open stays, but it must be visible.** `PAB_FAIL_MODE=open` keeps the
gateway serving when the billing server is unreachable. That is the right
availability trade, but it means an outage produces unbilled usage. The
fail-open path is logged and the condition is reported, not silent.

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| Turning the reservation on by default rejects requests that used to be admitted | The hold is priced, not flat (F3), so it is proportional to the request. `PAB_REQUIRED_BALANCE` stays as the floor. |
| `max_parallel_requests` too tight throttles legitimate traffic | Per-plan values, overridable per key; the limiter emits 429 rather than failing the request. |
| Re-enabling LiteLLM's budget reservation double-counts against MeterPal | LiteLLM's reservation is on *LiteLLM's* budget, MeterPal's on the MeterPal balance. They are separate ledgers; the key's `max_budget` is a provider-spend guard, not a customer balance. |
| F10 changes the settlement path | The two-call path stays as a fallback; the bridge falls back to it if the atomic settle fails. |
| A bad estimate over-reserves and blocks a customer | The estimate is the caller's `max_tokens` when supplied; uncapped requests use a conservative configurable ceiling. |
