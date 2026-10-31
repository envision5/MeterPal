# @meterpal/sdk

Customer-facing billing components + client for **MeterPal** — the
PayPal-native AI usage-billing SDK. Drop these into any React app to give
your end users a credits balance, PayPal top-ups, plan switching and usage
history. All money moves through PayPal (Orders v2 for credit packs,
Subscriptions for plans); metering happens in your MeterPal gateway.

## Install

```bash
bun add @meterpal/sdk        # or npm / pnpm / yarn
```

Peers: `react` 18/19, `react-dom`, `@tanstack/react-query` v5.

## Quickstart

**1. Mount the backend routes** (secret key never reaches the browser):

```ts
// express
import { autumnBackend } from "autumn-js/backend";
app.use("/api/autumn", autumnBackend({ secretKey: process.env.METERPAL_SECRET_KEY! }));
```

**2. Wrap your app** with the provider:

```tsx
import { AutumnProvider } from "autumn-js/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

<QueryClientProvider client={queryClient}>
  <AutumnProvider backendUrl="">  {/* same-origin */}
    <App />
  </AutumnProvider>
</QueryClientProvider>
```

**3. Mount the components:**

```tsx
import {
  CreditsBadge,        // pill: remaining / max credits (polls every 5s)
  LowBalanceBanner,    // warning banner + "Add credits" CTA
  PlanCard,            // plan grid with PayPal checkout redirect
  TopUpModal,          // credit packs -> PayPal approval
  UsageHistoryPanel,   // per-model credits + recent metered requests
} from "@meterpal/sdk";

export function AccountBilling() {
  return (
    <>
      <LowBalanceBanner onAddCredits={() => window.dispatchEvent(new Event("open-topup-modal"))} />
      <CreditsBadge />
      <PlanCard />
      <UsageHistoryPanel />
      <TopUpModal />
    </>
  );
}
```

**4. Standalone client** (no components):

```ts
import { createMeterPalClient } from "@meterpal/sdk";

const billing = createMeterPalClient({ backendUrl: "" });
const customer = await billing.getOrCreateCustomer({ customer_id: "cus_123" });
```

## How billing works

1. Your end user hits your app → your app calls your MeterPal gateway.
2. The gateway pre-authorizes every AI call against the user's credit
   balance (`POST /v1/check`) and returns **HTTP 402 before the model is
   called** when the balance is too low.
3. After each call the gateway meters actual token usage and debits the
   wallet idempotently (`/track_tokens`).
4. When the user buys credits or subscribes through these components, PayPal
   collects the money and the `PAYMENT.CAPTURE.COMPLETED` /
   `BILLING.SUBSCRIPTION.ACTIVATED` webhooks credit the wallet instantly.

## Components

| Component | Props | Notes |
|---|---|---|
| `CreditsBadge` | `featureId?`, `pollIntervalMs?` | ok/warn/danger tones by remaining % |
| `LowBalanceBanner` | `featureId?`, `thresholds?`, `onAddCredits?` | warn <20%, danger <10%, critical 0 |
| `PlanCard` | — | renders plans from `useListPlans()`, switches via PayPal checkout |
| `TopUpModal` | `productIds?`, `labels?`, `prices?` | opens on the `open-topup-modal` DOM event |
| `UsageHistoryPanel` | `featureId?`, `rangeStart?`, `rangeEnd?`, `limit?` | by-model totals + recent requests |
| `CostTooltip` | usage object | pure-presentational per-request breakdown |

Customer identity is resolved server-side by the `autumn-js/backend`
adapter — the browser never holds a secret.

## Development

```bash
bun install
bun run test     # vitest (happy-dom)
bun run lint     # tsc --noEmit
bun run build    # tsup -> dist/
```
