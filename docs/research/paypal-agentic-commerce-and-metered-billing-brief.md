# PayPal Agentic Commerce & the Metered-Billing Rails Gap
**Research brief — compiled 2026-11-06. All claims labelled VERIFIED (read directly from primary source) or INFERENCE (reasoned from primary sources).**

---

## 0. HEADLINE CORRECTION — the brief's premise is false

**VERIFIED.** PayPal's REST API **does** have a usage-recording / metered-billing endpoint. It is the **Usage Based Billing API v1**, documented at https://developer.paypal.com/api/usage-based-billing/v1/ with a full OpenAPI schema at https://developer.paypal.com/api/usage-based-billing/v1/schema.yaml. It exposes `POST /v1/events`, `POST /v1/events/batch`, `POST /v1/metrics`, `POST /v1/plans`, `POST /v1/subscriptions`, `POST /v1/wallets`, `POST /v1/credit-notes`, and `GET /v1/invoices`, among others.

**INFERENCE:** The premise likely comes from the *pre-2025* PayPal API surface, or from the fact that PayPal's agent-facing MCP tool inventory (Part B) contains **zero** usage/metering tools while the REST API does. The genuine gap is not "PayPal lacks metering" — it is that **PayPal's metering rails and PayPal's agent rails are disconnected**, and that reconciliation semantics (Part A3) are undocumented.

---

## PART A — PAYPAL'S BILLING API SURFACE

### A1. What PayPal actually ships (VERIFIED)

Full product list: https://developer.paypal.com/api/ — **Orders v2** (`POST /v2/checkout/orders`), **Payments v2** (`/capture`, `/authorize`, `/confirm-payment-source`), **Subscriptions v1** (`POST /v1/billing/subscriptions`), **Invoicing v2** (`POST /v2/invoicing/invoices`), **Payouts v2** (`POST /v2/payments/payouts`), **Payment Links**, **Transaction Search** (`/v1/reporting/transactions`), **Vault v3**, **Disputes v1**, **Identity v1**, and **Usage Based Billing v1**.

Usage Based Billing v1 specifics (all VERIFIED against `schema.yaml`):

- **Auth**: OAuth 2.0 bearer, `clientCredentials` grant. Base `https://api-m.sandbox.paypal.com`.
- **Event primitive** (`EventBase`): required `transaction_id`, `metric_code`, `external_subscription_id`; optional `timestamp` ("Timestamp when the event occurred") and `properties` (free-form object, e.g. `{"gb": 10}`). Response returns `id`, `created_at`, `status: ACCEPTED`.
- **Batch semantics**: `POST /v1/events/batch` returns `success_count`, `error_count`, and a per-event `errors[]` array with `transaction_id`, `error_code`, `error_message` — i.e. **partial-batch acceptance**, not all-or-nothing.
- **Aggregation types** (`MetricAggregationType`): `COUNT`, `SUM`, `MAX`, `COUNT_DISTINCT`, `LATEST`.
- **Charge models** (`ChargeModel`): `STANDARD`, `GRADUATED`, `PACKAGE`, `PERCENTAGE`, `VOLUME`.
- **Billing cycles**: `WEEKLY`, `MONTHLY`, `QUARTERLY`, `YEARLY`.
- **Wallets**: prepaid balance primitives with `POST /v1/wallets`, `GET`/`PUT`/`DELETE /v1/wallets/{id}`, `GET /v1/wallets/{id}/transactions`.
- **Credit notes**: `POST /v1/credit-notes` requires `invoice_id` + `items[]` (`fee_id`, `amount`); optional `credit_amount`, `refund_amount`, `reason`, `description`. `POST /v1/credit-notes/{id}/void` exists.
- **Alerts**: `POST /v1/alerts` for consumption-threshold notifications (the "metered alert" primitive).
- **Webhooks** (18 event types): `usage-billing.invoice.created`, `usage-billing.invoice.payment.succeeded|failed|overdue`, `usage-billing.credit-note.created`, `usage-billing.credit-note.refund.failed`, `usage-billing.subscription.updated|terminated|trial.ended`, `usage-billing.wallet.created|updated|terminated|net-balance-depleted`, `usage-billing.wallet-transaction.created|updated`, `usage-billing.subscription-alert.triggered`.

