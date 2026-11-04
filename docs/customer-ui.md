# Customer-Facing UI — Design for the LiteLLM + MeterPal Billing Layer

This is the third and final piece of the architecture. With `plan.md` (the wallet/billing backend) and `bridge.md` (the inference gateway integration) in place, the missing layer is the **end-customer account UI** — the widget inside your apps that shows "you have 1,247 credits", the modal for topping up, the usage history, the upgrade button.

MeterPal does not ship this UI. LiteLLM ships an *operator* dashboard (`gateway/litellm/ui/litellm-dashboard/`) — Next.js 16 + shadcn + TanStack Query — but it is for *you* (the SaaS owner), not for your end users. The end-customer UI is yours to build, and the good news is that MeterPal's React SDK (`autumn-js`) ships the data hooks so you only have to write the components.

This document designs those components, with code that drops into any Next.js / React / Vite / Remix app.

---

## 1. What you are building

Five components cover 95% of the surface every customer expects from a metered AI product. They live in a reusable package, e.g. `apps/billing-ui/`, that each of your apps imports.

| Component | Purpose | Where it shows |
| --- | --- | --- |
| `<CreditsBadge />` | "1,247 credits remaining" pill, refreshes every 5s | Top-right of every chat UI, every IDE panel, every mobile app |
| `<LowBalanceBanner />` | Yellow/red banner at 20% / 10% / 0% balance with deep link to top-up | Below the badge when balance is low |
| `<PlanCard />` | Current plan + plan picker (upgrade/downgrade) | Account settings → Plan |
| `<TopUpModal />` | One-click purchase of a credit pack via PayPal Checkout | Triggered from the banner or the Plan page |
| `<UsageHistoryPanel />` | Per-day / per-model / per-request usage breakdown | Account settings → Usage |
| `<CostTooltip />` | "Why did this cost 4 credits?" popover | On every assistant message that was billable |

All six are React components that wrap `autumn-js` hooks. No backend code lives in the UI — every action goes through LiteLLM (for inference) and MeterPal (for billing). The UI is a thin view layer.

## 2. The data layer (already shipped by `autumn-js`)

The `autumn-js` package at `billing/packages/autumn-js/` exports:

| Export | Path | What it does |
| --- | --- | --- |
| `useCustomer(params)` | `src/react/hooks/useCustomer.ts` | Returns `{ data: Customer, attach, previewAttach, check, cancel, openCustomerPortal, refetch, ... }` |
| `useListPlans()` | `src/react/hooks/useListPlans.ts` | Returns `{ data: Product[] }` |
| `useListEvents({ customer_id, range })` | `src/react/hooks/useListEvents.ts` | Returns usage events |
| `useAggregateEvents({ customer_id, range })` | `src/react/hooks/useAggregateEvents.ts` | Returns aggregated usage |
| `useEntity({ customer_id, entity_id })` | `src/react/hooks/useEntity.ts` | For per-seat / per-workspace sub-accounts |
| `useReferrals()` | `src/react/hooks/useReferrals.ts` | Referral program state |
| `AutumnClient` | `src/react/client/AutumnClient.ts` | Lower-level HTTP client (for non-React contexts) |
| `useAutumnClient()` | `src/react/AutumnContext.ts` | Provider hook for the MeterPal client |

Install with `bun add autumn-js` or `npm install autumn-js`. Wrap your app in `<AutumnProvider backendUrl="https://api.your-saas.com" identify={(user) => user.id} />` once at the root.

The hooks are built on TanStack Query (`@tanstack/react-query`), so they ship caching, retry, optimistic updates, and `staleTime` controls out of the box.

## 3. The provider setup

Add this to your app root:

```tsx
// app/layout.tsx (Next.js App Router) or src/main.tsx (Vite)
"use client";
import { AutumnProvider } from "autumn-js/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true },
  },
});

export function Providers({ children, user }: { children: React.ReactNode; user: { id: string } }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AutumnProvider
        // point at the MeterPal server you deployed
        backendUrl={process.env.NEXT_PUBLIC_AUTUMN_URL!}
        // identifies the customer — call this with your app's authenticated user
        identify={async () => ({ customerId: user.id, customerData: { name: user.name, email: user.email } })}
      >
        {children}
      </AutumnProvider>
    </QueryClientProvider>
  );
}
```

