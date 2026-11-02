"use client";

import { useCustomer } from "autumn-js/react";
import { cn, findCustomerBalance, formatCredits } from "../lib/utils";

interface CreditsBadgeProps {
  featureId?: string;
  /** Refresh interval in ms.  Default 5000 (5s). */
  pollIntervalMs?: number;
}

export function CreditsBadge({
  featureId = "ai_tokens",
  pollIntervalMs = 2_500,
}: CreditsBadgeProps) {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { data: customer, isLoading } = useCustomer({
    queryOptions: { refetchInterval: pollIntervalMs },
  });

  if (isLoading) return <div className="h-6 w-32 animate-pulse rounded-full bg-muted" />;

  const balance = findCustomerBalance(customer, featureId);
  const remaining = balance?.remaining ?? 0;
  const max = balance?.granted ?? 0;
  if (balance?.unlimited) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="credits-badge"
        className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>unlimited credits</span>
      </div>
    );
  }
  const pct = max > 0 ? remaining / max : 0;

  const tone =
    pct > 0.2 ? "ok" : pct > 0.1 ? "warn" : "danger";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="credits-badge"
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "bg-red-500/10 text-red-700 dark:text-red-300",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          tone === "ok" && "bg-emerald-500",
          tone === "warn" && "bg-amber-500",
          tone === "danger" && "bg-red-500",
        )}
      />
      <span className="tabular-nums">{formatCredits(remaining)} credits</span>
      <span className="text-muted-foreground">/ {formatCredits(max)}</span>
    </div>
  );
}