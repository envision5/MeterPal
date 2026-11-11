# @meterpal/sdk

**MeterPal's SDK for TypeScript.** Two halves, usable together or apart:

- **The inference client** — an OpenAI-shaped `chat.completions` call that is
  admitted against the end user's wallet, metered per token, and charged before
  the response comes back. This is the "one import" promise.
- **The React billing components** — credits badge, low-balance banner, plan
  cards, PayPal top-up modal and usage history, for the end user's account page.

Metering and admission control happen in the MeterPal gateway; money moves
through PayPal (Orders v2 for credit packs, Subscriptions for plans).

## Install

Not on npm yet. Install it from this repo:

```bash
# from a sibling app, with the SDK checked out at ../meterpal
bun add file:../meterpal/sdk/typescript     # or npm / pnpm / yarn
```

`dist/` is committed, so the package resolves immediately — no build step for
you. (After changing `src/`, rebuild with `bun run build`.)

Peers for the React components only: `react` 18/19, `react-dom`,
`@tanstack/react-query` v5.

## The inference client

```ts
import { createMeterPal, InsufficientBalanceError } from "@meterpal/sdk";

// Server-side only. Never ship this key to the browser.
const meterpal = createMeterPal({
	apiKey: process.env.METERPAL_SECRET_KEY!,
	baseURL: process.env.METERPAL_BASE_URL, // omit for https://api.meterpal.dev
});

const completion = await meterpal.chat.completions.create({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "hi" }],
	user: "cus_123",              // the end user being billed — required
});

completion.meterpal.credits_charged;   // what this call cost
completion.meterpal.balance_after;     // their balance once it settled
```

Streaming has the same shape; the charge arrives on the final chunk:

```ts
for await (const chunk of meterpal.chat.completions.stream({ ...params })) {
	if (chunk.meterpal) console.log("charged", chunk.meterpal.credits_charged);
}
```

A `402` surfaces as a typed error carrying the way out:

```ts
try {
	await meterpal.chat.completions.create(params);
} catch (error) {
	if (error instanceof InsufficientBalanceError) {
		const checkout = await error.topUp();   // { url, id }
		redirect(error.customerId, checkout.url);
	}
}
```

The secret key is exchanged for a per-customer virtual key on first use and
cached, so one merchant's traffic can never spend another merchant's budget.
Unknown end users are created on first use — no setup step.

Also on the client: `meterpal.models.list()` (the merchant's served catalog with
prices) and `meterpal.keys.provision(customerId)`.

## The React components

The browser never holds a secret: components read credits, plans and usage
through your app's own backend routes.

**1. Mount the backend routes** (secret key stays server-side):

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

| Component | Props | Notes |
|---|---|---|
| `CreditsBadge` | `featureId?`, `pollIntervalMs?` | ok/warn/danger tones by remaining % |
| `LowBalanceBanner` | `featureId?`, `thresholds?`, `onAddCredits?` | warn <20%, danger <10%, critical 0 |
| `PlanCard` | — | renders plans from `useListPlans()`, switches via PayPal checkout |
| `TopUpModal` | `productIds?`, `labels?`, `prices?` | opens on the `open-topup-modal` DOM event |
| `UsageHistoryPanel` | `featureId?`, `rangeStart?`, `rangeEnd?`, `limit?` | by-model totals + recent requests |
| `CostTooltip` | usage object | pure-presentational per-request breakdown |

## The CLI

```bash
bunx meterpal init            # detects your framework, writes .env + a handler
bunx meterpal init --help     # every option
```

It detects Next, Express, Hono, Fastify and plain Node, writes the environment
and a server-side handler that keeps the secret key off the browser, and prints
the snippet to start from. It is deterministic: it does not guess, it installs a
known-good integration for the framework it found.

## Testing locally

Against this repo's own stack (see `docs/JUDGE-TESTING.md`):

```bash
# unit tests — no stack, no network (httpx/mocked fetch)
bun run test
bun run lint

# live: one metered call, one stream, one refusal, one paywall
export METERPAL_SECRET_KEY=$(grep '^PAB_API_KEY=' ../../gateway/.env | cut -d= -f2)
export METERPAL_BASE_URL=http://localhost:8080
bun run scripts/live-check.ts
```

`METERPAL_BASE_URL` is the billing server, not the gateway: the billing server
proxies `/v1/chat/completions` to the metered gateway, so the SDK only ever
talks to one host.

## Development

```bash
bun install
bun run test     # vitest (happy-dom)
bun run lint     # tsc --noEmit
bun run build    # tsup -> dist/ (dist is committed; rebuild after src changes)
```
