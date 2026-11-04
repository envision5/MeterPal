# Investigate

First read the `autumn-concepts` knowledge — it defines Autumn's data model — customers, entities, plans, balances, subscriptions — which every finding must be explained in terms of.

## Goal

- Answer "what happened and why" using three sources: current account state (customer, plan, balance lookup tools), the usage-event store (`aggregateEvents` — usage totals, last usage, usage over time), and the request-log interface (`searchRequestLogs`, `queryRequestLogs`).
- End with a conclusion the user can act on: a timeline of what happened, the cause when the logs show it, and a clear statement of what the logs cannot show when they don't.
- Logs record API requests and processor webhook deliveries — each entry is one request with its payload and response. They do not expose Autumn's internal processing, so conclusions must come from observable requests, responses, and state.

## Workflow

You MUST follow this order for every investigation.

1. **Anchor the investigation.** Resolve three things before querying logs:
   - *Who*: a `customer_id` (resolve names or emails with customer lookup tools), plus `entity_id` if the customer uses entities and one is identified.
   - *When*: an explicit time window. Convert relative phrasing ("this month", "since their renewal") into concrete dates before querying.
   - *What*: the expected vs. actual behavior, in one sentence. "Customer was charged twice; expected once."
   If the user gave no customer and no path scope, ask one concise question for the missing anchors instead of scanning broadly. Ask all missing anchor questions together.
2. **Check current state first.** `getCustomer` (balances, subscriptions, invoices) often answers "what is" instantly; logs answer "what happened". For discrepancy reports, fetch state first so you know what the timeline must explain.
3. **Locate the incident window.** Run one cheap `queryRequestLogs` aggregate bucketed with `bin(timestamp, ...)` to find *when* the relevant activity happened (see Two-pass pattern). Never start with a broad record listing.
4. **Drill into the window.** Use `searchRequestLogs` with a narrow range around the buckets that matter, and inspect `request_body` / `response_body` on the returned records.
5. **Load the matching domain reference** (below) before drilling into billing, balance, or webhook specifics — each defines the paths, payload fields, and scenario recipes for its domain.
6. **Report.** Lead with the answer, then a short timestamped timeline, then the time range and filters used, then any uncertainty.

## Two-pass pattern

Heavy list queries over wide ranges waste calls and truncate. Locate first, then inspect.

**Pass A — locate (queryRequestLogs).** Bucket counts over the widest allowed range:

```
where customer_id == 'cus_123' | summarize failed = countif(status_code >= 400), total = count() by bin(timestamp, 1d) | order by timestamp desc
```

**Pass B — inspect (searchRequestLogs).** Bound the range to the interesting bucket(s), list full records (always pass an explicit `range` — the 30-minute default silently misses most windows):

```
where customer_id == 'cus_123' and status_code >= 400 | order by timestamp desc | limit 50
```

If Pass A returns nothing, widen the range or change the predicate — do not run Pass B blind. If Pass A surfaces several windows, run Pass B once per window.

## Tool selection and ranges

- `searchRequestLogs` — returns matching request records with full payloads. Stages: `where`, `order by`, `limit`. Range is capped at **7 days per call** and defaults to only **30 minutes**, so always pass an explicit `range`.
- `queryRequestLogs` — returns aggregate rows. Stages: `where`, `summarize`, `project`, `order by`, `limit`. Range is capped at **30 days** when the query filters `customer_id`, **15 days** otherwise; it defaults to the cap.
- `limit` is capped at 200 on both. To cover more than 7 days of records, page `searchRequestLogs` through consecutive windows — or better, aggregate with `queryRequestLogs` and only list the windows that matter.

## Query language

Queries use a restricted pipeline syntax. Treat this section as the complete grammar — anything not listed here is rejected.

