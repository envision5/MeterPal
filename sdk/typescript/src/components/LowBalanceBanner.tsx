"use client";

import { useEffect, useState } from "react";
import { useCustomer } from "autumn-js/react";
import { AlertTriangle, X } from "lucide-react";
import { cn, findCustomerBalance, formatCredits } from "../lib/utils";

interface LowBalanceBannerProps {
  featureId?: string;
  thresholds?: { warn: number; danger: number };
  onAddCredits?: () => void;
}

export function LowBalanceBanner({
  featureId = "ai_tokens",
  thresholds = { warn: 0.2, danger: 0.1 },
  onAddCredits,
}: LowBalanceBannerProps) {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { data: customer } = useCustomer({ queryOptions: { refetchInterval: 5_000 } });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Re-show banner when balance changes significantly (re-mount via key change)
    const bal = findCustomerBalance(customer, featureId);
    if (bal && !bal.unlimited && bal.remaining / Math.max(bal.granted, 1) > thresholds.warn) {
      setDismissed(false);
    }
  }, [customer, featureId, thresholds.warn]);

  if (dismissed) return null;

  const balance = findCustomerBalance(customer, featureId);
  if (!balance || balance.unlimited || balance.granted === 0) return null;

  const pct = balance.remaining / balance.granted;
  if (pct > thresholds.warn) return null;

  const level = pct === 0 ? "critical" : pct < thresholds.danger ? "danger" : "warning";

  return (
    <div
      role="alert"
      data-testid="low-balance-banner"
      className={cn(
        "flex items-center gap-3 rounded-md border px-4 py-3 text-sm",
        level === "warning" && "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        level === "danger" && "border-orange-500/50 bg-orange-500/10 text-orange-900 dark:text-orange-100",
        level === "critical" && "border-red-500/50 bg-red-500/10 text-red-900 dark:text-red-100",
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1">
        {level === "critical"
          ? "You've run out of credits. Add more to continue."
          : level === "danger"
            ? `Only ${formatCredits(balance.remaining)} credits left (${(pct * 100).toFixed(0)}%).`
            : `${formatCredits(balance.remaining)} credits remaining — top up to avoid interruptions.`}
      </p>
      {onAddCredits && (
        <button
          type="button"
          onClick={onAddCredits}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium",
            level === "critical"
              ? "bg-red-600 text-white hover:bg-red-700"
              : "border border-current bg-transparent hover:bg-amber-500/20",
          )}
        >
          Add credits
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}