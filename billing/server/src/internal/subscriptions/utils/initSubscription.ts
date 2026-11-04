import type { AppEnv, Subscription } from "@autumn/shared";
import { generateId } from "@/utils/genUtils.js";

export const initSubscription = ({
	processorId,
	orgId,
	env,
	currentPeriodStart,
	currentPeriodEnd,
	billingCycleAnchorSeconds,
}: {
	processorId?: string;
	orgId: string;
	env: AppEnv;
	currentPeriodStart?: number;
	currentPeriodEnd?: number;
	billingCycleAnchorSeconds?: number;
}) => {
	const newSub: Subscription = {
		id: generateId("sub"),
		processor_id: processorId || null,
		created_at: Date.now(),
		usage_features: [],
		org_id: orgId,
		env: env,
		current_period_start: currentPeriodStart || null,
		current_period_end: currentPeriodEnd || null,
		billing_cycle_anchor_seconds: billingCycleAnchorSeconds ?? null,
	};

	return newSub;
};
