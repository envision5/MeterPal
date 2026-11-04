import { z } from "zod/v4";

export const AttachFunctionResponseSchema = z.object({
	checkout_url: z.string().nullish(),
	message: z.string().optional(),
	code: z.string().optional(),

	invoice: z.any().optional(), // processor invoice
	checkoutSession: z.any().optional(), // processor checkout session
	processorSub: z.any().optional(), // processor subscription
	anchorToUnix: z.number().optional(),

	newCustomerProductId: z.string().optional(),
});

export type AttachFunctionResponse = z.infer<
	typeof AttachFunctionResponseSchema
>;
