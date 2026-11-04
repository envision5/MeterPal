import {
	ErrCode,
	GetBillingPortalQuerySchema,
	RecaseError,
	Scopes,
} from "@autumn/shared";
import { StatusCodes } from "http-status-codes";
import z from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler";
import { CusService } from "../../CusService";
import { createBillingPortalSession } from "./createBillingPortalSession";

export const handleGetBillingPortal = createRoute({
	scopes: [Scopes.Billing.Read],
	query: GetBillingPortalQuerySchema,
	params: z.object({
		customer_id: z.string(),
	}),
	// body: GetBillingPortalBodySchema,
	handler: async (c) => {
		const returnUrl = c.req.valid("query").return_url;
		const customerId = c.req.param().customer_id;
		const ctx = c.get("ctx");
		const customer = await CusService.get({
			db: ctx.db,
			idOrInternalId: customerId,
			orgId: ctx.org.id,
			env: ctx.env,
		});

		if (!customer) {
			throw new RecaseError({
				message: `Customer ${customerId} not found`,
				code: ErrCode.CustomerNotFound,
				statusCode: StatusCodes.NOT_FOUND,
			});
		}

		const session = await createBillingPortalSession({
			ctx,
			customer,
			returnUrl,
		});

		return c.json({
			customer_id: customer.id || null,
			url: session.url,
		});
	},
});
