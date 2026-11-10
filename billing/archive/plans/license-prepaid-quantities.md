# License Prepaid Quantities + Definition Transitions

Handoff doc for branch `john/license-prepaid-quantities` (stacked on
`john/license-attach`, PR #2234). Captures the full design discussion,
every decision + rationale, exact current code state, and remaining work.
Read `.plans/license-model-refactor.md` first for the base model (customer
licenses anchor seats; reconcile = setup → reparent → balances).

## 1. Goal

`billing.attach` (and later update) accepts `license_quantities`: how many
seats of a license plan the customer prepays on the parent plan. Entities
attach seats against that capacity. Billing rides the parent's subscription.

## 2. The billing model (SETTLED)

Per customer license row:

```
items = Σ assigned-seat fixed price rows     (each seat's mint-time snapshot,
                                              the earliest `included` seats free)
      + max(0, paid_quantity − billableUsed) × effective definition price
        where billableUsed = max(0, used − included)
              used         = granted − remaining      (the counter, NEVER COUNT)
              included     = granted − paid_quantity  (not stored; derived)
```

- **Used seats have price memory (their customer_prices snapshot); the
  unassigned buffer has none** — it bills at the link-resolved effective
  price ("what does a unit cost today through this plan_license").
- Same price ⇒ same processor_price_id ⇒ downstream merge collapses seats +
  buffer into ONE processor item. Assignment is processor-neutral unless prices
  drifted.
- `used` DOES affect billing (John's call): future PAYG = overflow take does
  `paid_quantity += N` on the row. Formula unchanged.
- Worked example (verified with John): Pro(included 1, $20, paid 5, used 3)
  → bill 5×$20 ($100: Anna free, Ben+Cara $20, buffer 3×$20). Attach
  Premium(included 2, $40, paid 8): adoption moves the pool, transition
  repoints seats $20→$40, included 2 frees Ben → bill 1×$40 + 7×$40 = $320,
  merging to one $40×8 item. Line items: −$100 prorated, +$320 prorated.

### Grandfathering rules (SETTLED)
- **Catalog edit** (plans.update on license plan): existing seats keep
  snapshots; buffer + future seats at new price. NO migration.
- **Explicit customer transition** (attach upgrade, billing.update patch,
  scheduled activation): pool re-prices uniformly — seats FOLLOW the new
  definition via bulk repoint (see §5). Mixed $20/$40 states exist only
  between transitions.

## 3. Storage (LANDED)

- `customer_licenses.paid_quantity` numeric NOT NULL default 0 — explicitly
  does NOT include the link's `included`. `granted = included + paid_quantity`
  derived in exactly two places (initCustomerLicenses,
  computeCustomerLicenseBalancePlan) — granted never written directly.
  (NOTE: the granted derivation with paid_quantity is NOT yet wired — see §7.1.)
- Why a row column, not jsonb on the parent: atomic PAYG bumps
  (`paid_quantity += N` beside takeAssignment), and it rides adoption with
  the row (transitions carry purchases for free).
- Migration `shared/drizzle/0047_tricky_sharon_carter.sql`: the column + the
  `idx_customer_products_license_seat_order (customer_license_id, created_at,
  id) WHERE customer_license_id IS NOT NULL` partial index (free-seat top-N).
- Migrations 0044–0047 are NOT applied anywhere. John runs `bun db migrate`
  himself (never run DB-mutating commands for him).

## 4. Processor/billing construction (LANDED — the "quantities unit")

Contract: `BillingPriceRow` (shared/models/billingModels/billingPriceRow.ts)
— the scope-agnostic "SQL-constructed billing" shape John wants to extend to
entity products and paid items later:

```ts
{ customerProductId,        // bills under this product's sub/phase bucket
  price, quantity,
  source: { type: "customer_license_seat" | "customer_license_buffer",
            customerLicenseId } }
```

Flow (one SQL query + in-memory math):

- `customerLicenseRepo/listAssignmentBillingPriceRows.ts` — assigned seats'
  customer_prices JOIN prices, GROUP BY price (1M seats → ~20 rows, one
  hash-agg pass, NO window functions, NO sort), excluding the earliest
  `included` seats per license via `NOT IN (per-license LATERAL ORDER BY
  created_at,id LIMIT included)` — index walk on the 0047 index. Rows
  attribute to `cl.parent_customer_product_id` (survives adoption), never
  the seat's stale parent column. `liveSeatSql` predicate = anchored +
  entity + status IN (active, past_due).
- `evaluateProcessorBillingPlan` loads these once (`??=` on
  `billingContext.customerLicenseBillingPriceRows`). Buffer needs NO query.
- `customerProductToCustomerLicenseItemSpecs.ts` (called from
  customerProductToProcessorItemSpecs, so subscription items AND schedule
  phases both inherit): seat rows from context + buffer rows computed
  in-memory per customer license (persisted rows from
  fullCustomer.customer_licenses; freshly planned rows ride the inserted
  product's own customer_licenses — one uniform code path). Rows without
  config.processor_price_id are SKIPPED (processor resource init for license
  products = deferred, John's call: keep simple, priceId-keyed list).
- Buffer prices = the row's hydrated `license.product.prices` — resolved by
  `planLicenseFullProductJson` (customized overlay when set, else pinned
  product's is_custom=false prices). A raw `prices WHERE internal_product_id`
  lateral was a BUG (picked up other customers' custom rows, ignored
  overlay) — fixed; don't regress this.
- Schedules: no parallel license timeline. License rows live/die/adopt with
  the parent, so the parent's phase-bucket membership IS the timeline. Known
  edge (deferred): seat carry-over across a scheduled transition is priced
  as buffer-only in future phases until reconcile adopts; only misprices
  when snapshots differ from the successor price.

Behavior change to watch in tests: seats beyond `included` now produce
subscription items (previously assignments never billed).

## 5. Definition transitions (IN PROGRESS — John auditing step by step)

When a customer-scoped action changes a license's effective definition
($20→$40, 50→100 entitlement), seats follow the pool onto the new terms.

### The op (shared, LANDED)
`CustomerLicenseTransitionSchema` on AutumnBillingPlan:
`{ customerLicenseId, priceTransitions: [{fromPriceId, toPriceId}],
   entitlementTransitions: [{fromEntitlementId, toEntitlementId}] }`
Keyed by the OUTGOING row id — the id seats stay anchored to through
adoption. Field `customerLicenseTransitions` exists on the plan (currently
unwired).

### The pure transitioner (folder: billing/v2/compute/customerLicenseTransitions/)
Target top-level signature (action-agnostic, like initFullCustomerProduct /
buildAutumnLineItems):

```ts
computeCustomerLicenseTransitions({
  fullCustomer, outgoingCustomerProducts, incomingCustomerProducts })
  → CustomerLicenseTransition[]
```

Files + audit status:
- ✅ `customerProductsToCustomerLicenses.ts` (step 1, audited): persisted
  rows from fullCustomer.customer_licenses ∪ planned rows on the products;
  dedupe by row id, PLANNED WINS (update flow: patched picture of the same
  row supersedes DB). Never invents rows; passes license:null through.
- ✅ `pairCustomerLicensesByLicensePlan.ts` (step 2, audited): global
  pairing by license plan PUBLIC id (version-proof, matches adoption's key).
  SAME-ROW pairs allowed (from.id === to.id) — a transition never implies a
  parent change (billing.update case). Duplicate incoming offers:
  first-wins deterministic. Outgoing-driven (incoming-only licenses have no
  seats to move; their billing is the buffer).
- ⏳ `matchPriceSuccessors.ts` (step 3, NOT yet audited/reshaped): currently
  definition-diff (fromProduct.prices → toProduct.prices). Keys: fixed →
  `fixed:{interval}:{interval_count}`; usage → `feature:{internal_feature_id}`
  via the price's entitlement. DECIDED DIRECTION (not yet implemented):
  prefer matching FROM the seats' ACTUAL BillingPriceRows when provided
  (handles mixed grandfathered/customized rows — each real row finds its own
  successor), definition-diff as fallback. Same keys.
- ⏳ `matchEntitlementSuccessors.ts` (step 3): by internal_feature_id.
  REPOINT ONLY — balance semantics (50→100: delta? reset? carry rules?) is
  an OPEN decision; consult transition_rules machinery before inventing.
- ⏳ `computeCustomerLicenseTransitions.ts` (step 4): EXISTS with the OLD
  signature (fromCustomerLicenses/toCustomerLicenses) — must be rewritten to
  the target signature composing steps 1+2+3. Must read SUPER simply.
- `applyCustomerLicenseTransitionsToBillingPriceRows.ts`: the AFTER
  projection — swaps row.price via (customerLicenseId, fromPriceId) map,
  O(rows), pure, idempotent. This is the pre/post "snapshot" mechanism: NO
  in-memory reconcile simulation is ever needed; BillingPriceRow is the
  projection that matters and it's tiny.

### Execution (REVERTED, ownership OPEN — the big remaining decision)
Previously implemented then removed pending John's call:
`executeCustomerLicenseTransitions` + `repointAssignmentItems` (set-based:
`UPDATE customer_prices cp FROM customer_products s SET price_id = to WHERE
cp.customer_product_id = s.id AND s.customer_license_id = X AND
cp.price_id = from`, same for customer_entitlements.entitlement_id).
Re-add with LIVE-SEAT scoping (decision: expired seats keep historical refs).

The consolidation argument (analyzed, leaning yes, NOT confirmed):
- `findReparentCandidate` (reconcile) and the transitioner pair the SAME
  event ("pool follows definition") — pool-half vs seat-half.
- Coverage today if execution stays attach-only: `createSchedule`'s
  IMMEDIATE phase gets no transitions; scheduled downgrades at
  `handleSchedulePhaseChanges` get adoption but seats keep old refs FOREVER.
  Every new action path would have to remember the seat-half
  (afterLicenseMutation lesson).
- Proposal: reconcile's adoption (executeReparentPlan) owns transition
  EXECUTION — per ReparentOp, fetch adopted pools' distinct seat price/ent
  refs (bounded, listAssignmentBillingPriceRows-shaped), match against
  replacedFreshCustomerLicense.license.product with the SAME pure matchers,
  repoint. Fires ONLY on adoption events ⇒ catalog-edit grandfathering
  preserved by construction; idempotent (re-run matches nothing).
  Attach compute keeps ONLY the pure projection (plan op as carrier) for
  Processor AFTER-state + line items; NO second executor.
  Same-parent billing.update transitions have no adoption — that path DOES
  need plan-op execution or an equivalent hook; resolve this asymmetry with
  John before building.

### Transition trigger sites (once ownership settles)
- attach immediate upgrades (planTiming === "immediate" gate; scheduled
  downgrades transition at ACTIVATION, not planning time).
- createSchedule immediate phase (computeImmediatePhaseCustomerProducts).
- billing.update on the parent (patch mints new license price row — confirm
  with John WHICH surface produces the incoming picture; customer-scoped
  license_prices overlay was descoped in CUT 1).
- handleSchedulePhaseChanges via reconcile adoption (if consolidation).

### Evaluate wiring (REVERTED, re-add after audit)
In evaluateProcessorBillingPlan after the rows load: apply
`applyCustomerLicenseTransitionsToBillingPriceRows` with
plan.customerLicenseTransitions + toPriceById from the incoming products'
customer_licenses[].license.product.prices — so the processor sees the AFTER state.

## 6. Line items (NOT built — design settled)

`fixedPriceToLineItem({ context, quantity })` is the confirmed primitive.
`buildCustomerLicenseLineItems`: before-rows → refund lines, after-rows →
charge lines, appended in computeAttachPlan next to buildAutumnLineItems.
PREREQ: the before-rows load must move from evaluate to SETUP
(setupAttachBillingContext) — compute runs before evaluate. LineItemContext
needs product for display: use license.product (buffer) /
productByCustomerLicenseId map, parent product as fallback.

## 7. Remaining work, in order

1. **`license_quantities` attach param** → validated → initCustomerLicenses
   sets `paid_quantity` + `granted = included + paid_quantity`; same
   derivation added to computeCustomerLicenseBalancePlan. Until this lands
   every buffer is 0 and nothing bills — do it FIRST so tests mean anything.
2. Finish transitioner audit: reshape matchers to seats-actual-rows input
   (step 3), rewrite composer to target signature (step 4).
3. Settle execution ownership (§5) with John; re-add repointAssignmentItems
   (live-seat scoped) + wire trigger sites + evaluate AFTER-projection.
4. Setup-loads-rows move + line items lane (§6).
5. Quantity decreases: end-of-cycle; INVESTIGATE
   updateSubscription/compute/updateQuantity/computeUpdateQuantityPlan.ts
   (prepaid feature mechanism) and mirror it vs pending_quantity-on-row +
   phase-aware specs. Decrease floor: John leans REJECT below live seats.
6. Entitlement transition balance semantics (§5 matchers note).
7. Deferred: processor resource init for license products; PAYG overflow take;
   priced-license customer-level gate vs paid_quantity>0; adoption ×
   explicit license_quantities (fresh row's quantity should win over
   carried); used>granted healing; batching repoints only if single
   statements prove slow.

## 8. Invariants & gotchas for the implementing agent

- NEVER enumerate seats: reads are aggregates/top-N; writes are set-based.
  No now-relative time bounds in queries (adjacency is relative to
  successor starts_at — late convergence must work).
- Seats anchor by `customer_license_id` (row id survives adoption); the
  seat's `license_parent_customer_product_id` goes stale — never treat it as
  truth for billing.
- Terminology: never bare "license"/"pool" — customerLicense / planLicense /
  assignment (seat is OK conversationally). paid_quantity excludes included.
- `used = granted − remaining`, never COUNT.
- Effective license prices ONLY via planLicenseFullProductJson semantics.
- Biome: pinned `./node_modules/.bin/biome check --write` on EXACT touched
  files only (never bunx ultracite, never whole dirs — caused two mass-
  revert incidents). `bun ts` in server/ after edits.
- John reviews uncommitted; never commit unless he asks. He audits slowly —
  small steps, discuss before sprawling. Top-level composers must read
  trivially; helpers live in the composer's folder. Check shared-utils
  before inline transforms; ASK before adding new shared utils.
- Integration tests require migrations applied (John runs) + dev server AND
  `bun workers` running. Watch: license-billing-integration,
  license-priced-attach (seats-beyond-included behavior change),
  reconcile-coverage.
