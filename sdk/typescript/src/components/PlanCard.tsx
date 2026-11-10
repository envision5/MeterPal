"use client";

import {
	IconArrowRight,
	IconCheck,
	IconCoins,
	IconCreditCard,
} from "@tabler/icons-react";
import { useState } from "react";
import { useCustomer, useListPlans } from "autumn-js/react";
import { currentPlanIdOf } from "./useCurrentPlan";

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

	// The customer's active plan.  The customer payload and the plan catalog
	// are separate reads, so the id comes from the customer's subscriptions —
	// the ACTIVE one, not blindly the first, which can be a scheduled switch
	// or an already-ended plan.
	const currentPlanId = currentPlanIdOf(customer);

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

	// Compact single-column rows: this component lives in sidebars and rails
	// as often as in wide layouts, so it never assumes three columns of room.
	const currentPlanName = plans.find(
		(plan: any) => plan?.id === currentPlanId,
	)?.name;

	return (
		<div className="grid gap-2.5" data-testid="plan-card-grid">
			{currentPlanId && (
				<p
					className="mb-0.5 text-xs text-muted-foreground"
					data-testid="plan-card-current"
				>
					Current plan:{" "}
					<span className="font-semibold text-foreground">
						{currentPlanName ?? currentPlanId}
					</span>
				</p>
			)}
			{plans
				.filter((plan: any) => !plan.addOn)
				.map((plan: any) => {
					const isCurrent = plan.id === currentPlanId;
					const planFeedback = feedback?.planId === plan.id ? feedback : null;
					// Autumn plan prices are in major units (dollars).
					const firstItem = plan.items?.[0];
					const priceUsd = firstItem?.price?.amount ?? 0;
					const interval = firstItem?.price?.interval;
					const included = firstItem?.display?.primaryText;

					return (
						<article
							key={plan.id}
							data-testid={`plan-card-${plan.id}`}
							className={[
								"rounded-xl border p-3.5 transition",
								isCurrent
									? "border-primary/60 bg-primary/[0.07]"
									: "border-border bg-background hover:border-primary/40",
							].join(" ")}
						>
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-2">
									<span
										className={[
											"flex size-8 shrink-0 items-center justify-center rounded-lg",
											isCurrent
												? "bg-primary/15 text-primary"
												: "bg-muted text-muted-foreground",
										].join(" ")}
									>
										<IconCreditCard size={16} />
									</span>
									<div className="min-w-0">
										<p className="truncate text-sm font-semibold">{plan.name}</p>
										<p className="text-xs text-muted-foreground">
											${priceUsd}
											{interval === "month"
												? "/mo"
												: interval === "one_off"
													? " once"
													: ""}
										</p>
									</div>
								</div>
								{isCurrent && (
									<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
										<IconCheck size={11} />
										Current
									</span>
								)}
							</div>

							{included && (
								<p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
									<IconCoins size={12} className="text-amber-300" />
									{included}
								</p>
							)}

							<button
								type="button"
								disabled={isCurrent || pendingId === plan.id}
								onClick={() => onSwitch(plan.id)}
								className={[
									"mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
									isCurrent
										? "border border-border bg-muted text-muted-foreground cursor-default"
										: "bg-primary text-primary-foreground hover:bg-primary/90",
									pendingId === plan.id && "opacity-60 cursor-wait",
								]
									.filter(Boolean)
									.join(" ")}
							>
								{isCurrent ? (
									<>
										<IconCheck size={13} />
										Current plan
									</>
								) : pendingId === plan.id ? (
									"Switching…"
								) : (
									<>
										Switch
										<IconArrowRight size={13} />
									</>
								)}
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
