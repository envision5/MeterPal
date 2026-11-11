"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  APIError: () => APIError,
  AuthenticationError: () => AuthenticationError,
  ConnectionError: () => ConnectionError,
  CostTooltip: () => CostTooltip,
  CreditsBadge: () => CreditsBadge,
  CustomerNotFoundError: () => CustomerNotFoundError,
  DEFAULT_BASE_URL: () => DEFAULT_BASE_URL,
  InsufficientBalanceError: () => InsufficientBalanceError,
  LowBalanceBanner: () => LowBalanceBanner,
  MeterPalError: () => MeterPalError,
  ModelNotEnabledError: () => ModelNotEnabledError,
  ModelNotFoundError: () => ModelNotFoundError,
  PlanCard: () => PlanCard,
  RateLimitError: () => RateLimitError,
  TopUpModal: () => TopUpModal,
  UsageHistoryPanel: () => UsageHistoryPanel,
  createBillingClient: () => createBillingClient,
  createMeterPal: () => createMeterPal,
  createMeterPalClient: () => createMeterPalClient,
  currentPlanIdOf: () => currentPlanIdOf,
  findCustomerBalance: () => findCustomerBalance,
  formatCredits: () => formatCredits,
  useCurrentPlan: () => useCurrentPlan
});
module.exports = __toCommonJS(index_exports);

// src/components/CreditsBadge.tsx
var import_react = require("autumn-js/react");

// src/lib/utils.ts
var import_clsx = require("clsx");
var import_tailwind_merge = require("tailwind-merge");
function cn(...inputs) {
  return (0, import_tailwind_merge.twMerge)((0, import_clsx.clsx)(inputs));
}
function formatCredits(n) {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
function findCustomerBalance(customer, featureId) {
  if (!customer) return null;
  const balances = customer.balances;
  if (!balances) return null;
  const bal = Array.isArray(balances) ? balances.find(
    (b) => (b.feature_id ?? b.featureId ?? b.feature?.id) === featureId
  ) : balances[featureId];
  if (!bal) return null;
  return {
    remaining: Number(bal.remaining ?? 0),
    granted: Number(bal.granted ?? bal.max ?? 0),
    unlimited: Boolean(bal.unlimited)
  };
}

// src/components/CreditsBadge.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function CreditsBadge({
  featureId = "ai_tokens",
  pollIntervalMs = 2500
}) {
  const { data: customer, isLoading } = (0, import_react.useCustomer)({
    queryOptions: { refetchInterval: pollIntervalMs }
  });
  if (isLoading) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-6 w-32 animate-pulse rounded-full bg-muted" });
  const balance = findCustomerBalance(customer, featureId);
  const remaining = balance?.remaining ?? 0;
  const max = balance?.granted ?? 0;
  if (balance?.unlimited) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        role: "status",
        "aria-live": "polite",
        "data-testid": "credits-badge",
        className: "inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-1.5 w-1.5 rounded-full bg-emerald-500" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "unlimited credits" })
        ]
      }
    );
  }
  const pct = max > 0 ? remaining / max : 0;
  const tone = pct > 0.2 ? "ok" : pct > 0.1 ? "warn" : "danger";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      "data-testid": "credits-badge",
      className: cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "bg-red-500/10 text-red-700 dark:text-red-300"
      ),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            className: cn(
              "h-1.5 w-1.5 rounded-full",
              tone === "ok" && "bg-emerald-500",
              tone === "warn" && "bg-amber-500",
              tone === "danger" && "bg-red-500"
            )
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "tabular-nums", children: [
          formatCredits(remaining),
          " credits"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "text-muted-foreground", children: [
          "/ ",
          formatCredits(max)
        ] })
      ]
    }
  );
}

// src/components/LowBalanceBanner.tsx
var import_react2 = require("react");
var import_react3 = require("autumn-js/react");
var import_icons_react = require("@tabler/icons-react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function LowBalanceBanner({
  featureId = "ai_tokens",
  thresholds = { warn: 0.2, danger: 0.1 },
  onAddCredits
}) {
  const { data: customer } = (0, import_react3.useCustomer)({ queryOptions: { refetchInterval: 5e3 } });
  const [dismissed, setDismissed] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
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
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      role: "alert",
      "data-testid": "low-balance-banner",
      className: cn(
        "flex items-center gap-3 rounded-md border px-4 py-3 text-sm",
        level === "warning" && "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        level === "danger" && "border-orange-500/50 bg-orange-500/10 text-orange-900 dark:text-orange-100",
        level === "critical" && "border-red-500/50 bg-red-500/10 text-red-900 dark:text-red-100"
      ),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_icons_react.IconAlertTriangle, { className: "h-4 w-4 shrink-0", "aria-hidden": true }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "flex-1", children: level === "critical" ? "You've run out of credits. Add more to continue." : level === "danger" ? `Only ${formatCredits(balance.remaining)} credits left (${(pct * 100).toFixed(0)}%).` : `${formatCredits(balance.remaining)} credits remaining \u2014 top up to avoid interruptions.` }),
        onAddCredits && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            onClick: onAddCredits,
            className: cn(
              "rounded-md px-3 py-1 text-xs font-medium",
              level === "critical" ? "bg-red-600 text-white hover:bg-red-700" : "border border-current bg-transparent hover:bg-amber-500/20"
            ),
            children: "Add credits"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            onClick: () => setDismissed(true),
            "aria-label": "Dismiss",
            className: "rounded p-1 hover:bg-black/10 dark:hover:bg-white/10",
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_icons_react.IconX, { className: "h-4 w-4", "aria-hidden": true })
          }
        )
      ]
    }
  );
}

