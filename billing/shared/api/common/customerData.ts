import { z } from "zod/v4";
import { CustomerBillingControlsParamsSchema } from "../../models/cusModels/billingControls/customerBillingControls";
import { isValidCurrencyCode } from "../../utils/currencyUtils/currencies";

// for internal use only
export const CreateCustomerInternalOptionsSchema = z.object({
	default_group: z.string().optional().meta({
		description: "The group of products to attach to the customer",
	}),
	disable_defaults: z.boolean().optional().meta({
		description: "Whether to disable default products",
	}),
});

// Canonical customer email validation — reuse anywhere an email is accepted.
export const CustomerEmailSchema = z.email({
	pattern: z.regexes.unicodeEmail,
	message: "not a valid email address",
});

// Base schema without top-level .meta() to avoid side effects during imports
// Individual field descriptions are kept as they don't cause registry conflicts
export const CustomerDataSchema = z
	.object({
		name: z.string().nullish().meta({
			description: "Customer's name",
		}),
		email: CustomerEmailSchema.nullish().meta({
			description: "Customer's email address",
		}),

		fingerprint: z.string().nullish().meta({
			description:
				"Unique identifier (eg, serial number) to detect duplicate customers and prevent free trial abuse",
		}),
		metadata: z.record(z.string(), z.any()).nullish().meta({
			description: "Additional metadata for the customer",
		}),
		auto_enable_plan_id: z.string().optional().meta({
			description: "The ID of the free plan to auto-enable for the customer",
		}),

		send_email_receipts: z.boolean().optional().meta({
			description: "Whether to send email receipts to this customer",
		}),

		currency: z
			.string()
			.refine(isValidCurrencyCode, "must be a supported currency code")
			.nullish()
			.meta({
				description:
					"Currency to bill this customer in (e.g. usd, eur). Defaults to the organization's default currency.",
			}),

		billing_controls: CustomerBillingControlsParamsSchema.optional().meta({
			description: "Billing controls for the customer (auto top-ups, etc.)",
		}),

		config: z
			.object({
				disable_pooled_balance: z.boolean().optional().meta({
					description:
						"Whether to disable the shared customer-level pool for entities.",
				}),
				disable_overage_billing: z.boolean().optional().meta({
					description:
						"Stops Autumn from posting usage-overage line items to the billing processor for this customer. Check/track and balance resets still behave normally. When set, this overrides the organization-level disable_overage_billing setting.",
				}),
			})
			.optional()
			.meta({
				description: "Miscellaneous configurations for the customer.",
			}),

		internal_options: CreateCustomerInternalOptionsSchema.optional().meta({
			internal: true,
		}),
	})
	.meta({
		$id: "CustomerData",
		title: "CustomerData",
		description: "Customer details to set when creating a customer",
	});

export type CustomerData = z.infer<typeof CustomerDataSchema>;

export type CreateCustomerInternalOptions = z.infer<
	typeof CreateCustomerInternalOptionsSchema
>;
