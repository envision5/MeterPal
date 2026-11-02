"use client";

import { useEffect, useRef, useState } from "react";
import { useAutumnClient } from "autumn-js/react";
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
  /**
   * In-page PayPal Buttons mode (recommended): the PayPal JS SDK renders its
   * buttons inside this modal — no redirect and no host-managed popup, so the
   * app page never navigates away.  `capture` is called from onApprove with
   * the order id; return `{ captured: true }` once the server has captured
   * and credited the wallet.
   */
  inPageCheckout?: {
    clientId: string;
    /** Resolve with `{ captured: true }` once the server has captured and
     *  credited the wallet.  The billing server's native shape
     *  `{ status: "captured", credits }` is accepted too. */
    capture: (orderId: string) => Promise<{
      captured: boolean;
      credits?: number;
      status?: string;
    }>;
  };
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
  inPageCheckout,
}: TopUpModalProps) {
  // Identity is resolved server-side by the autumn-js backend adapter.
  // NOTE: we call the client directly — the useCustomer().attach() hook
  // auto-redirects the page to payment_url, which would defeat the in-page
  // and popup checkout modes.
  const client = useAutumnClient({ caller: "TopUpModal" });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awaitingPayment, setAwaitingPayment] = useState(false);
  const [inPageActive, setInPageActive] = useState(false);
  const buttonsRef = useRef<HTMLDivElement | null>(null);
  const pendingProductId = useRef<string | null>(null);
  // The PayPal order is FIXED at pack-click time (Stripe-session parity):
  // createOrder hands PayPal this exact order and never mints a new one.
  // Re-clicks and sandbox overlay loops re-approve the same order, whose
  // capture is idempotent server-side — one click can never double-charge.
  const pendingOrderId = useRef<string | null>(null);

  // Closing the modal ends the purchase flow: drop the pending order and
  // reset the buttons so reopening renders them fresh.
  useEffect(() => {
    if (open) return;
    setInPageActive(false);
    pendingProductId.current = null;
    pendingOrderId.current = null;
  }, [open]);

  // Load the PayPal JS SDK once per client id.
  function loadPayPalSdk(clientId: string): Promise<any> {
    const w = window as any;
    if (w.paypal?.Buttons) return Promise.resolve(w.paypal);
    return new Promise((resolve, reject) => {
      const id = `paypal-sdk-${clientId.slice(0, 12)}`;
      if (document.getElementById(id)) {
        // already loading — wait for window.paypal
        const t = setInterval(() => {
          if (w.paypal?.Buttons) { clearInterval(t); resolve(w.paypal); }
        }, 200);
        setTimeout(() => clearInterval(t), 15000);
        return;
      }
      const el = document.createElement("script");
      el.id = id;
      el.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&disable-funding=credit`;
      el.onload = () => (w.paypal?.Buttons ? resolve(w.paypal) : reject(new Error("PayPal SDK loaded without Buttons")));
      el.onerror = () => reject(new Error("Failed to load the PayPal SDK"));
      document.head.appendChild(el);
    });
  }

  // Render in-page Buttons once the pack is chosen in inPage mode.
  useEffect(() => {
    if (!inPageActive || !inPageCheckout || !buttonsRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const paypal = await loadPayPalSdk(inPageCheckout.clientId);
        if (cancelled || !buttonsRef.current) return;
        buttonsRef.current.innerHTML = "";
        paypal
          .Buttons({
            style: { layout: "vertical", height: 45 },
            createOrder: async (): Promise<string> => {
              // Never mint here.  The order was created when the pack was
              // clicked; handing PayPal a fresh order on every createOrder
              // (overlay loops, extra clicks) is what allowed one purchase
              // to double-charge.
              if (pendingOrderId.current) return pendingOrderId.current;
              const productId = pendingProductId.current;
              if (!productId) throw new Error("no pack selected");
              const result: any = await client.attach({ planId: productId });
              const checkoutUrl =
                result?.paymentUrl ??
                result?.payment_url ??
                result?.checkout_url ??
                result?.url;
              const orderId = checkoutUrl
                ? new URL(checkoutUrl).searchParams.get("token")
                : null;
              if (!orderId) throw new Error("PayPal order could not be created");
              pendingOrderId.current = orderId;
              return orderId;
            },
            onApprove: async (data: any) => {
              const res = await inPageCheckout.capture(data.orderID);
              // Accept both the documented `{ captured: true }` contract and
              // the billing server's native `{ status: "captured", credits }`
              // shape — treating a successful capture as a failure made the
              // modal stay open and invited duplicate purchases.
              const captured =
                res?.captured === true || res?.status === "captured";
              const credits = res?.credits;
              if (captured) {
                onCaptured?.(credits);
                setAwaitingPayment(false);
                setPending(null);
                setOpen(false);
              } else {
                setError("Capture failed — please try again.");
                setAwaitingPayment(false);
                setPending(null);
              }
            },
            onCancel: () => {
              setAwaitingPayment(false);
              setPending(null);
            },
            onError: (err: any) => {
              setError(String(err?.message ?? err));
              setAwaitingPayment(false);
              setPending(null);
            },
          })
          .render(buttonsRef.current);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load PayPal");
        setAwaitingPayment(false);
        setPending(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inPageActive, inPageCheckout]);

  // Safety net: sandbox PayPal sometimes loops its overlay instead of
  // closing it after approval.  While awaiting, poll the host's finalize
  // endpoint — the server captures APPROVED orders directly, and the modal
  // completes even when the overlay never closes.
  useEffect(() => {
    if (!inPageActive || !pollFinalize) return;
    let stopped = false;
    (async () => {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!stopped && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        if (stopped) return;
        try {
          const res = await pollFinalize();
          if (res?.captured) {
            onCaptured?.(res.credits);
            setAwaitingPayment(false);
            setPending(null);
            setOpen(false);
            return;
          }
        } catch {
          // transient — keep polling
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [inPageActive, pollFinalize]);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-topup-modal", handler as EventListener);
    return () => window.removeEventListener("open-topup-modal", handler as EventListener);
  }, []);

  async function onTopUp(productId: string) {
    console.log("[MP-DEBUG] onTopUp", {
      inPage: !!inPageCheckout,
      poll: !!pollFinalize,
    });
    setPending(productId);
    setError(null);
    try {
      const result: any = await client.attach({ planId: productId });
      const checkoutUrl =
        result?.paymentUrl ??
        result?.payment_url ??
        result?.checkout_url ??
        result?.url;

      if (!checkoutUrl) {
        setOpen(false);
        return;
      }

      if (inPageCheckout) {
        // In-page mode: keep the modal open, swap the packs for PayPal
        // Buttons.  The order is created HERE, once — createOrder only hands
        // PayPal this fixed order id.
        pendingProductId.current = productId;
        pendingOrderId.current = checkoutUrl
          ? new URL(checkoutUrl).searchParams.get("token")
          : null;
        setAwaitingPayment(true);
        setInPageActive(true);
        setPending(null);
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
          <div className="mt-3">
            {inPageCheckout ? (
              <div ref={buttonsRef} data-testid="paypal-buttons" />
            ) : (
              <p className="text-sm text-muted-foreground">
                Complete the payment in the PayPal window — this dialog closes
                when your credits arrive.
              </p>
            )}
          </div>
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