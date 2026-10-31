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
  /**
   * Optional poll callback for popup checkout: called every few seconds while
   * the PayPal popup is open.  Return `{ captured: true }` once the payment
   * has been captured server-side.  When provided, checkout opens in a popup
   * and this modal closes itself on capture — no page redirect.  When
   * omitted, checkout redirects the current tab (relies on PayPal's
   * return_url redirect).
   */
  pollFinalize?: () => Promise<{ captured: boolean; credits?: number } | null>;
  /** Fired after a payment is confirmed captured (popup mode only). */
  onCaptured?: (credits?: number) => void;
}

const DEFAULT_PRODUCTS = ["topup_1k", "topup_5k", "topup_25k"];
const DEFAULT_LABELS = ["1,000 credits", "5,000 credits", "25,000 credits"];
const DEFAULT_PRICES = [10, 45, 200];

export function TopUpModal({
  productIds = DEFAULT_PRODUCTS,
  labels = DEFAULT_LABELS,
  prices = DEFAULT_PRICES,
  pollFinalize,
  onCaptured,
}: TopUpModalProps) {
  // Identity is resolved server-side by the autumn-js backend adapter.
  const { attach } = useCustomer();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awaitingPayment, setAwaitingPayment] = useState(false);

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

      if (!checkoutUrl) {
        setOpen(false);
        return;
      }

      if (pollFinalize) {
        // Popup mode: the app tab stays alive and polls for the capture.
        const popup = window.open(
          checkoutUrl,
          "meterpal-paypal",
          "width=480,height=720",
        );
        setAwaitingPayment(true);
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const res = await pollFinalize();
            if (res?.captured) {
              setAwaitingPayment(false);
              setPending(null);
              setOpen(false);
              onCaptured?.(res.credits);
              return;
            }
          } catch {
            // transient poll errors — keep polling until the deadline
          }
          if (popup?.closed) {
            // one last poll in case capture landed as the popup closed
            try {
              const res = await pollFinalize();
              if (res?.captured) {
                setAwaitingPayment(false);
                setPending(null);
                setOpen(false);
                onCaptured?.(res.credits);
                return;
              }
            } catch {
              // ignore
            }
            break;
          }
        }
        setAwaitingPayment(false);
        setPending(null);
        setError(
          "Payment not confirmed yet — if you completed it in PayPal, your credits will appear shortly.",
        );
        return;
      }

      // Redirect mode (default): PayPal redirects back via return_url.
      window.location.href = checkoutUrl;
    } catch (e: any) {
      setError(e?.message ?? "Top-up failed");
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

        {awaitingPayment && (
          <p className="mt-3 text-sm text-muted-foreground">
            Complete the payment in the PayPal window — this dialog closes when
            your credits arrive.
          </p>
        )}

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