// src/components/PlanCard.tsx
var import_icons_react2 = require("@tabler/icons-react");
var import_react5 = require("react");
var import_react6 = require("autumn-js/react");

// src/components/useCurrentPlan.ts
var import_react4 = require("autumn-js/react");
function currentPlanIdOf(customer) {
  const subscriptions = Array.isArray(customer?.subscriptions) ? customer.subscriptions : [];
  if (subscriptions.length === 0) return null;
  const active = subscriptions.find(
    (sub) => sub?.status === "active" && (sub?.planId ?? sub?.plan_id)
  );
  const chosen = active ?? subscriptions[0];
  return chosen?.planId ?? chosen?.plan_id ?? chosen?.plan?.id ?? null;
}
function useCurrentPlan() {
  const { data: customer, isLoading: customerLoading } = (0, import_react4.useCustomer)();
  const { data: plansData, isLoading: plansLoading } = (0, import_react4.useListPlans)();
  const plans = Array.isArray(plansData) ? plansData : plansData?.list ?? plansData?.plans ?? [];
  const planId = currentPlanIdOf(customer);
  const plan = plans.find((p) => p?.id === planId);
  return {
    planId,
    name: plan?.name ?? null,
    isLoading: Boolean(customerLoading ?? plansLoading)
  };
}

// src/components/PlanCard.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function PlanCard() {
  const { data: customer, attach } = (0, import_react6.useCustomer)();
  const { data: plansData } = (0, import_react6.useListPlans)();
  const [pendingId, setPendingId] = (0, import_react5.useState)(null);
  const [feedback, setFeedback] = (0, import_react5.useState)(null);
  const plans = Array.isArray(plansData) ? plansData : plansData?.list ?? plansData?.plans ?? [];
  const currentPlanId = currentPlanIdOf(customer);
  async function onSwitch(planId) {
    setPendingId(planId);
    setFeedback(null);
    try {
      const result = await attach({ planId });
      const checkoutUrl = result?.paymentUrl ?? result?.payment_url ?? result?.checkout_url ?? result?.url;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        setFeedback({
          planId,
          kind: "info",
          message: "Plan updated \u2014 your PayPal subscription is already active, so there was nothing to pay."
        });
      }
    } catch (e) {
      setFeedback({
        planId,
        kind: "error",
        message: e?.message ?? "Failed to switch plan"
      });
    } finally {
      setPendingId(null);
    }
  }
  const currentPlanName = plans.find(
    (plan) => plan?.id === currentPlanId
  )?.name;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "grid gap-2.5", "data-testid": "plan-card-grid", children: [
    currentPlanId && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
      "p",
      {
        className: "mb-0.5 text-xs text-muted-foreground",
        "data-testid": "plan-card-current",
        children: [
          "Current plan:",
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "font-semibold text-foreground", children: currentPlanName ?? currentPlanId })
        ]
      }
    ),
    plans.filter((plan) => !plan.addOn).map((plan) => {
      const isCurrent = plan.id === currentPlanId;
      const planFeedback = feedback?.planId === plan.id ? feedback : null;
      const firstItem = plan.items?.[0];
      const priceUsd = firstItem?.price?.amount ?? 0;
      const interval = firstItem?.price?.interval;
      const included = firstItem?.display?.primaryText;
      return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "article",
        {
          "data-testid": `plan-card-${plan.id}`,
          className: [
            "rounded-xl border p-3.5 transition",
            isCurrent ? "border-primary/60 bg-primary/[0.07]" : "border-border bg-background hover:border-primary/40"
          ].join(" "),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center justify-between gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex min-w-0 items-center gap-2", children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                  "span",
                  {
                    className: [
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      isCurrent ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                    ].join(" "),
                    children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_icons_react2.IconCreditCard, { size: 16 })
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "min-w-0", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "truncate text-sm font-semibold", children: plan.name }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "text-xs text-muted-foreground", children: [
                    "$",
                    priceUsd,
                    interval === "month" ? "/mo" : interval === "one_off" ? " once" : ""
                  ] })
                ] })
              ] }),
              isCurrent && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary", children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_icons_react2.IconCheck, { size: 11 }),
                "Current"
              ] })
            ] }),
            included && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "mt-2 flex items-center gap-1.5 text-xs text-muted-foreground", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_icons_react2.IconCoins, { size: 12, className: "text-amber-300" }),
              included
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                type: "button",
                disabled: isCurrent || pendingId === plan.id,
                onClick: () => onSwitch(plan.id),
                className: [
                  "mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                  isCurrent ? "border border-border bg-muted text-muted-foreground cursor-default" : "bg-primary text-primary-foreground hover:bg-primary/90",
                  pendingId === plan.id && "opacity-60 cursor-wait"
                ].filter(Boolean).join(" "),
                children: isCurrent ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_icons_react2.IconCheck, { size: 13 }),
                  "Current plan"
                ] }) : pendingId === plan.id ? "Switching\u2026" : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
                  "Switch",
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_icons_react2.IconArrowRight, { size: 13 })
                ] })
              }
            ),
            planFeedback && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "p",
              {
                role: planFeedback.kind === "error" ? "alert" : "status",
                "data-testid": `plan-card-feedback-${plan.id}`,
                className: [
                  "mt-2 text-xs",
                  planFeedback.kind === "error" ? "text-red-600" : "text-muted-foreground"
                ].join(" "),
                children: planFeedback.message
              }
            )
          ]
        },
        plan.id
      );
    })
  ] });
}