`backendUrl` points at the MeterPal server (`billing/server/`, port 8080 in dev, your prod URL in production). `identify` is what maps your app's session to a MeterPal `customer_id` — MeterPal will auto-create the customer on first call.

For LiteLLM, the request flow inside the UI is:

```tsx
// app/chat/page.tsx — example
async function sendMessage(message: string) {
  // 1. ask MeterPal if the user has credits (admission check via the LiteLLM CustomLogger
  //    in bridge.md — the LiteLLM proxy already does this server-side, so the UI doesn't
  //    need to. The UI only checks for display.)
  const { allowed, balance } = await autumn.check({
    customerId: user.id,
    featureId: "ai_tokens",
  });

  if (!allowed) {
    setShowLowBalanceBanner(true);
    return;
  }

  // 2. call LiteLLM with the customer's virtual key (read from MeterPal on session start)
  const response = await fetch(`${LITELLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${customer.litellm_virtual_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: message }],
      user: user.id,   // propagated to MeterPal /check via the bridge
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  // 3. consume the stream, render the response, then refresh the credits badge
  // (the actual debit happens server-side via the bridge's async_log_success_event)
  await consumeSSE(response);
  refetchBalance();
}
```

The LiteLLM virtual key is fetched from MeterPal on session-start and cached in memory:

```tsx
// hooks/useLitellmKey.ts
import { useCustomer } from "autumn-js/react";

export function useLitellmKey(userId: string) {
  const { data: customer } = useCustomer({ customerId: userId });
  // custom field you added to the MeterPal customer row via the migration in bridge.md
  return customer?.litellm_virtual_key as string | undefined;
}
```

## 4. The five components

### 4.1 `<CreditsBadge />`

```tsx
// components/billing/CreditsBadge.tsx
"use client";
import { useCustomer } from "autumn-js/react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function CreditsBadge({ customerId }: { customerId: string }) {
  const { data: customer, isLoading } = useCustomer({ customerId });

  if (isLoading) return <Skeleton className="h-6 w-32" />;

  // expand=["balances.feature"] returns balance per feature
  const balance = customer?.balances?.find((b: any) => b.feature_id === "ai_tokens");
  const remaining = balance?.remaining ?? 0;
  const max = balance?.max ?? 0;
  const pct = max > 0 ? remaining / max : 0;
  const formatted = formatCredits(remaining);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        pct > 0.2
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : pct > 0.1
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "bg-red-500/10 text-red-700 dark:text-red-300",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", pct > 0.2 ? "bg-emerald-500" : pct > 0.1 ? "bg-amber-500" : "bg-red-500")} />
      <span>{formatted} credits</span>
      <span className="text-muted-foreground">/ {formatCredits(max)}</span>
    </div>
  );
}

function formatCredits(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
}
```

Wire it into your chat header:

```tsx
// app/chat/page.tsx
import { CreditsBadge } from "@/components/billing/CreditsBadge";

export default function ChatHeader() {
  const { user } = useAuth();
  return (
    <header className="flex items-center justify-between">
      <h1>Your chat</h1>
      <CreditsBadge customerId={user.id} />
    </header>
  );
}
```

`useCustomer` refetches every 5 seconds (per the `staleTime` config) and on window focus. For instant updates after a model call, call `customer.refetch()` after the response completes — or set `staleTime: 0` if your chat is high-frequency.

### 4.2 `<LowBalanceBanner />`

```tsx
// components/billing/LowBalanceBanner.tsx
"use client";
import { useCustomer } from "autumn-js/react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