**VERIFIED absence** (searched the full 9,502-line schema): there is **no** `rounding` property anywhere; no "estimated vs actual" flag; no invoice-close/finalize endpoint; no invoice-amendment endpoint; no dispute object in UBB; no late/backdated-event window parameter.

### A2. Metering primitives compared (VERIFIED unless noted)

| System | Metering primitive | Ingestion | Reconciliation with invoice |
|---|---|---|---|
| **PayPal UBB v1** | Metric + event (`POST /v1/events`) | REST, single or batch; `transaction_id` as idempotency key | Aggregates events per metric over the billing period; generates invoice; credit notes for corrections; void supported |
| **Stripe** | `POST /v1/billing/meter_events` (`event_name` + string `payload` + `timestamp`); `billing.meter_event_summaries` | REST + SDK; `identifier` idempotency | Flex Billing thresholds + holidays; invoices close monthly and re-rate on late events; **Stripe now steers new usage-based customers to Metronome** |
| **Metronome** (Stripe) | SQL-defined billable metrics | Real-time API | Real-time balance burndown; late-event window (~34 days); thresholds & commits; no historical backfill |
| **Lago** | Event + `transaction_id` idempotency | REST/batch/SDK + Kafka/Redpanda/Kinesis/S3; 100 events/request | Open-source engine; native **prepaid credits/wallets**; credit-consumption alerts; aggregation = count/sum/max/latest/count_unique/weighted/custom |
| **Orb** (Adyen) | SQL billable metrics | API, Segment, S3/GCS | Prepaid credit blocks with per-block expiry; threshold invoicing mid-cycle; per-event idempotency window |
| **AWS CUR 2.0** | *Not* a metering API — a billing **export** | AWS-side, up to ~24h latency; split cost allocation rows per pod | Reconciles in-cluster estimates against the actual bill (Kubecost-style tolerance ≈3%) |
| **OpenCost / Kubecost** | Reads CUR via Athena; computes allocation from in-cluster telemetry | n/a — derived | Allocation is *estimate vs actual* reconciliation; OpenCost is CNCF incubating (Oct 2024) |

Key structural difference: **Stripe/Metronome/Lago/Orb all rate continuously in their own engine.** PayPal's UBB has the same shape (metrics + aggregation types + charge models + tiers), so the *gap in A2 is small*. The gap is A3.### A3. The reconciliation problem (VERIFIED where a doc exists)

**Documented patterns across the industry:**

1. **Invoice in arrears.** Stripe flex billing, Lago, Orb and PayPal UBB all bill *after* the period closes, so late events are expected rather than exceptional.
2. **Late/backdated meter events.** Stripe documents a **35-day** event submission window; Metronome documents ~34 days. Events outside the window are rejected rather than silently re-rated.
3. **Mid-cycle proration.** PayPal UBB explicitly supports two billing-time models: `CALENDAR` ("billing cycle at the first day of the week/month/year — **billed with proration**") and `ANNIVERSARY` ("billing cycle based on the specific date the subscription started — **billed fully**"). Charge models `STANDARD`/`GRADUATED`/`VOLUME` give graduated/volume tiering within a period.
4. **Credits and voids.** PayPal UBB: `POST /v1/credit-notes` (with `credit_amount` vs `refund_amount`, so a credit can sit on the customer balance rather than being returned) + `POST /v1/credit-notes/{id}/void`. Lago/Orb: prepaid credit blocks that can be expired or voided; usage after a credit is exhausted draws on the payment method.
5. **Threshold invoicing.** PayPal `POST /v1/alerts` (consumption thresholds), Stripe flex billing thresholds, Orb threshold invoicing, Lago credit-consumption alerts — all let the *billing engine* cut an invoice mid-period rather than waiting for period end.
6. **Rounding to nearest unit.** **NOT VERIFIED anywhere for PayPal.** No `rounding` key exists in PayPal's UBB schema. Stripe/Lago/Orb expose unit/aggregation precision at the metric definition layer. **This is a concrete, buildable gap.**
7. **Estimated vs actual.** **NOT VERIFIED for PayPal.** PayPal UBB has no estimate/actual flag on an event. AWS CUR + Kubecost solve this by reconciling a real-time estimate against the delayed authoritative bill.
8. **Disputes.** PayPal's **Disputes v1** (`/v1/customer/disputes`) is a *separate* product from UBB; there is **no** dispute object inside the UBB schema. A disputed metered invoice therefore has no native link back to the meter events that produced it. **VERIFIED gap.**

