"use client";

import { useEffect, useState } from "react";
import { useCustomer } from "autumn-js/react";
import { AlertTriangle, X } from "lucide-react";
import { cn, formatCredits } from "../lib/utils";

interface LowBalanceBannerProps {
  customerId: string;
  featureId?: string;
  thresholds?: { warn: number; danger: number };
  onAddCredits?: () => void;
}

export function LowBalanceBanner({
  customerId,
  featureId = "ai_tokens",
  thresholds = { warn: 0.2, danger: 0.1 },
  onAddCredits,
}: LowBalanceBannerProps) {
  const { data: customer } = useCustomer({ customerId, queryOptions: { refetchInterval: 5_000 } });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Re-show banner when balance changes significantly (re-mount via key change)
    const bal = (customer as any)?.balances?.find((b: any) => b.feature_id === featureId);
    if (bal && bal.remaining / Math.max(bal.max, 1) > thresholds.warn) {
      setDismissed(false);
    }
  }, [customer, featureId, thresholds.warn]);

  if (dismissed) return null;

  const balance = (customer as any)?.balances?.find((b: any) => b.feature_id === featureId);
  if (!balance || balance.max === 0) return null;

  const pct = balance.remaining / balance.max;
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