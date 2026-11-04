import { AffectedResource, DeleteCustomerParamsSchema, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { customerActions } from "@/internal/customers/actions/index.js";

export const handleDeleteCustomer = createRoute({
	scopes: [Scopes.Customers.Write],
	resource: AffectedResource.Customer,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id } = c.req.param();

		await customerActions.delete({
			ctx,
			params: {
				customer_id,
			},
		});

		return c.json({ success: true });
	},
});

export const handleDeleteCustomerV2 = createRoute({
	scopes: [Scopes.Customers.Write],
	body: DeleteCustomerParamsSchema,
	resource: AffectedResource.Customer,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		await customerActions.delete({
			ctx,
			params,
		});

		return c.json({ success: true });
	},
});