// src/components/TopUpModal.tsx
var import_react7 = require("react");
var import_react8 = require("autumn-js/react");
var import_icons_react3 = require("@tabler/icons-react");
var import_jsx_runtime4 = require("react/jsx-runtime");
var DEFAULT_PRODUCTS = ["topup_1k", "topup_5k", "topup_25k"];
var DEFAULT_LABELS = ["1,000 credits", "5,000 credits", "25,000 credits"];
var DEFAULT_PRICES = [10, 45, 200];
function TopUpModal({
  productIds = DEFAULT_PRODUCTS,
  labels = DEFAULT_LABELS,
  prices = DEFAULT_PRICES,
  pollFinalize,
  onCaptured,
  inPageCheckout
}) {
  const client = (0, import_react8.useAutumnClient)({ caller: "TopUpModal" });
  const [open, setOpen] = (0, import_react7.useState)(false);
  const [pending, setPending] = (0, import_react7.useState)(null);
  const [error, setError] = (0, import_react7.useState)(null);
  const [awaitingPayment, setAwaitingPayment] = (0, import_react7.useState)(false);
  const [inPageActive, setInPageActive] = (0, import_react7.useState)(false);
  const buttonsRef = (0, import_react7.useRef)(null);
  const pendingProductId = (0, import_react7.useRef)(null);
  const pendingOrderId = (0, import_react7.useRef)(null);
  const captureRef = (0, import_react7.useRef)(inPageCheckout?.capture);
  captureRef.current = inPageCheckout?.capture;
  const pollFinalizeRef = (0, import_react7.useRef)(pollFinalize);
  pollFinalizeRef.current = pollFinalize;
  const onCapturedRef = (0, import_react7.useRef)(onCaptured);
  onCapturedRef.current = onCaptured;
  const paypalClientId = inPageCheckout?.clientId;
  (0, import_react7.useEffect)(() => {
    if (open) return;
    setInPageActive(false);
    pendingProductId.current = null;
    pendingOrderId.current = null;
  }, [open]);
  function loadPayPalSdk(clientId) {
    const w = window;
    if (w.paypal?.Buttons) return Promise.resolve(w.paypal);
    return new Promise((resolve, reject) => {
      const id = `paypal-sdk-${clientId.slice(0, 12)}`;
      if (document.getElementById(id)) {
        const t = setInterval(() => {
          if (w.paypal?.Buttons) {
            clearInterval(t);
            resolve(w.paypal);
          }
        }, 200);
        setTimeout(() => clearInterval(t), 15e3);
        return;
      }
      const el = document.createElement("script");
      el.id = id;
      el.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&disable-funding=credit`;
      el.onload = () => w.paypal?.Buttons ? resolve(w.paypal) : reject(new Error("PayPal SDK loaded without Buttons"));
      el.onerror = () => reject(new Error("Failed to load the PayPal SDK"));
      document.head.appendChild(el);
    });
  }
  (0, import_react7.useEffect)(() => {
    if (!inPageActive || !paypalClientId || !buttonsRef.current) return;
    let cancelled = false;
    let buttons = null;
    (async () => {
      try {
        const paypal = await loadPayPalSdk(paypalClientId);
        const host = buttonsRef.current;
        if (cancelled || !host) return;
        host.innerHTML = "";
        buttons = paypal.Buttons({
          style: { layout: "vertical", height: 45 },
          createOrder: async () => {
            if (pendingOrderId.current) return pendingOrderId.current;
            const productId = pendingProductId.current;
            if (!productId) throw new Error("no pack selected");
            const result = await client.attach({ planId: productId });
            const checkoutUrl = result?.paymentUrl ?? result?.payment_url ?? result?.checkout_url ?? result?.url;
            const orderId = checkoutUrl ? new URL(checkoutUrl).searchParams.get("token") : null;
            if (!orderId) throw new Error("PayPal order could not be created");
            pendingOrderId.current = orderId;
            return orderId;
          },
          onApprove: async (data) => {
            const res = await captureRef.current?.(data.orderID);
            const captured = res?.captured === true || res?.status === "captured";
            const credits = res?.credits;
            if (captured) {
              onCapturedRef.current?.(credits);
              setAwaitingPayment(false);
              setPending(null);
              setOpen(false);
            } else {
              setError("Capture failed \u2014 please try again.");
              setAwaitingPayment(false);
              setPending(null);
            }
          },
          onCancel: () => {
            setAwaitingPayment(false);
            setPending(null);
          },
          onError: (err) => {
            setError(String(err?.message ?? err));
            setAwaitingPayment(false);
            setPending(null);
          }
        });
        await buttons.render(host);
      } catch (e) {
        setError(e?.message ?? "Failed to load PayPal");
        setAwaitingPayment(false);
        setPending(null);
      }
    })();
    return () => {
      cancelled = true;
      try {
        buttons?.close?.();
      } catch {
      }
      if (buttonsRef.current) buttonsRef.current.innerHTML = "";
    };
  }, [inPageActive, paypalClientId, client]);
  (0, import_react7.useEffect)(() => {
    if (!inPageActive || !pollFinalizeRef.current) return;
    let stopped = false;
    (async () => {
      const deadline = Date.now() + 10 * 60 * 1e3;
      while (!stopped && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3e3));
        if (stopped) return;
        try {
          const res = await pollFinalizeRef.current?.();
          if (res?.captured) {
            onCapturedRef.current?.(res.credits);
            setAwaitingPayment(false);
            setPending(null);
            setOpen(false);
            return;
          }
        } catch {
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [inPageActive]);
  (0, import_react7.useEffect)(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-topup-modal", handler);
    return () => window.removeEventListener("open-topup-modal", handler);
  }, []);
  async function onTopUp(productId) {
    setPending(productId);
    setError(null);
    try {
      const result = await client.attach({ planId: productId });
      const checkoutUrl = result?.paymentUrl ?? result?.payment_url ?? result?.checkout_url ?? result?.url;
      if (!checkoutUrl) {
        setOpen(false);
        return;
      }
      if (inPageCheckout) {
        pendingProductId.current = productId;
        pendingOrderId.current = checkoutUrl ? new URL(checkoutUrl).searchParams.get("token") : null;
        setAwaitingPayment(true);
        setInPageActive(true);
        setPending(null);
        return;
      }
      if (pollFinalize) {
        const popup = window.open(
          checkoutUrl,
          "meterpal-paypal",
          "width=480,height=720"
        );
        setAwaitingPayment(true);
        const deadline = Date.now() + 5 * 60 * 1e3;
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
          }
          if (popup?.closed) {
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
            }
            break;
          }
        }
        setAwaitingPayment(false);
        setPending(null);
        setError(
          "Payment not confirmed yet \u2014 if you completed it in PayPal, your credits will appear shortly."
        );
        return;
      }
      window.location.href = checkoutUrl;
    } catch (e) {
      setError(e?.message ?? "Top-up failed");
      setPending(null);
    }
  }
  if (!open) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "topup-title",
      "data-testid": "topup-modal",
      className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50",
      children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "bg-background rounded-xl border border-border shadow-xl w-full max-w-md p-6", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex items-start justify-between", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h2", { id: "topup-title", className: "text-lg font-semibold", children: "Add credits" }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "text-sm text-muted-foreground", children: awaitingPayment ? "Approve the payment in PayPal \u2014 your credits land the moment it captures." : "Choose a credit pack \u2014 you'll approve the payment with PayPal." })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              onClick: () => setOpen(false),
              "aria-label": "Close",
              className: "rounded p-1 hover:bg-muted",
              children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_icons_react3.IconX, { className: "h-4 w-4", "aria-hidden": true })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "mt-4 grid gap-2", "data-testid": "topup-options", children: !awaitingPayment && productIds.map((id, i) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            type: "button",
            onClick: () => onTopUp(id),
            disabled: pending !== null,
            "data-testid": `topup-option-${id}`,
            className: "flex items-center justify-between rounded-md border border-border px-4 py-3 hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed text-left",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "font-medium", children: labels[i] ?? id }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "text-muted-foreground", children: [
                "$",
                prices[i] ?? "\u2014"
              ] })
            ]
          },
          id
        )) }),
        awaitingPayment && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "mt-3", children: inPageCheckout ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "p",
            {
              className: "mb-2 text-xs text-muted-foreground",
              "data-testid": "paypal-approval-hint",
              children: "One payment, approved by you in PayPal. An agent can open this checkout but can never approve it."
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { ref: buttonsRef, "data-testid": "paypal-buttons" })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "text-sm text-muted-foreground", children: "Complete the payment in the PayPal window \u2014 this dialog closes when your credits arrive." }) }),
        error && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { role: "alert", className: "mt-3 text-sm text-red-600", children: error }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "mt-5 flex justify-end", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            onClick: () => setOpen(false),
            className: "px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
            children: "Cancel"
          }
        ) })
      ] })
    }
  );
}

// src/components/UsageHistoryPanel.tsx
var import_react9 = require("autumn-js/react");
var import_jsx_runtime5 = require("react/jsx-runtime");
function startOfMonth(d = /* @__PURE__ */ new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function formatCredits2(n) {
  if (!Number.isFinite(n)) return "\u2014";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1) return n.toFixed(2);
  const fixed = n.toFixed(5);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? fixed : trimmed;
}
function billedTokens(properties) {
  const num = (key) => Number(properties?.[key] ?? 0);
  return {
    input: num("input_tokens") + num("cache_read_tokens") + num("cache_write_tokens"),
    output: num("output_tokens") + num("reasoning_tokens"),
    cached: num("cache_read_tokens") + num("cache_write_tokens"),
    reasoning: num("reasoning_tokens")
  };
}
function isCharge(evt) {
  const key = evt?.idempotency_key ?? evt?.idempotencyKey;
  if (key === null) return false;
  if (typeof key === "string" && key.length > 0) return true;
  const properties = evt?.properties;
  return !!properties && Object.keys(properties).length > 0;
}
function UsageHistoryPanel({
  featureId,
  rangeStart = startOfMonth(),
  rangeEnd = /* @__PURE__ */ new Date(),
  limit = 50
}) {
  const { data } = (0, import_react9.useListEvents)({
    ...featureId ? { featureId } : {},
    limit,
    customRange: {
      start: rangeStart.getTime(),
      end: rangeEnd.getTime()
    }
  });
  const rawEvents = data?.list ?? data?.events ?? [];
  const events = rawEvents.filter(isCharge);
  const truncated = Boolean(data?.nextCursor) || Boolean(data?.has_more);
  const byModel = /* @__PURE__ */ new Map();
  for (const evt of events) {
    const model = evt.properties?.model_id ?? evt.properties?.model ?? "unknown";
    const entry = byModel.get(model) ?? { credits: 0, count: 0 };
    entry.credits += Number(evt.value ?? 0);
    entry.count += 1;
    byModel.set(model, entry);
  }
  const modelRows = [...byModel.entries()].sort(
    (a, b) => b[1].credits - a[1].credits
  );
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "grid gap-4", "data-testid": "usage-history", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("section", { className: "rounded-xl border border-border p-5", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("h3", { className: "font-semibold", children: truncated ? "Recent requests, by model" : "This month, by model" }),
      truncated && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
        "p",
        {
          className: "mt-1 text-xs text-muted-foreground",
          "data-testid": "usage-window-note",
          children: [
            "Totals cover the ",
            events.length,
            " most recent requests, not the whole month \u2014 the ledger holds more than this page."
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("table", { className: "mt-3 w-full text-sm", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tr", { className: "text-left text-muted-foreground", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2", children: "Model" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2 text-right", children: "Requests" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2 text-right", children: "Credits" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tbody", { children: [
          modelRows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { colSpan: 3, className: "py-3 text-muted-foreground", children: "No usage yet this month." }) }),
          modelRows.map(([model, agg]) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tr", { className: "border-t border-border", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2", children: model }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2 text-right tabular-nums", children: agg.count }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2 text-right tabular-nums", children: formatCredits2(agg.credits) })
          ] }, model)),
          modelRows.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tr", { className: "border-t border-border font-medium", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2", children: "Total" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2 text-right tabular-nums", children: events.length }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2 text-right tabular-nums", children: formatCredits2(
              events.reduce((sum, evt) => sum + Number(evt.value ?? 0), 0)
            ) })
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("section", { className: "rounded-xl border border-border p-5", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("h3", { className: "font-semibold", children: "Recent requests" }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("table", { className: "mt-3 w-full text-sm", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tr", { className: "text-left text-muted-foreground", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2", children: "When" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2", children: "Model" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2 text-right", children: "In / Out" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("th", { className: "font-normal pb-2 text-right", children: "Credits" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tbody", { children: [
          events.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { colSpan: 4, className: "py-3 text-muted-foreground", children: "No requests yet." }) }),
          events.map((evt) => {
            const tokens = billedTokens(evt.properties);
            return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("tr", { className: "border-t border-border", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2", children: new Date(evt.timestamp).toLocaleString() }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2", children: evt.properties?.model_id ?? evt.properties?.model ?? "\u2014" }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
                "td",
                {
                  className: "py-2 text-right tabular-nums",
                  title: tokens.cached || tokens.reasoning ? `Includes ${tokens.cached} cached input and ${tokens.reasoning} reasoning tokens` : void 0,
                  children: [
                    tokens.input,
                    " / ",
                    tokens.output
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("td", { className: "py-2 text-right tabular-nums", children: formatCredits2(Number(evt.value ?? 0)) })
            ] }, evt.id);
          })
        ] })
      ] })
    ] })
  ] });
}

// src/components/CostTooltip.tsx
var import_react10 = require("react");
var import_jsx_runtime6 = require("react/jsx-runtime");
function CostTooltip({ usage }) {
  const [open, setOpen] = (0, import_react10.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "relative inline-flex", children: [
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
      "button",
      {
        type: "button",
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
        "aria-describedby": "cost-breakdown",
        "data-testid": "cost-tooltip-trigger",
        className: "cursor-help text-xs text-muted-foreground underline decoration-dotted rounded",
        children: [
          usage.credits,
          " credit",
          usage.credits === 1 ? "" : "s"
        ]
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
      "span",
      {
        id: "cost-breakdown",
        role: "tooltip",
        "data-testid": "cost-tooltip-popover",
        className: "absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 rounded-md border border-border bg-background p-3 text-xs shadow-lg",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "block font-semibold", children: usage.model }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "mt-1 block space-y-0.5", children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "flex justify-between", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "Input tokens" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "tabular-nums", children: usage.input_tokens })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "flex justify-between", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "Output tokens" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "tabular-nums", children: usage.output_tokens })
            ] }),
            (usage.cache_read_tokens ?? 0) > 0 && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "flex justify-between text-emerald-600", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "Cached reads" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "tabular-nums", children: usage.cache_read_tokens })
            ] }),
            (usage.cache_write_tokens ?? 0) > 0 && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "flex justify-between text-amber-600", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "Cache writes" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "tabular-nums", children: usage.cache_write_tokens })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "flex justify-between border-t border-border pt-1 font-medium", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "USD total" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "tabular-nums", children: [
                "$",
                usage.cost_usd.toFixed(4)
              ] })
            ] })
          ] })
        ]
      }
    )
  ] });
}

// src/client.ts
var import_react11 = require("autumn-js/react");
function createMeterPalClient(cfg) {
  return (0, import_react11.createAutumnClient)({
    backendUrl: cfg.backendUrl,
    pathPrefix: cfg.pathPrefix ?? "/api/autumn",
    includeCredentials: cfg.includeCredentials,
    headers: cfg.headers
  });
}
var createBillingClient = createMeterPalClient;

// src/inference/errors.ts
var MeterPalError = class extends Error {
  status;
  code;
  body;
  constructor(message, options = {}) {
    super(message);
    this.name = "MeterPalError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
    if (options.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var AuthenticationError = class extends MeterPalError {
  constructor(message = "Invalid MeterPal secret key", options = {}) {
    super(message, options);
    this.name = "AuthenticationError";
  }
};
var InsufficientBalanceError = class extends MeterPalError {
  /** The end user who needs to pay. */
  customerId;
  /** Their spendable balance, in credits. */
  balance;
  /** The smallest balance that would have let the call through. */
  requiredCredits;
  /**
   * Open the PayPal checkout.
   *
   * Assigned by the client, which knows how to create a checkout for this
   * merchant.  Returns the URL to send the end user to.
   */
  topUp;
  constructor(message = "The customer does not have enough credits for this call", options = {}) {
    super(message, options);
    this.name = "InsufficientBalanceError";
    this.customerId = options.customerId;
    this.balance = options.balance;
    this.requiredCredits = options.requiredCredits;
  }
};
var ModelNotEnabledError = class extends MeterPalError {
  model;
  constructor(message = "This model is not enabled for this organization", options = {}) {
    super(message, options);
    this.name = "ModelNotEnabledError";
    this.model = options.model;
  }
};
var ModelNotFoundError = class extends MeterPalError {
  model;
  constructor(message = "This model is not in the organization's served catalog", options = {}) {
    super(message, options);
    this.name = "ModelNotFoundError";
    this.model = options.model;
  }
};
var RateLimitError = class extends MeterPalError {
  constructor(message = "Rate limit exceeded", options = {}) {
    super(message, options);
    this.name = "RateLimitError";
  }
};
var CustomerNotFoundError = class extends MeterPalError {
  customerId;
  constructor(message = "No such customer in this organization", options = {}) {
    super(message, options);
    this.name = "CustomerNotFoundError";
    this.customerId = options.customerId;
  }
};
var APIError = class extends MeterPalError {
  constructor(message = "MeterPal request failed", options = {}) {
    super(message, options);
    this.name = "APIError";
  }
};
var ConnectionError = class extends MeterPalError {
  constructor(message = "Could not reach MeterPal", options = {}) {
    super(message, options);
    this.name = "ConnectionError";
  }
};

// src/inference/client.ts
var DEFAULT_BASE_URL = "https://api.meterpal.dev";
var virtualKeyCache = /* @__PURE__ */ new Map();
var VIRTUAL_KEY_PREFIX = "sk-";
function createMeterPal(config) {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;
  const autoCreateCustomer = config.autoCreateCustomer ?? true;
  const timeoutMs = config.timeoutMs ?? 12e4;
  if (!config.apiKey) {
    throw new MeterPalError(
      "createMeterPal needs an apiKey \u2014 the merchant's MeterPal secret key."
    );
  }
  const isVirtualKey = config.apiKey.startsWith(VIRTUAL_KEY_PREFIX);
  const cacheKey = (customerId) => `${baseURL}|${config.apiKey}|${customerId}`;
  const request = async ({
    path,
    method,
    body,
    credential,
    accept
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          ...accept ? { Accept: accept } : {},
          ...config.headers ?? {}
        },
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: controller.signal
      });
    } catch (error) {
      throw new ConnectionError(
        error instanceof Error && error.name === "AbortError" ? `MeterPal request timed out after ${timeoutMs}ms` : `Could not reach MeterPal at ${baseURL}`,
        { cause: error }
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const resolveCredential = async (customerId) => {
    if (isVirtualKey) return config.apiKey;
    const cached = virtualKeyCache.get(cacheKey(customerId));
    if (cached) return cached;
    let response = await request({
      path: "/v1/keys",
      method: "POST",
      body: { customer_id: customerId },
      credential: config.apiKey
    });
    let data = await readJson(response);
    if (!response.ok) {
      const error = toError(response.status, data);
      if (response.status === 404 && autoCreateCustomer) {
        await createCustomer(customerId);
        response = await request({
          path: "/v1/keys",
          method: "POST",
          body: { customer_id: customerId },
          credential: config.apiKey
        });
        data = await readJson(response);
        if (!response.ok) throw toError(response.status, data);
      } else {
        throw error;
      }
    }
    const key = data?.key;
    if (!key) {
      throw new APIError("MeterPal did not return an inference key");
    }
    virtualKeyCache.set(cacheKey(customerId), key);
    return key;
  };
  const createCustomer = async (customerId) => {
    const response = await request({
      path: "/v1/customers",
      method: "POST",
      // The billing server's get-or-create contract keys the body on `id`
      // (handleGetOrCreateCustomer reads createCusParams.id).
      body: { id: customerId },
      credential: config.apiKey
    });
    const data = await readJson(response);
    if (!response.ok) throw toError(response.status, data);
  };
  const createCheckout = async ({
    customerId,
    productId,
    returnUrl
  }) => {
    const response = await request({
      path: "/v1/checkout",
      method: "POST",
      body: {
        customer_id: customerId,
        ...productId ? { product_id: productId } : {},
        ...returnUrl ? { success_url: returnUrl } : {}
      },
      credential: config.apiKey
    });
    const data = await readJson(response);
    if (!response.ok) throw toError(response.status, data);
    const url = data?.paymentUrl ?? data?.payment_url ?? data?.checkout_url ?? data?.url;
    if (!url) {
      throw new APIError("MeterPal did not return a checkout URL");
    }
    return { url, id: data?.id ?? data?.checkout_id };
  };
  return {
    chat: {
      completions: {
        create: async (params) => {
          const customerId = requireUser(params);
          let credential = await resolveCredential(customerId);
          let response = await request({
            path: "/v1/chat/completions",
            method: "POST",
            body: { ...params, user: customerId },
            credential
          });
          let data = await readJson(response);
          if (!response.ok && response.status === 404 && (data?.code === "customer_not_found" || data?.error?.code === "customer_not_found") && autoCreateCustomer) {
            await createCustomer(customerId);
            virtualKeyCache.delete(cacheKey(customerId));
            credential = await resolveCredential(customerId);
            response = await request({
              path: "/v1/chat/completions",
              method: "POST",
              body: { ...params, user: customerId },
              credential
            });
            data = await readJson(response);
          }
          if (!response.ok) {
            throw decorate(toError(response.status, data), {
              customerId,
              createCheckout
            });
          }
          return data;
        },
        stream: async function* (params) {
          const customerId = requireUser(params);
          const credential = await resolveCredential(customerId);
          const response = await request({
            path: "/v1/chat/completions",
            method: "POST",
            body: { ...params, user: customerId, stream: true },
            credential,
            accept: "text/event-stream"
          });
          if (!response.ok) {
            const data = await readJson(response);
            throw decorate(toError(response.status, data), {
              customerId,
              createCheckout
            });
          }
          if (!response.body) {
            throw new APIError("MeterPal returned an empty stream");
          }
          for await (const payload of readSse(response.body)) {
            yield payload;
          }
        }
      }
    },
    keys: {
      provision: async (customerId) => {
        const response = await request({
          path: "/v1/keys",
          method: "POST",
          body: { customer_id: customerId },
          credential: config.apiKey
        });
        const data = await readJson(response);
        if (!response.ok) throw toError(response.status, data);
        if (data?.key) {
          virtualKeyCache.set(cacheKey(customerId), data.key);
        }
        return data;
      }
    },
    models: {
      list: async () => {
        const response = await request({
          path: "/v1/catalog",
          method: "GET",
          credential: config.apiKey
        });
        const data = await readJson(response);
        if (!response.ok) throw toError(response.status, data);
        return data;
      }
    }
  };
}
var requireUser = (params) => {
  const user = params?.user;
  if (!user || typeof user !== "string") {
    throw new MeterPalError(
      "`user` is required \u2014 it is the id of the end user being billed."
    );
  }
  return user;
};
var readJson = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};
var toError = (status, body) => {
  const detail = body?.error && typeof body.error === "object" ? body.error : body?.detail && typeof body.detail === "object" ? body.detail : {};
  const error = detail;
  const upstream = error?.provider_specific_fields ?? {};
  const code = error.code ?? body?.code ?? (typeof body?.error === "string" ? body.error : void 0);
  const message = error.message ?? body?.message ?? `MeterPal request failed (${status})`;
  switch (code) {
    case "model_not_enabled":
      return new ModelNotEnabledError(message, { status, code, body });
    case "model_not_found":
      return new ModelNotFoundError(message, { status, code, body });
    case "customer_not_found":
      return new CustomerNotFoundError(message, {
        status,
        code,
        body,
        customerId: body?.error?.customer_id
      });
  }
  switch (status) {
    case 401:
      return new AuthenticationError(message, { status, code, body });
    case 402:
      return new InsufficientBalanceError(message, {
        status,
        code,
        body,
        customerId: error.customer_id,
        balance: error.balance ?? upstream.balance,
        requiredCredits: error.required_credits ?? upstream.required_credits
      });
    case 403:
      return new ModelNotEnabledError(message, { status, code, body });
    case 404:
      return new ModelNotFoundError(message, { status, code, body });
    case 429:
      return new RateLimitError(message, { status, code, body });
    default:
      return new APIError(message, { status, code, body });
  }
};
var decorate = (error, {
  customerId,
  createCheckout
}) => {
  if (error instanceof InsufficientBalanceError) {
    error.customerId = error.customerId ?? customerId;
    error.topUp = async (options = {}) => await createCheckout({
      customerId: error.customerId ?? customerId,
      productId: options.productId,
      returnUrl: options.returnUrl
    });
  }
  return error;
};
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const payload2 = sseData(part);
        if (payload2 === null) continue;
        if (payload2 === "[DONE]") return;
        yield payload2;
      }
    }
    buffer += decoder.decode();
    const payload = sseData(buffer);
    if (payload && payload !== "[DONE]") {
      yield payload;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
var sseData = (event) => {
  const lines = event.split("\n");
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data) return null;
  if (data === "[DONE]") return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  APIError,
  AuthenticationError,
  ConnectionError,
  CostTooltip,
  CreditsBadge,
  CustomerNotFoundError,
  DEFAULT_BASE_URL,
  InsufficientBalanceError,
  LowBalanceBanner,
  MeterPalError,
  ModelNotEnabledError,
  ModelNotFoundError,
  PlanCard,
  RateLimitError,
  TopUpModal,
  UsageHistoryPanel,
  createBillingClient,
  createMeterPal,
  createMeterPalClient,
  currentPlanIdOf,
  findCustomerBalance,
  formatCredits,
  useCurrentPlan
});
//# sourceMappingURL=index.cjs.map