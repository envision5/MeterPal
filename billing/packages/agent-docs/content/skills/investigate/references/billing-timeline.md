# Billing Investigations

Read this when investigating: unexpected or duplicate charges, plan changes (attach, upgrade, downgrade), cancellations, checkout, trials, invoices, processor webhook deliveries, or Autumn/processor subscription state drift.

## Contents

- Billing request paths
- Payload fields that matter
- Processor webhook records
- The plan-change timeline recipe
- Classifying billing events
- Scenario recipes: duplicate charge, payment changed, cancel didn't happen, state drift

## Billing request paths

Billing activity is on RPC-style dotted routes; older orgs may also have REST-style calls.

| Action | RPC path | Legacy REST |
|--------|----------|-------------|
| Attach (new plan, upgrade, downgrade) | `/v1/billing.attach` | `/v1/billing/attach`, `/v1/attach` |
| Update (cancel, uncancel, quantity, custom terms) | `/v1/billing.update` | — |
| Multi-attach | `/v1/billing.multi_attach` | — |
| Customer portal | `/v1/billing.open_customer_portal` | — |

Filter with `request_path contains 'billing'` to cover all of them — plus `request_path == '/v1/attach'` for older orgs still on the bare legacy path, which `contains 'billing'` misses. A specific segment like `request_path contains 'billing.attach'` also works.

Processor webhook deliveries are not under `/v1` — they arrive on `/webhooks/paypal/...` and carry `source == 'processor_webhook'`.

## Payload fields that matter

On billing records, inspect:

- `request_body`: plan/product ids, `feature_quantities`, `customize` (customer-specific terms), cancel action, timing fields.
- `response_body`: invoice id and status, `payment_url`, `required_action`, returned customer/entity ids.

Two response signals change how you read an attach:

- `response_body.payment_url` present → the customer was redirected to processor checkout. The attach did **not** execute yet; it completes on the processor side — look for a later `PAYMENT.CAPTURE.COMPLETED` (one-off charge) or `BILLING.SUBSCRIPTION.ACTIVATED` (subscription) webhook. The browser return path (`/paypal/return`) can complete the same attach, and it is not in these logs — its absence is not proof the attach failed.
- A returned invoice with its status shows whether the charge succeeded immediately, was left draft, or required action.

## Processor webhook records

Processor webhook deliveries are log records with `source == 'processor_webhook'`:

| Field | Meaning |
|-------|---------|
| `processor_event_id` | The processor event — one per delivery |
| `processor_event_type` | e.g. `BILLING.SUBSCRIPTION.UPDATED` |
| `processor_object_id` | The object the event is about: subscription, capture, sale, or invoice id |
| `status_code` | Autumn's processing response — `>= 400` means Autumn received the event but failed to process it |
| `request_body` | The delivered processor event payload |

### Event types and what they imply

| Event | Implication for the customer |
|-------|------------------------------|
| `BILLING.SUBSCRIPTION.CREATED` / `BILLING.SUBSCRIPTION.ACTIVATED` / `BILLING.SUBSCRIPTION.RE-ACTIVATED` | New subscription started at the processor; a pending plan attach executed here |
| `BILLING.SUBSCRIPTION.UPDATED` | Subscription changed at the processor — Autumn re-activates and re-links it, so plan access is (re)granted |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Subscription suspended — a failed payment exhausted the processor's retries; access ends |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | A payment on the processor subscription failed — the customer is in a grace state while the processor retries |
| `BILLING.SUBSCRIPTION.CANCELLED` / `BILLING.SUBSCRIPTION.EXPIRED` | Subscription fully ended — plan access ends |
| `PAYMENT.CAPTURE.COMPLETED` | One-off payment succeeded |
| `PAYMENT.SALE.COMPLETED` | Recurring subscription payment succeeded |
| `PAYMENT.CAPTURE.REFUNDED` / `PAYMENT.SALE.REFUNDED` | Payment refunded |
| `PAYMENT.CAPTURE.REVERSED` / `PAYMENT.SALE.REVERSED` | Payment reversed — the funds movement is negative |
| `INVOICING.INVOICE.PAID` | Overage invoice paid |
| `CUSTOMER.DISPUTE.CREATED` / `CUSTOMER.DISPUTE.UPDATED` / `CUSTOMER.DISPUTE.RESOLVED` | Chargeback opened, updated, or resolved — the funds reversal arrives separately as a reversed payment event |
| `CHECKOUT.ORDER.APPROVED` | Customer approved the checkout order — an early signal only; the money event is `PAYMENT.CAPTURE.COMPLETED` |

Only these event types are subscribed to, so anything else is never delivered to Autumn.

### Delivery vs processing

These logs record deliveries that **reached Autumn**. Three distinct failure surfaces:

