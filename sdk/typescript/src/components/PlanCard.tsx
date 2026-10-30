"use client";

import { useState } from "react";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Check } from "lucide-react";

interface PlanCardProps {
  customerId: string;
}

export function PlanCard({ customerId }: PlanCardProps) {
  const { data: customer, attach } = useCustomer({ customerId });
  const { data: plans } = useListPlans();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentProductId = (customer as any)?.products?.[0]?.id;

  async function onSwitch(planId: string) {
    setPendingId(planId);
    setError(null);
    try {
      const result: any = await attach({ productId: planId });
      if (result?.checkout_url) {
        window.location.href = result.checkout_url;
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to switch plan");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="plan-card-grid">
      {(plans as any[])?.map((plan: any) => {
        const isCurrent = plan.id === currentProductId;
        const priceUsd = (plan.prices?.[0]?.amount ?? 0) / 100;
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
              <span className="text-sm font-normal text-muted-foreground">/mo</span>
            </div>
            <ul className="mt-4 space-y-2 text-sm">
              {(plan.features ?? []).map((f: any) => (
                <li key={f.id} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-primary" aria-hidden />
                  {f.name}
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