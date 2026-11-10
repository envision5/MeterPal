"use client";

// useCurrentPlan — the plan the customer is actually on.
//
// The customer payload and the plan catalog are two different reads, so the
// "current plan" has to be JOINED: the customer's subscriptions name the plan
// id, the plan list carries the display name.  Anything that shows the
// current plan (a header badge, a billing summary) needs both.
//
// Why the join is not trivial: the customer's subscription list can hold more
// than one entry (a scheduled switch, a plan that has already ended), so
// "subscriptions[0]" is not reliably the live plan.  The ACTIVE subscription
// wins; only when there is none do we fall back to the first entry.

import { useCustomer, useListPlans } from "autumn-js/react";

export type CurrentPlan = {
	/** The plan id the customer is on, e.g. "pro". Null when they are on none. */
	planId: string | null;
	/** The plan's display name, e.g. "MeterPal Pro". Null when unknown. */
	name: string | null;
	/** True until the customer and the plan list have both resolved. */
	isLoading: boolean;
};

/** The plan id from a customer payload, preferring the active subscription. */
export function currentPlanIdOf(customer: any): string | null {
	const subscriptions: any[] = Array.isArray(customer?.subscriptions)
		? customer.subscriptions
		: [];
	if (subscriptions.length === 0) return null;

	const active = subscriptions.find(
		(sub) => sub?.status === "active" && (sub?.planId ?? sub?.plan_id),
	);
	const chosen = active ?? subscriptions[0];
	return chosen?.planId ?? chosen?.plan_id ?? chosen?.plan?.id ?? null;
}

export function useCurrentPlan(): CurrentPlan {
	// Identity is resolved server-side by the autumn-js backend adapter.
	const { data: customer, isLoading: customerLoading } = useCustomer() as any;
	const { data: plansData, isLoading: plansLoading } = useListPlans() as any;

	// useListPlans unwraps response.list — data is already the plan array.
	const plans: any[] = Array.isArray(plansData)
		? plansData
		: ((plansData as any)?.list ?? (plansData as any)?.plans ?? []);

	const planId = currentPlanIdOf(customer);
	const plan = plans.find((p: any) => p?.id === planId);

	return {
		planId,
		name: plan?.name ?? null,
		isLoading: Boolean(customerLoading ?? plansLoading),
	};
}
