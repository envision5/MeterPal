// billing/vite/src/views/setup/panels/PlanStep.tsx
//
// The wizard's plan step.
//
// The merchant's plan is a MeterPal product; PayPal needs its own
// counterpart before it can bill for one.  This panel shows both and creates
// the PayPal side on request.

import { Button } from "@autumn/ui";
import { toast } from "sonner";
import { getBackendErr } from "@/utils/genUtils";
import type { SetupPlan } from "../hooks/useSetupState";

export function PlanStep({
	plans,
	onCreatePaypalPlan,
	isCreating,
}: {
	plans: SetupPlan[];
	onCreatePaypalPlan: (productId: string) => Promise<void>;
	isCreating: boolean;
}) {
	// A plan with a fixed recurring price is a subscription -- that is the one
	// PayPal bills.  Credit packs are bought once, so they have no PayPal
	// plan and must not be offered one.
	const sellable = plans.filter((p) => p.amount_usd != null);

	const handleCreate = async (productId: string) => {
		try {
			await onCreatePaypalPlan(productId);
			toast.success("PayPal plan created");
		} catch (error) {
			toast.error(getBackendErr(error, "Could not create the PayPal plan"));
		}
	};

	if (sellable.length === 0) {
		return (
			<div className="rounded-lg border bg-interactive-secondary px-4 py-6 text-center">
				<p className="font-medium text-foreground text-sm">No plan yet</p>
				<p className="mt-1 text-subtle text-xs">
					Create a plan with a monthly price and an AI credit allowance.
					MeterPal then creates the PayPal plan that bills it.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{sellable.map((plan) => (
				<div
					key={plan.product_id}
					className="flex items-center gap-3 rounded-lg border bg-interactive-secondary px-4 py-3"
				>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate font-medium text-foreground text-sm">
							{plan.name}
						</span>
						<span className="truncate text-tertiary-foreground text-xs">
							{plan.product_id} · ${plan.amount_usd} / {plan.interval}
						</span>
					</div>
					{plan.paypal_plan_id ? (
						<span className="shrink-0 font-medium text-emerald-500 text-xs">
							<span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-500" />
							PayPal plan {plan.paypal_plan_id}
						</span>
					) : (
						<Button
							variant="secondary"
							size="sm"
							className="shrink-0"
							isLoading={isCreating}
							onClick={() => handleCreate(plan.product_id)}
						>
							Create the PayPal plan
						</Button>
					)}
				</div>
			))}
		</div>
	);
}
