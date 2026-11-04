# SDK Documentation Update Plan

## Overview

Update the Documentation section (`mintlify/documentation/`) to match the new v2 API types and SDK conventions.

**Goal**: Update code examples to match new types. DO NOT change content/explanations.

---

## Rules

> **⚠️ CRITICAL: ONE FILE AT A TIME**
> 
> Never edit more than one file per phase. Complete each phase fully before moving to the next.

### Casing Conventions

| Context | Casing | Example |
|---------|--------|---------|
| TypeScript/Node.js SDK | camelCase | `customerId`, `featureId`, `productId` |
| Python SDK | snake_case | `customer_id`, `feature_id`, `product_id` |
| cURL / Raw API | snake_case | `customer_id`, `feature_id`, `product_id` |
| JSON examples (SDK response) | camelCase | `{ "featureId": "...", "createdAt": 123 }` |

### Key API Changes

1. `attach()` - if `attach.checkoutUrl` is defined, redirect (React hook auto-opens)
2. `check`, `track`, `attach` NO LONGER auto-create customers
3. Customer object: `products` → `subscriptions`, `features` → `balances`
4. Hook returns `data` not `customer`
5. Component library removed (`CheckoutDialog`, `PricingTable`, `PaywallDialog`)
6. Method rename: `openBillingPortal` → `openCustomerPortal`

### Reference Files (read these for correct types)

- Hook params: `packages/autumn-js/src/react/hooks/<hookName>.ts`
- Client params: `packages/autumn-js/src/types/params.ts`
- SDK types: `packages/sdk/src/models/`

---

## Phases

### Phase 1: `documentation/getting-started/setup/react.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Line 7: Remove reference to `/react/components/pricing-table`
- [ ] Line 353: Change `const { customer } = useCustomer()` → `const { data } = useCustomer()`
- [ ] Line 359: Change `customer` → `data`
- [ ] Lines 370-433: Update JSON example:
  - snake_case → camelCase (`created_at` → `createdAt`, `processor_invoice_id` → `processorInvoiceId`, etc.)
  - `products` → `subscriptions`
  - `features` → `balances`
- [ ] Lines 444-470: Remove `checkout` method with `CheckoutDialog` - replace with `attach()` flow
- [ ] Lines 446, 453: Remove `CheckoutDialog` import and usage
- [ ] Lines 490-493: Remove `<PricingTable />` reference and link

---

### Phase 2: `documentation/getting-started/setup/sdk.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 167-169: TypeScript `checkout` params: `customer_id` → `customerId`, `product_id` → `productId`
- [ ] Lines 225-228: TypeScript `attach` params: `customer_id` → `customerId`, `product_id` → `productId`

*Note: Python and cURL examples stay snake_case*

---

### Phase 3: `documentation/getting-started/gating.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 53-57: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`, `required_balance` → `requiredBalance`
- [ ] Lines 119-123: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`

---

### Phase 4: `documentation/getting-started/display-billing.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 20-26: Change `customer?.products` → `data?.subscriptions`
- [ ] Lines 84-88: Change `customer?.features.messages` → `data?.balances.messages`
- [ ] Lines 37-47: TypeScript SDK: verify `customers.get` returns correct structure
- [ ] Lines 133-155: Remove `checkout` with `CheckoutDialog` - use `attach()` flow instead
- [ ] Lines 138-155: Remove `CheckoutDialog` import and usage
- [ ] Lines 238-244: Verify `cancel` method exists on hook or remove
- [ ] Line 297: Change `openBillingPortal` → `openCustomerPortal`
- [ ] Lines 348-354: Fix analytics hook - verify correct import (`useAggregateEvents`)

---

### Phase 5: `documentation/customers/check.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 47-50: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`
- [ ] Lines 79-92: JSON response: convert to camelCase (`feature_id` → `featureId`, etc.)
- [ ] Lines 124-128: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`, `required_balance` → `requiredBalance`
- [ ] Lines 174-179: TypeScript SDK params: add `sendEvent` (camelCase)
- [ ] Lines 225-229: TypeScript SDK params: camelCase

---

### Phase 6: `documentation/customers/tracking-usage.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 23-28: Fix TypeScript import pattern (`import { Autumn }` not `import { Autumn as autumn }`)
- [ ] Lines 25-28: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`
- [ ] Lines 60-66: JSON response: convert to camelCase
- [ ] Lines 81-86: Fix TypeScript import and params
- [ ] Lines 163-168: Fix TypeScript import and params

---

### Phase 7: `documentation/customers/balances.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 29-32: Fix TypeScript import pattern
- [ ] Lines 47-72: JSON response: convert to camelCase (`feature_id` → `featureId`, `included_usage` → `includedUsage`, `next_reset_at` → `nextResetAt`)

