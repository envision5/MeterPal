"use client";

import { useState } from "react";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Check } from "lucide-react";

type Feedback = {
  planId: string;
  kind: "error" | "info";
  message: string;
};

export function PlanCard() {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { data: customer, attach } = useCustomer();
  const { data: plansData } = useListPlans();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // useListPlans unwraps response.list — data is already the plan array.
  const plans: any[] = Array.isArray(plansData)
    ? plansData
    : ((plansData as any)?.list ?? (plansData as any)?.plans ?? []);
  const currentPlanId = (customer as any)?.subscriptions?.[0]?.planId;

  async function onSwitch(planId: string) {
    setPendingId(planId);
    setFeedback(null);
    try {
      const result: any = await attach({ planId });
      const checkoutUrl =
        result?.paymentUrl ??
        result?.payment_url ??
        result?.checkout_url ??
        result?.url;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        // No checkout URL means the server applied the plan without any
        // payment action.  In a PayPal-native setup that means the buyer's
        // PayPal subscription was already active, so there was nothing left
        // to buy — the plan is live now.
        setFeedback({
          planId,
          kind: "info",
          message:
            "Plan updated — your PayPal subscription is already active, so there was nothing to pay.",
        });
      }
    } catch (e: any) {
      setFeedback({
        planId,
        kind: "error",
        message: e?.message ?? "Failed to switch plan",
      });
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
          const planFeedback = feedback?.planId === plan.id ? feedback : null;
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
              {planFeedback && (
                <p
                  role={planFeedback.kind === "error" ? "alert" : "status"}
                  data-testid={`plan-card-feedback-${plan.id}`}
                  className={[
                    "mt-2 text-xs",
                    planFeedback.kind === "error"
                      ? "text-red-600"
                      : "text-muted-foreground",
                  ].join(" ")}
                >
                  {planFeedback.message}
                </p>
              )}
            </article>
          );
        })}
    </div>
  );
}