1. **Delivered and processed** — record with status 200. Normal.
2. **Delivered, processing failed** — record with `status_code >= 400`. Autumn's handling failed; report the event id, type, and time, and escalate to Autumn support.
3. **Never delivered** — no record at all. If an expected event is absent over the right range, the failure is upstream of Autumn: the user should check webhook delivery attempts in their processor dashboard.

Say which of the three the evidence shows; they have different owners.

## Plan-change timeline recipe

Build the timeline from both API-initiated changes and processor-side events, oldest first:

Pass A — find when billing activity happened:

```
where customer_id == 'cus_123' and (request_path contains 'billing' or source == 'processor_webhook') | summarize events = count(), failed = countif(status_code >= 400) by bin(timestamp, 1d) | order by timestamp asc
```

Pass B — list the events in the active window(s):

```
where customer_id == 'cus_123' and (request_path contains 'billing' or source == 'processor_webhook') | order by timestamp asc | limit 100
```

## Classifying billing events

| Record | Meaning |
|--------|---------|
| `billing.attach`, status 200, no `payment_url` | Plan change executed via API (new plan, upgrade, or downgrade) |
| `billing.attach`, status 200, with `payment_url` | Redirected to checkout — not executed; match with a later `PAYMENT.CAPTURE.COMPLETED` or `BILLING.SUBSCRIPTION.ACTIVATED` |
| `billing.update`, status 200 | Cancel/uncancel, quantity change, or custom-terms change — read `request_body` for intent |
| `processor_event_type == 'BILLING.SUBSCRIPTION.ACTIVATED'` | Subscription went active — a pending attach executed here |
| `processor_event_type == 'BILLING.SUBSCRIPTION.UPDATED'` | Subscription changed at the processor — Autumn re-activates it, so plan access is (re)granted |
| `processor_event_type == 'BILLING.SUBSCRIPTION.SUSPENDED'` | Subscription suspended — a failed payment exhausted the processor's retries; access ends |
| `processor_event_type == 'BILLING.SUBSCRIPTION.CANCELLED'` or `'BILLING.SUBSCRIPTION.EXPIRED'` | Subscription fully ended |
| `processor_event_type == 'PAYMENT.CAPTURE.COMPLETED'` or `'PAYMENT.SALE.COMPLETED'` | Payment succeeded |
| `processor_event_type == 'INVOICING.INVOICE.PAID'` | Overage invoice paid |
| Billing call with `status_code >= 400` | Failed action — read `response_body` for the error; 402 means payment required/failed |

Changes made directly in the processor dashboard or billing portal never appear as Autumn API calls — only as the webhook deliveries they trigger. A timeline with subscription webhooks but no billing API calls means the change originated on the processor side.

## Scenario recipes

### "Customer was charged twice"

1. List billing calls and invoice webhooks around the charge time:

```
where customer_id == 'cus_123' and (request_path contains 'billing' or processor_event_type startswith 'PAYMENT.') | order by timestamp asc | limit 100
```

2. Repeated `billing.attach` calls with near-identical `request_body` close together suggest client-side retries; compare their `response_body` invoice ids to see which created charges.
3. Multiple `PAYMENT.CAPTURE.COMPLETED` (or `PAYMENT.SALE.COMPLETED`) webhooks for different invoice ids on the same day are separate charges — trace each `processor_object_id` to what created it.

### "Why did their payment change this month?"

1. Run the plan-change timeline over the current and previous cycle.
2. Look for: an attach/update with different plan or quantities, a `PAYMENT.CAPTURE.COMPLETED`, a `BILLING.SUBSCRIPTION.UPDATED` (a scheduled change at the processor), or a trial ending.
3. Compare `request_body.feature_quantities` and `customize` across attaches — custom terms and quantity changes are the usual silent causes.

### "They canceled but are still active" (or the reverse)

1. Find the cancel: `billing.update` with a cancel intent in `request_body`, or a portal cancellation arriving as `BILLING.SUBSCRIPTION.CANCELLED`.
2. Cancel-at-period-end keeps the subscription active until the cycle ends — check current state for a scheduled cancelation before treating it as a bug.
3. If a `billing.update` cancel returned an error status, that is the cause — report the response error.

### "Autumn and the processor are out of sync"

1. Fetch current Autumn state (`getCustomer`) and note the subscription/plan it shows.
2. Build the webhook timeline for the customer (see Processor webhook records). Find the last event that should have produced the expected state.
3. If that event's delivery shows `status_code >= 400`, Autumn received but failed to process it — report the failing delivery with its timestamp and event id, and escalate to Autumn support.
4. If the expected event never appears, the processor may not have delivered it — the user should check the webhook delivery attempts in their processor dashboard.
