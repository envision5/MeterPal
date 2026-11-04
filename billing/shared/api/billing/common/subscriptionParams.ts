import { z } from "zod/v4";

export const SubscriptionParamsSchema = z
	.record(z.string(), z.unknown())
	.meta({
		title: "SubscriptionParams",
		description:
			"Additional parameters to pass into the processor subscription update or cancel call.",
	});

export type SubscriptionParams = z.infer<typeof SubscriptionParamsSchema>;
