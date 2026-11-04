// billing/server/src/internal/setup/handlers/handleCreatePaypalPlan.ts
//
// POST /v1/organization/setup/paypal-plan
//
// The wizard's plan step: create the PayPal counterpart of one of the
// merchant's plans.
//
// PayPal's model is a catalog product with billing plans underneath, so a
// MeterPal plan becomes a PayPal product + plan.  The mapping is cached in
// paypal_catalog_map, so asking twice does not create two plans.
//
// The credentials are the ORG's own -- the merchant receives the money.

import { Scopes } from "@autumn/shared";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { getPaypalClient } from "@/external/paypal/paypalClient.js";
import { ensurePaypalPlan } from "@/internal/billing/paypal/runPaypalCheckout.js";
import { ProductService } from "@/internal/products/ProductService.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";

const bodySchema = z.object({
	product_id: z.string().min(1),
});

export const handleCreatePaypalPlan = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: bodySchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env } = ctx;
		const { product_id } = c.req.valid("json");

		const product = await ProductService.getFull({
			db,
			idOrInternalId: product_id,
			orgId: org.id,
			env,
		});

		if (!product) {
			return c.json(
				{ error: `No plan named "${product_id}" in this organization.` },
				404,
			);
		}

		const client = await getPaypalClient({ org, env });

		const mapping = await ensurePaypalPlan({
			client,
			db,
			org,
			env,
			product,
		});

		// Spec §5: creating a plan's PayPal counterpart is a config change.
		await recordConfigAudit({
			ctx,
			action: "setup.paypal_plan_created",
			resource: product.id,
			metadata: { paypal_plan_id: mapping },
		});

		return c.json({
			product_id: product.id,
			paypal_plan_id: mapping,
		});
	},
});
