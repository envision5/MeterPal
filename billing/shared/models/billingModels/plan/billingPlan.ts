import { z } from "zod/v4";
import {
	type AutumnBillingPlan,
	AutumnBillingPlanSchema,
	type DeferredAutumnBillingPlanData,
} from "./autumnBillingPlan";
import {
	type PreviewBillingPlan,
	PreviewBillingPlanSchema,
} from "./previewBillingPlan";

export type {
	AutumnBillingPlan,
	DeferredAutumnBillingPlanData,
	PreviewBillingPlan,
};

export const BillingPlanSchema = z.object({
	autumn: AutumnBillingPlanSchema,
	preview: PreviewBillingPlanSchema.optional(),
});

export type BillingPlan = z.infer<typeof BillingPlanSchema>;