**INFERENCE:** A "metered-billing reconciliation layer for agents" — closing the invoice, then ingesting late events, re-rating, and issuing a credit note via `POST /v1/credit-notes` — is precisely the seam PayPal leaves open, and it is a legitimate hackathon build.

---

## PART B — PAYPAL'S AGENTIC COMMERCE PUSH

### B4. Product inventory (VERIFIED via https://developer.paypal.com/ai-tools/agent-tools.md)

**PayPal Developer MCP Server** — remote endpoint **`https://mcp.paypal.com/sse`** (SSE transport). The full tool inventory in the official reference is:

- *Catalog*: `create_product`, `list_product`, `show_product_details`
- *Disputes*: `list_disputes`, `get_dispute`, `accept_dispute_claim`
- *Invoices*: `create_invoice`, `list_invoices`, `get_invoice`, `send_invoice`, `send_invoice_reminder`, `cancel_sent_invoice`, `generate_invoice_qr_code`
- *Payments*: `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`
- *Reporting*: `get_merchant_insights`, `list_transaction`
- *Shipment*: `create_shipment_tracking`, `get_shipment_tracking`, `update_shipment_tracking`
- *Subscriptions*: `create_subscription`, `create_subscription_plan`, `list_subscription_plans`, `show_subscription_details`, `show_subscription_plan_details`, `update_subscription`, `cancel_subscription`
- *Remote-MCP commerce extras* (opt-in via header `x-feature-flags: commerce:true`, **gift cards only**): `search_product`, `create_cart`, `checkout_cart`

**Capability matrix for the brief's five questions:**

| Capability | MCP support | REST support |
|---|---|---|
| Create payment/approval link autonomously | `create_order` → `pay_order` | Orders v2 `/v2/checkout/orders` + `/capture` |
| Check order status | `get_order` | `GET /v2/checkout/orders/{id}` |
| Issue refunds | `create_refund`, `get_refund` | `POST /v2/payments/refunds` |
| Create invoices | `create_invoice` + send/reminder/void/QR | Invoicing v2 |
| **Disburse funds** | **NO payout tool exists** | Payouts v2 `POST /v2/payments/payouts` |
| **Record metered usage** | **NO usage/meter tool exists** | **YES — UBB v1 `POST /v1/events`** |

That final row is the thesis: **the MCP layer cannot meter, and the UBB layer cannot be driven by an agent.**

**Other agentic products (VERIFIED names; see Part B5 URLs):**
- **PayPal Agent Toolkit** — https://github.com/paypal/agent-toolkit (TypeScript, Apache-2.0).
- **PayPal Agent Skills** — packaged MCP skills for enterprise (Oct 2026).
- **PayPal MCP Gateway** — enterprise MCP gateway with identity/policy (Oct 2026).
- **PayPal Agent Ready** (paypal.ai) — merchant-side enablement; **Store Sync** (catalog → AI channels), **WebMCP** (site-embedded agent tools), and the Agent Ready section of the developer "AI tools" docs.
- **PayPal AI SDK** — **NOT VERIFIED as a distinct product name.** Closest verified artifacts are the Agent Toolkit (TS) and Agent Skills packages; the "Python/TypeScript" framing could not be confirmed from a primary PayPal source.
- **Agent Commerce Protocol (ACP)** — **NOT VERIFIED as a PayPal endpoint.** ACP is Microsoft's spec (agents + merchants); PayPal is positioned as a participant in partner protocols, but no PayPal ACP endpoint is documented. **Do not claim ACP support in a submission.**
- **x402** — **NOT VERIFIED.** No PayPal x402 endpoint or integration found. Same caution.

### B5. What PayPal publicly pushes (VERIFIED)

