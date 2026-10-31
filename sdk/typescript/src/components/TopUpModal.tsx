"use client";

import { useEffect, useState } from "react";
import { useCustomer } from "autumn-js/react";
import { X } from "lucide-react";

interface TopUpModalProps {
  /** Top-up product ids, ordered small → large.  Configure in your MeterPal catalog. */
  productIds?: string[];
  /** Human-readable labels for each product (matched by index). */
  labels?: string[];
  /** Prices in USD (matched by index). */
  prices?: number[];
}

const DEFAULT_PRODUCTS = ["topup_1k", "topup_5k", "topup_25k"];
const DEFAULT_LABELS = ["1,000 credits", "5,000 credits", "25,000 credits"];
const DEFAULT_PRICES = [10, 45, 200];

export function TopUpModal({
  productIds = DEFAULT_PRODUCTS,
  labels = DEFAULT_LABELS,
  prices = DEFAULT_PRICES,
}: TopUpModalProps) {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { attach } = useCustomer();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-topup-modal", handler as EventListener);
    return () => window.removeEventListener("open-topup-modal", handler as EventListener);
  }, []);

  async function onTopUp(productId: string) {
    setPending(productId);
    setError(null);
    try {
      const result: any = await attach({ planId: productId });
      const checkoutUrl =
			result?.paymentUrl ??
			result?.payment_url ??
			result?.checkout_url ??
			result?.url;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        setOpen(false);
      }
    } catch (e: any) {
      setError(e?.message ?? "Top-up failed");
    } finally {
      setPending(null);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="topup-title"
      data-testid="topup-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="bg-background rounded-xl border border-border shadow-xl w-full max-w-md p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 id="topup-title" className="text-lg font-semibold">
              Add credits
            </h2>
            <p className="text-sm text-muted-foreground">
              Choose a credit pack — you'll approve the payment with PayPal.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded p-1 hover:bg-muted"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 grid gap-2" data-testid="topup-options">
          {productIds.map((id, i) => (
            <button
              key={id}
              type="button"
              onClick={() => onTopUp(id)}
              disabled={pending !== null}
              data-testid={`topup-option-${id}`}
              className="flex items-center justify-between rounded-md border border-border px-4 py-3 hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed text-left"
            >
              <span className="font-medium">{labels[i] ?? id}</span>
              <span className="text-muted-foreground">${prices[i] ?? "—"}</span>
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}