- Stages, joined by `|`: `where`, `summarize`, `project`, `order by <field> asc|desc`, `limit <n>`.
- Predicates: `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `startswith`, `in ('a', 'b')`, combined with `and` / `or` and parentheses. String literals use single quotes.
- Aggregations (each needs an alias, e.g. `total = count()`): `count()`, `countif(<predicate>)`, and `sum` / `avg` / `min` / `max` / `percentile` over `status_code` or a numeric `request_body.*` / `response_body.*` path.
- Grouping: `by <field>, ...` on any field, a `request_body.*` / `response_body.*` dot path, or `bin(timestamp, <interval>)` with intervals like `15m`, `1h`, `6h`, `1d`.
- Nested payload access: dot paths under `request_body` and `response_body` only, at most 4 segments (`response_body.balance.remaining`). No brackets, functions, comments, or raw APL.

Queryable fields:

- `timestamp`, `source`, `status_code`
- `request_method`, `request_url`, `request_path`, `request_body`, `response_body`
- `org_id`, `customer_id`, `entity_id`
- `processor_event_id`, `processor_event_type`, `processor_object_id`

`source` is `api_request` (paths under `/v1`) or `processor_webhook` (processor webhook deliveries). Filtering `request_body contains '...'` or `response_body contains '...'` matches against the JSON text of the whole payload — useful when the exact field path is unknown.

Do not reference fields outside this list. If a fact is not in these fields, say the log interface does not expose it.

Frequent mistakes the endpoint rejects:

- Free text or `*` as the whole query. There is no full-text search — filter with `where request_body contains 'text' or response_body contains 'text'`.
- Invented fields like `body`, `feature_id`, or `status`. Use the listed fields, or a dot path such as `request_body.feature_id`.
- `summarize` or `project` sent to `searchRequestLogs` — aggregate stages only run on `queryRequestLogs`.
- Ranges beyond the cap. Split long periods into consecutive windows instead of retrying with the same range.

## Rules

- Always pass an explicit `range` — the search default of 30 minutes silently misses almost everything.
- Prefer structured filters (`customer_id`, `request_path`, `processor_event_type`, `status_code`) over payload `contains` scans; use `contains` only to discover where a value appears, then switch to a precise filter.
- One filter change at a time. When a query returns nothing, loosen exactly one constraint (range, then path, then predicate) so you know which one hid the records.
- Distinguish *no matching records* from *proof of absence*: say which range and filters returned nothing, and offer to widen.
- Never present an internal-processing guess as a finding. The logs show requests, responses, and webhook deliveries — if the explanation requires Autumn's internal state (background jobs, cache, processing errors), say so and suggest the user contact Autumn support with the customer ID and time window.
- Never describe this interface as public API documentation, and do not invent endpoints from it.

## Domain references

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

# Balance and Usage Investigations

Read this when investigating: denied checks (`allowed: false`), balance or credit discrepancies, usage totals, resets that didn't happen, rollovers, or 402/429 responses on check/track.

## Contents

- Balance request paths
- Response shapes: check, track, customer snapshot
- Status-code signals
- Scenario recipes: denied check, usage totals, missing reset, balance timeline, rollover drops

## Balance request paths

| Action | RPC path | Legacy REST |
|--------|----------|-------------|
| Check feature access | `/v1/balances.check` | `/v1/check`, `/v1/entitled` |
| Track usage | `/v1/balances.track` | `/v1/track`, `/v1/events` |
| Update balances directly | `/v1/balances.update` | `/v1/balances` |
| Aggregate usage events (`aggregateEvents`) | `/v1/events.aggregate` | — |

Cover both generations with a grouped filter:

```
where customer_id == 'cus_123' and (request_path contains 'balances.' or request_path contains 'check' or request_path contains 'track' or request_path contains 'entitled' or request_path contains 'events') | order by timestamp desc | limit 50
```

Add `entity_id == 'ent_123'` when the question is about one entity — a customer-level check and an entity-level check can legitimately differ, because entity balances are their own grants.

## Response shapes

### Check (`response_body`)

| Field | Meaning |
|-------|---------|
| `allowed` | The main signal — was access granted |
| `balance.granted`, `balance.remaining`, `balance.usage` | Metered/credit numbers at that moment |
| `balance.unlimited`, `balance.overage_allowed`, `balance.next_reset_at` | Modifiers on how remaining is enforced |
| `balance.breakdown` | Per-grant slices: included vs prepaid, each with its own reset/expiry |
| `balance.rollovers` | Rollover lines carried from previous cycles |
| `flag` | Boolean-feature result when there is no balance object |

### Track (`request_body` / `response_body`)

- `request_body`: `feature_id` or `event_name`, `value` (the deduction amount), `customer_id`, `entity_id`.
- `response_body`: the updated balance, or `balances` keyed by feature id when one event touches several features.

### Customer snapshot

`GET /v1/customers/...` responses carry `balances` (keyed by feature id) and `flags` — the best point-in-time snapshot to correlate against checks and tracks. Filter with `request_path contains 'customers'`.

## Status-code signals

| Code | Meaning on check/track |
|------|------------------------|
| 200 | Processed — a denial is `allowed: false` with status 200, not an error status |
| 402 | Insufficient balance to complete the tracked usage |
| 429 | Rate limited |

## Scenario recipes

### "Why was this check denied?"

1. Find the denials:

```
where customer_id == 'cus_123' and response_body.allowed == false | order by timestamp desc | limit 25
```

2. Read `balance.remaining`, `balance.next_reset_at`, and `breakdown` on the denial — they show which grant ran out and when it would have reset.
3. Walk backwards for the tracks that drained it (usage totals recipe below), and check current plan state for whether the feature is granted at all on their plan.

### "How much did they actually use?" / "When was their last usage?" (usage totals)

Use `aggregateEvents` first — it reads the usage-event store (what the dashboard's Usage chart shows), so it sees every tracked event regardless of which endpoint recorded it or log retention. Request logs are the fallback for *why* a track call failed, not for totals.

```
aggregateEvents { customer_id: "cus_123", feature_id: "emails", range: "30d", bin_size: "day" }
```

- `list` is one row per time bin with the summed value per feature; `total` is the overall sum. The latest non-zero bin is the last usage.
- Use `range` (`24h`, `7d`, `30d`, `90d`, `last_cycle`, `1bc` = current billing cycle, `3bc`) or `custom_range` with epoch-millisecond `start`/`end`. Derive the dates from the current date given in the turn, never from memory.
- Add `entity_id` for per-seat/per-resource usage, `group_by: "$entity_id"` to split by entity, or `aggregate_on: "deducted"` to see which balance each event drained.

Compare the total against what the user believes was used or billed. A large single-bin spike usually explains "impossible" usage totals — then list the raw track calls for that window in the request logs to see the individual values:

```
where customer_id == 'cus_123' and request_path contains 'track' | project timestamp, feature = request_body.feature_id, value = request_body.value, remaining = response_body.balance.remaining | order by timestamp asc | limit 100
```

### "Their usage didn't reset this cycle"

1. Find checks straddling the expected reset boundary and compare `response_body.balance.next_reset_at` and `remaining` before vs after:

```
where customer_id == 'cus_123' and (request_path contains 'balances.check' or request_path contains 'check') | order by timestamp asc | limit 100
```

2. If `remaining` never returned to `granted` after `next_reset_at` passed, the reset observably did not apply — correlate with the renewal webhook (`BILLING.SUBSCRIPTION.UPDATED` / `PAYMENT.SALE.COMPLETED`) around the boundary.
3. Resets are internal processing: the logs can show *that* balances didn't reset, not *why*. If state confirms it, report the evidence (timestamps, before/after balances) and escalate to Autumn support.

### Balance timeline

For "where did the credits go", list checks, tracks, and customer snapshots in order and read the balance trajectory from the payloads:

```
where customer_id == 'cus_123' and (request_path contains 'check' or request_path contains 'track' or request_path contains 'customers') | order by timestamp asc | limit 100
```

Project just the trajectory when the full payloads are noisy — note that `project` runs on `queryRequestLogs`:

```
where customer_id == 'cus_123' and request_path contains 'track' | project timestamp, feature = request_body.feature_id, value = request_body.value, remaining = response_body.balance.remaining | order by timestamp asc | limit 100
```

### "Their rollovers disappeared"

Compare `response_body.balance.rollovers` and `breakdown` across checks over time. Rollover drops usually coincide with a plan change — cross-reference the billing timeline reference for attaches or subscription updates at the same timestamp.

## Analytics

For org-wide questions, keep aggregates scoped by time range and avoid broad scans unless asked.

Failed requests by path:

```
where source == 'api_request' and status_code >= 400 | summarize failed = count() by request_path | order by failed desc | limit 20
```

Status-code breakdown over time:

```
summarize requests = count() by status_code, bin(timestamp, 1d) | order by timestamp desc | limit 100
```

Most active customers:

```
where source == 'api_request' | summarize requests = count() by customer_id | order by requests desc | limit 20
```

## Reporting

- Lead with the conclusion, in the user's terms — not query mechanics.
- Follow with a short timeline: timestamp, what happened, which request or webhook shows it.
- State the time range and filters used so the user can trust the scope.
- Include amounts, plan names, and statuses from the payloads when they carry the finding.
- Flag uncertainty explicitly: ranges that may be too narrow, gaps the interface cannot see, or ambiguous records.