---

### Phase 8: `documentation/customers/creating-customers.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 17-70: Update/collapse accordion - clarify that `attach`, `track`, `check` NO LONGER auto-create customers. Add note about using `autumn.customers.getOrCreate()`
- [ ] Lines 88-89: Fix TypeScript import pattern

---

### Phase 9: `documentation/customers/enabling-product.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 37-40: TypeScript SDK params: `customer_id` → `customerId`, `product_id` → `productId`
- [ ] Lines 57-73: JSON response: convert to camelCase (`checkout_url` → `checkoutUrl`, `customer_id` → `customerId`, `product_ids` → `productIds`)
- [ ] Lines 76-79: Remove/update tip about auto-customer creation

---

### Phase 10: `documentation/customers/feature-entities.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 54-60: Fix TypeScript import and params: `feature_id` → `featureId`
- [ ] Lines 112-118: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`, `entity_id` → `entityId`
- [ ] Lines 166-171: TypeScript SDK params: camelCase
- [ ] Lines 219-228: React example: fix `entity_data` → `entityData`, ensure `featureId` (already camelCase - verify)
- [ ] Lines 231-241: TypeScript SDK params: camelCase, fix `entity_data` → `entityData`
- [ ] Lines 316-318: Fix TypeScript method call pattern

---

### Phase 11: `documentation/customers/managing-customers.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 93-100: Fix TypeScript import pattern
- [ ] Lines 95-100: Verify `customers.update` method signature and params

---

### Phase 12: `documentation/pricing/credits.mdx`

**Status**: ⬜ Not Started

**Changes**:
- [ ] Lines 54-66: TypeScript SDK params: `customer_id` → `customerId`, `feature_id` → `featureId`, `required_balance` → `requiredBalance`
- [ ] Lines 101-127: JSON response: convert to camelCase
- [ ] Lines 142-153: TypeScript SDK params: camelCase

---

### Phase 13: Final Review

**Status**: ⬜ Not Started

**Tasks**:
- [ ] Run through all changed files
- [ ] Verify no broken links
- [ ] Check that `docs.json` navigation is correct
- [ ] Ensure consistency across all examples

---

## Files NOT Requiring Changes

These files are mostly conceptual with no SDK code examples:

- `documentation/pricing/plans.mdx`
- `documentation/pricing/features.mdx`
- `documentation/pricing/plan-features.mdx`
- `documentation/pricing/rewards.mdx` (cURL only - snake_case correct)
- `documentation/pricing/versioning.mdx`
- `documentation/getting-started/setup/convex.mdx` (skip for now per instructions)

---

## Quick Reference: Common Replacements

### TypeScript SDK Params
```
customer_id    → customerId
feature_id     → featureId
product_id     → productId
entity_id      → entityId
required_balance → requiredBalance
send_event     → sendEvent
event_name     → eventName
customer_data  → customerData
entity_data    → entityData
```

### JSON Response Fields
```
feature_id     → featureId
customer_id    → customerId
product_id     → productId
created_at     → createdAt
updated_at     → updatedAt
started_at     → startedAt
canceled_at    → canceledAt
processor_invoice_id → processorInvoiceId
included_usage → includedUsage
next_reset_at  → nextResetAt
checkout_url   → checkoutUrl
product_ids    → productIds
event_id       → eventId
```

### Customer Object Structure
```
customer.products  → data.subscriptions
customer.features  → data.balances
```

### Hook Method Names
```
openBillingPortal → openCustomerPortal
```

---

## Progress Tracker

| Phase | File | Status |
|-------|------|--------|
| 1 | `getting-started/setup/react.mdx` | ⬜ |
| 2 | `getting-started/setup/sdk.mdx` | ⬜ |
| 3 | `getting-started/gating.mdx` | ⬜ |
| 4 | `getting-started/display-billing.mdx` | ⬜ |
| 5 | `customers/check.mdx` | ⬜ |
| 6 | `customers/tracking-usage.mdx` | ⬜ |
| 7 | `customers/balances.mdx` | ⬜ |
| 8 | `customers/creating-customers.mdx` | ⬜ |
| 9 | `customers/enabling-product.mdx` | ⬜ |
| 10 | `customers/feature-entities.mdx` | ⬜ |
| 11 | `customers/managing-customers.mdx` | ⬜ |
| 12 | `pricing/credits.mdx` | ⬜ |
| 13 | Final Review | ⬜ |

Legend: ⬜ Not Started | 🔄 In Progress | ✅ Complete
