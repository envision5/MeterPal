import { z } from "zod/v4";
import { ProcessorType } from "../../../models/genModels/genEnums";

export const ApiInvoiceV1Schema = z.object({
	id: z.string().meta({
		description: "The invoice's internal id",
		example: "inv_2xY8fJ0aQk",
	}),
	plan_ids: z.array(z.string()).meta({
		description: "Array of plan IDs included in this invoice",
		example: ["pro_plan", "addon_feature"],
	}),
	processor_invoice_id: z.string().meta({
		description: "The processor invoice ID",
		example: "pp-cap-8FJ0231A",
	}),
	processor_type: z
		.enum(ProcessorType)
		.default(ProcessorType.PayPal)
		.meta({
			description: "The billing processor that owns this invoice.",
			example: "paypal",
		}),
	status: z.string().meta({
		description: "The status of the invoice",
		example: "paid",
	}),
	total: z.number().meta({
		description: "The total amount of the invoice",
		example: 2999,
	}),
	amount_paid: z.number().nullish().meta({
		description: "Amount collected against this invoice",
		example: 2999,
	}),
	refunded_amount: z.number().nullish().meta({
		description: "Amount refunded against this invoice",
		example: 0,
	}),
	discounts: z
		.array(
			z.object({
				coupon_name: z.string(),
				amount_off: z.number(),
				amount_used: z.number(),
			}),
		)
		.default([])
		.meta({ description: "Discounts applied to this invoice" }),
	currency: z.string().meta({
		description: "The currency code for the invoice",
		example: "usd",
	}),
	created_at: z.number().meta({
		description: "Timestamp when the invoice was created",
		example: 1759247877000,
	}),
	hosted_invoice_url: z.string().nullish().meta({
		description: "URL to the processor-hosted invoice page",
		example: "https://example.com/invoices/in_1234",
	}),
});

export type ApiInvoiceV1 = z.infer<typeof ApiInvoiceV1Schema>;
