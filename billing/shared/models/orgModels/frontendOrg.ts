import { z } from "zod/v4";
import { CustomButtonSchema } from "./customButton";
import { IdempotencyConfigSchema } from "./idempotencyConfig";
import { OrgConfigSchema } from "./orgConfig";

export const FrontendOrgSchema = z.object({
	id: z.string(),
	name: z.string(),
	logo: z.string().nullable(),
	slug: z.string(),

	success_url: z.string(),
	default_currency: z.string(),
	created_at: z.number(),
	test_pkey: z.string().nullable(),
	live_pkey: z.string().nullable(),

	master: z
		.object({
			id: z.string(),
			name: z.string(),
			slug: z.string(),
		})
		.nullable(),
	through_master: z.boolean(),
	onboarded: z.boolean(),
	deployed: z.boolean(),
	config: OrgConfigSchema,
	idempotency_config: IdempotencyConfigSchema.nullable(),
	custom_buttons: z.array(CustomButtonSchema),
	redis_config: z
		.object({
			host: z.string(),
			migrationPercent: z.number(),
		})
		.nullable(),
});

export type FrontendOrg = z.infer<typeof FrontendOrgSchema>;