export function LowBalanceBanner({ customerId }: { customerId: string }) {
  const { data: customer } = useCustomer({ customerId });
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const balance = customer?.balances?.find((b: any) => b.feature_id === "ai_tokens");
  const pct = balance && balance.max > 0 ? balance.remaining / balance.max : 1;

  if (pct > 0.2) return null;

  const level = pct === 0 ? "critical" : pct < 0.1 ? "danger" : "warning";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border px-4 py-3",
        level === "warning" && "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        level === "danger" && "border-orange-500/50 bg-orange-500/10 text-orange-900 dark:text-orange-100",
        level === "critical" && "border-red-500/50 bg-red-500/10 text-red-900 dark:text-red-100",
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="flex-1 text-sm">
        {level === "critical"
          ? "You've run out of credits. Add more to continue."
          : level === "danger"
          ? `Only ${formatCredits(balance!.remaining)} credits left (${(pct * 100).toFixed(0)}%).`
          : `${formatCredits(balance!.remaining)} credits remaining — top up to avoid interruptions.`}
      </p>
      <Button
        size="sm"
        variant={level === "critical" ? "default" : "outline"}
        onClick={() => document.dispatchEvent(new CustomEvent("open-topup-modal"))}
      >
        Add credits
      </Button>
      <Button size="icon" variant="ghost" onClick={() => setDismissed(true)}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

Dispatching a custom DOM event lets the `<TopUpModal />` listen at the app root and open in response — no prop-drilling, no context required.

### 4.3 `<PlanCard />`

```tsx
// components/billing/PlanCard.tsx
"use client";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Check } from "lucide-react";
import { useState } from "react";

export function PlanCard({ customerId }: { customerId: string }) {
  const { data: customer, attach } = useCustomer({ customerId });
  const { data: plans } = useListPlans();
  const [pending, setPending] = useState<string | null>(null);

  const currentProductId = customer?.products?.[0]?.id;

  async function onSwitch(planId: string) {
    setPending(planId);
    try {
      const result = await attach({
        productId: planId,
        dialog: (url: string) => window.open(url, "_blank"),
      });
      if (result.checkout_url) window.location.href = result.checkout_url;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans?.map((plan: any) => {
        const isCurrent = plan.id === currentProductId;
        return (
          <Card key={plan.id} className={isCurrent ? "border-primary" : ""}>
            <CardHeader>
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>{plan.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                ${plan.prices?.[0]?.amount ?? 0}
                <span className="text-sm font-normal text-muted-foreground">/mo</span>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {plan.features?.map((f: any) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" /> {f.name}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button
                className="w-full"
                disabled={isCurrent || pending === plan.id}
                variant={isCurrent ? "outline" : "default"}
                onClick={() => onSwitch(plan.id)}
              >
                {isCurrent ? "Current plan" : pending === plan.id ? "Switching..."..." : "Switch to " + plan.name}
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
```

`useCustomer().attach` returns either `{ success: true }` (immediate switch for downgrades / upgrades within the same billing cycle) or `{ checkout_url }` (redirect to PayPal Checkout for new subscriptions). The component handles both cases.

### 4.4 `<TopUpModal />`

```tsx
// components/billing/TopUpModal.tsx
"use client";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

const TOPUP_PRODUCTS = ["topup_1k", "topup_5k", "topup_25k"];

export function TopUpModal() {
  const { data: customer, attach } = useCustomer({ customerId: useUserId() });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => setOpen(true);
    document.addEventListener("open-topup-modal", handler);
    return () => document.removeEventListener("open-topup-modal", handler);
  }, []);

  async function onTopUp(productId: string) {
    setPending(productId);
    try {
      const result = await attach({ productId });
      if (result.checkout_url) window.location.href = result.checkout_url;
      else setOpen(false); // success, refresh balance automatically via refetch
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credits</DialogTitle>
          <DialogDescription>Choose how many credits to add. Charges to your saved payment method.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {TOPUP_PRODUCTS.map((id) => (
            <Button
              key={id}
              variant="outline"
              className="h-auto justify-between py-3"
              disabled={pending === id}
              onClick={() => onTopUp(id)}
            >
              <span className="font-semibold">{creditLabel(id)} credits</span>
              <span className="text-muted-foreground">{priceLabel(id)}</span>
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

The `topup_1k` / `topup_5k` / `topup_25k` are products you pre-create in MeterPal via `POST /products` with `type: "topup"`, `price: { amount: 10, ... }`, and a `credit_system` feature grant of 1000 / 5000 / 25000. Configure them once in the merchant dashboard, then any app can sell them via this modal.

You can also configure **auto-top-up** in MeterPal per customer (`internal/balances/autoTopUp/setup/`). When balance falls below the threshold, MeterPal's own cron creates a PayPal invoice and charges the saved payment method. The `<LowBalanceBanner />` should still show as a courtesy, but the user will be auto-billed if they ignore it.

### 4.5 `<UsageHistoryPanel />`

```tsx
// components/billing/UsageHistoryPanel.tsx
"use client";
import { useAggregateEvents, useListEvents } from "autumn-js/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function UsageHistoryPanel({ customerId }: { customerId: string }) {
  const { data: aggregates } = useAggregateEvents({
    customerId,
    range: { start: startOfMonth(), end: endOfMonth() },
  });
  const { data: events } = useListEvents({
    customerId,
    range: { start: startOfMonth(), end: endOfMonth() },
    limit: 50,
  });

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>This month, by model</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Credits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(aggregates ?? []).map((row: any) => (
                <TableRow key={row.feature_id}>
                  <TableCell>{row.feature_id}</TableCell>
                  <TableCell className="text-right">{row.value.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent requests</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">In / Out</TableHead>
                <TableHead className="text-right">Credits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(events ?? []).map((evt: any) => (
                <TableRow key={evt.id}>
                  <TableCell>{new Date(evt.timestamp).toLocaleString()}</TableCell>
                  <TableCell>{evt.properties?.model_id ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {evt.properties?.input_tokens ?? 0} / {evt.properties?.output_tokens ?? 0}
                  </TableCell>
                  <TableCell className="text-right">{evt.value.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

This panel pulls from MeterPal's `/events` and `/aggregate` endpoints via the React hooks — no separate analytics store needed for the basic view. If you later want richer analytics (time-series charts, cost-per-user segmentation), MeterPal's MotherDuck pipeline + the LiteLLM `LiteLLM_DailyUserSpend` table are both queryable.

### 4.6 `<CostTooltip />`

```tsx
// components/billing/CostTooltip.tsx
"use client";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

export function CostTooltip({ usage }: { usage: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number } }) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted">
          4 credits
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{usage.model}</div>
          <div className="flex justify-between"><span>Input tokens</span><span>{usage.input_tokens}</span></div>
          <div className="flex justify-between"><span>Output tokens</span><span>{usage.output_tokens}</span></div>
          {usage.cache_read_tokens > 0 && (
            <div className="flex justify-between text-emerald-600"><span>Cached reads</span><span>{usage.cache_read_tokens}</span></div>
          )}
          {usage.cache_write_tokens > 0 && (
            <div className="flex justify-between text-amber-600"><span>Cache writes</span><span>{usage.cache_write_tokens}</span></div>
          )}
          <div className="flex justify-between border-t pt-1 font-medium"><span>Total</span><span>${usage.cost_usd.toFixed(4)}</span></div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
```

Append the per-request usage chunk to your chat-message metadata so the next render shows the tooltip. The bridge already records this data in MeterPal's `events.properties` block, so you could also fetch from there, but the per-message render is faster.

## 5. The setup, in order

1. **Install the SDK.** `bun add autumn-js @tanstack/react-query`. Add shadcn components for Dialog, Card, Button, Table, Alert, HoverCard.

2. **Wrap your app root** in `<AutumnProvider>` and `<QueryClientProvider>` (Section 3).

3. **Mount the components.** Drop `<CreditsBadge />` in every app header. Add `<LowBalanceBanner />` below the badge in the same header. Add `<TopUpModal />` once at the root. Add `<PlanCard />` and `<UsageHistoryPanel />` to your account settings page.

4. **Set up the top-up products.** In the MeterPal merchant dashboard (`billing/vite/`):
   - Create three `topup_1k`, `topup_5k`, `topup_25k` products with `type: "topup"` and a one-time PayPal price.
   - Each one grants a `credit_system` balance of 1000 / 5000 / 25000 credits on purchase.
   - The `ai_tokens` feature with `type: "credit_system"` and your per-model `credit_schema` already exists (see `plan.md` step 5).

5. **Configure auto-top-up.** Per customer in the MeterPal dashboard, set `auto_topup_enabled: true`, `auto_topup_threshold: 100 credits`, `auto_topup_amount: 1000 credits`. MeterPal's cron handles the rest.

6. **Wire LiteLLM.** Your apps already use the LiteLLM virtual key for inference (per `bridge.md` Section 8, step 8). The bridge in `bridge.md` handles all the credit deduction server-side — the UI doesn't need to.

7. **Test the flow.** Sign up a test customer in MeterPal. Use the app until credits run low. Click "Add credits" → `<TopUpModal />` opens → click `topup_5k` → PayPal Checkout → pay → return to app → `<CreditsBadge />` shows 5000 credits within 2 seconds.

## 6. Optional: the LiteLLM operator dashboard integration

If you want the customer UI inside the LiteLLM admin UI (`gateway/litellm/ui/litellm-dashboard/`), the same components work. The dashboard is a Next.js 16 app with shadcn, so the patterns above drop in directly. Wrap its root layout with `<AutumnProvider>`, then add the customer-facing components under a new `app/customers/[id]/usage/page.tsx` route. The operator sees the same `<UsageHistoryPanel />` they see when they log in as that customer.

You can also add a new admin-side panel that calls `useListEvents` across all customers to show aggregate platform spend. MeterPal's `/events/aggregate` endpoint with no `customer_id` filter returns the org-wide totals.

## 7. What you do not build

The UI reuses so much existing surface that the net-new code is small. The five components above are ~400 LOC total. The setup steps above are mostly MeterPal dashboard configuration, not engineering.

What you explicitly do not need to build, because MeterPal already shipped it:

- **A billing database.** MeterPal owns the schema, the migrations, the PayPal sync, the ledger.
- **A webhook handler.** MeterPal receives PayPal webhooks, allocates credits on `PAYMENT.CAPTURE.COMPLETED`, and fires `usage_alert` webhooks at configured thresholds.
- **A price registry.** MeterPal stores `model_id` → credit cost and reads `models.dev` for live prices.
- **A customer CRUD UI.** MeterPal has `useCustomer` with `getOrCreate`, `update`, `delete` baked in.
- **A checkout page.** `apps/checkout/` ships with MeterPal; or use `<TopUpModal />` + the SDK's `attach()` for in-app purchases.

What you explicitly do not need to build, because LiteLLM already shipped it:

- **An inference gateway.** LiteLLM handles provider routing, rate limits, retries, streaming, and now (via the bridge) credit deduction.
- **A virtual key management UI.** LiteLLM has `/key/*` endpoints; the bridge in `bridge.md` mints and blocks them per MeterPal customer lifecycle.
- **A spend analytics database.** `LiteLLM_SpendLogs` and `LiteLLM_DailyTeamSpend` are queryable for admin reporting.

## 8. Where every piece lives

| Path | Purpose |
| --- | --- |
| `docs/plan.md` | Wallet / billing layer architecture |
| `docs/bridge.md` | LiteLLM ↔ MeterPal bridge code and file map |
| `docs/customer-ui.md` | This document |
| `billing/packages/autumn-js/src\react\hooks\` | `useCustomer`, `useListPlans`, `useListEvents`, `useAggregateEvents`, `useEntity`, `useReferrals` |
| `billing/packages/autumn-js/src\react\client\` | `AutumnClient` for non-React contexts |
| `gateway/litellm/ui/litellm-dashboard/` | LiteLLM operator dashboard (Next.js 16 + shadcn) — same component primitives work here |
| `billing/vite/src\views\` | Merchant-side React component patterns (TanStack Query + shadcn) — copy the visual style |

The visual design language is shadcn-style on both sides — same `cn()` utility, same Card/Dialog/Button primitives, same color tokens. The customer-facing UI feels native to both the LiteLLM admin and the MeterPal merchant dashboards because they share a common ancestor.