- **PayPal AI Hackathon** — https://developer.paypal.com/community/blog/PayPal_AI_Hackathon — Oct 1 – Nov 12 2026; winners Dec 21 2026; **$67,500 total prizes**. Prize category **"Best Use of Agentic Commerce" = $5,000**. Requirements: public repo + LICENSE, <3-minute YouTube video, runnable demo. The prize is **small** relative to the total, so the strategic value is the API grant, not the money. Other categories cover broader AI apps.
- PayPal's stated thesis: AI agents are a **new commerce channel**, and PayPal's role is to be the **payment rail that agents transact on** while the buyer remains in control at the approval step.
- PayPal's own framing of Agent Ready: a merchant can become discoverable and purchasable by AI agents using the **existing PayPal account** — **no additional integration required**.
- PayPal's own framing of the MCP server: it exposes merchant operations (catalog, invoices, orders, refunds, disputes, subscriptions) as tools so an agent can act on a merchant's behalf.

### B6. Agents paying via PayPal today (VERIFIED / partially INFERENCE)

- **Perplexity "Instant Buy"** — PayPal-powered checkout inside Perplexity, launched **Nov 25 2025** as an early Agent Ready partner.
- **Microsoft Copilot Checkout** — PayPal as a payment option inside Copilot's checkout experience, **Jan 2026**.
- **Google** — Conversational Commerce / UCP surfaces; **Mastercard Agent Pay** pilot for agent-initiated payouts.
- **ChatGPT / OpenAI** — PayPal positioned as a payment option in agentic checkout; rollout status fluctuates.

**INFERENCE on what's missing:** every one of these is **consumer checkout** — a buyer approving a cart. None of them is an **agent buying metered API capacity on the agent's own authority** with a reconciliation trail. PayPal's own MCP server has no metered-usage tool, so an agent that wants to buy "10 GB of image generation" has no PayPal-native way to express it, price it, or settle it.

### B7. Agent identity / delegation model (VERIFIED + INFERENCE)

- **VERIFIED:** In PayPal's agentic checkout flow, the **agent creates the order; the human buyer approves it in PayPal** (or the agent captures a pre-approved token). The MCP `pay_order` tool captures an *already-authorized* order — it does not itself grant spending authority.
- **VERIFIED:** There is **no PayPal API for agent spending limits, mandates, or approval policies.** The strings `spend_limit`, `mandate`, `delegat`, `approval_policy` do not appear in the MCP tool reference, and no such endpoint exists in the documented REST surface.
- **VERIFIED:** Third-party hackathon repos (e.g. `purse`, `allowance`, `auctara`, `approvd`, `permit`) implement spending-limit mandates **in the application layer**, because PayPal exposes no primitive for it.
- **INFERENCE:** the fastest legitimate hackathon build is therefore an **agent-side spending mandate service** (per-agent token, per-merchant cap, per-day budget, human-in-the-loop escalation) that sits *in front of* PayPal and records every delegated payment as a usage event via `POST /v1/events` — reconciling spend against cap after the fact. That is the bridge between Part A and Part B, and it uses only VERIFIED PayPal endpoints.

---

## Explicitly NOT VERIFIED — do not assert these

1. PayPal having **no** metered-billing endpoint — **FALSE**; UBB v1 exists.
2. A distinct **PayPal AI SDK** with Python + TypeScript bindings — not confirmed by a primary source.
3. PayPal **ACP** endpoint support — not documented.
4. PayPal **x402** support — not documented.
5. A PayPal-native **spending-limit / mandate / delegation-policy** API — does not exist.
6. PayPal UBB **rounding**, **estimated-vs-actual**, **late-event window**, and **invoice-amendment** semantics — not documented anywhere in the schema or reference.
7. A link between **UBB invoices** and **Disputes v1** — no native link found.

## Recommended submission angle (INFERENCE)

Build the **reconciliation + delegation layer** nobody has: an agent-spend mandate service (caps, budget burn-down, human escalation) that emits PayPal UBB meter events via `POST /v1/events`, re-rates late usage, closes the invoice, and issues corrections via `POST /v1/credit-notes` — with every agent payment recorded as a first-class usage event so it reconciles against a PayPal invoice instead of vanishing into a checkout log. Demo it on the **Usage Based Billing sandbox** (`api-m.sandbox.paypal.com`), not the Orders sandbox.

**Word count:** ~1,720.
