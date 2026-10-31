"use client";

import { useState } from "react";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Check } from "lucide-react";

export function PlanCard() {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { data: customer, attach } = useCustomer();
  const { data: plansData } = useListPlans();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // useListPlans unwraps response.list — data is already the plan array.
  const plans: any[] = Array.isArray(plansData)
    ? plansData
    : ((plansData as any)?.list ?? (plansData as any)?.plans ?? []);
  const currentPlanId = (customer as any)?.subscriptions?.[0]?.planId;

  async function onSwitch(planId: string) {
    setPendingId(planId);
    setError(null);
    try {
      const result: any = await attach({ planId });
      const checkoutUrl =
        result?.paymentUrl ??
        result?.payment_url ??
        result?.checkout_url ??
        result?.url;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to switch plan");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="plan-card-grid">
      {plans
        .filter((plan: any) => !plan.addOn)
        .map((plan: any) => {
          const isCurrent = plan.id === currentPlanId;
          // Autumn plan prices are in major units (dollars).
          const firstItem = plan.items?.[0];
          const priceUsd = firstItem?.price?.amount ?? 0;
          const interval = firstItem?.price?.interval;
          return (
            <article
              key={plan.id}
              data-testid={`plan-card-${plan.id}`}
              className={[
                "rounded-xl border p-5",
                isCurrent ? "border-primary" : "border-border",
              ].join(" ")}
            >
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="text-sm text-muted-foreground">{plan.description}</p>
              <div className="mt-3 text-3xl font-bold">
                ${priceUsd}
                <span className="text-sm font-normal text-muted-foreground">
                  {interval === "month"
                    ? "/mo"
                    : interval === "one_off"
                      ? " once"
                      : ""}
                </span>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {(firstItem?.display?.primaryText
                  ? [firstItem.display.primaryText]
                  : []
                ).map((text: string) => (
                  <li key={text} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" aria-hidden />
                    {text}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={isCurrent || pendingId === plan.id}
                onClick={() => onSwitch(plan.id)}
                className={[
                  "mt-4 w-full px-3 py-2 rounded-md text-sm font-medium",
                  isCurrent
                    ? "border border-border bg-muted text-muted-foreground cursor-default"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                  pendingId === plan.id && "opacity-60 cursor-wait",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {isCurrent
                  ? "Current plan"
                  : pendingId === plan.id
                    ? "Switching..."
                    : `Switch to ${plan.name}`}
              </button>
              {error && pendingId === plan.id && (
                <p role="alert" className="mt-2 text-xs text-red-600">
                  {error}
                </p>
              )}
            </article>
          );
        })}
    </div>
  );
}
