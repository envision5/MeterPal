import {
	type AttachParamsV0,
	AttachParamsV1Schema,
	billingParamsV1ToV0,
	type CustomizePlanV1,
	cusProductToProduct,
	customizePlanV1ToV0,
	type FeatureQuantityParamsV0,
	type FullProduct,
	type UpdateSubscriptionV0Params,
	UpdateSubscriptionV1ParamsSchema,
} from "@autumn/shared";
import { z } from "zod/v4";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { findTargetCustomerProduct } from "@/internal/billing/v2/actions/updateSubscription/setup/findTargetCustomerProduct";
import { CusService } from "@/internal/customers/CusService";
import { ProductService } from "@/internal/products/ProductService";

export const ResolveBillingRequestParamsSchema = z.discriminatedUnion("tool", [
	z.object({ request: AttachParamsV1Schema, tool: z.literal("attach") }),
	z.object({
		request: UpdateSubscriptionV1ParamsSchema,
		tool: z.literal("update_subscription"),
	}),
]);

export type ResolveBillingRequestParams = z.infer<
	typeof ResolveBillingRequestParamsSchema
>;

export type ResolvedBillingRequestV0 =
	| AttachParamsV0
	| UpdateSubscriptionV0Params;

/** A plan the request-generation flow can customize before it becomes a
 * multi-attach plan entry. */
export type ResolvedPlanSpec = {
	plan_id: string;
	entity_id?: string | null;
	feature_quantities?: FeatureQuantityParamsV0[];
	version?: number;
	customize?: CustomizePlanV1;
};

/** Resolves one plan's `customize` patch into concrete V0 items against its
 * catalog plan — shared by multi-attach generation. */
export const resolveCustomizedPlan = async ({
	ctx,
	plan,
}: {
	ctx: AutumnContext;
	plan: ResolvedPlanSpec;
}) => {
	if (!plan.customize) return plan;
	const fullProduct = await ProductService.getFull({
		db: ctx.db,
		env: ctx.env,
		idOrInternalId: plan.plan_id,
		orgId: ctx.org.id,
		version: plan.version,
	});
	const { customize, ...rest } = plan;
	return {
		...rest,
		items: customizePlanV1ToV0({
			ctx,
			customizePlanV1: customize,
			fullProduct,
		}),
	};
};

/** Maps a billing request into the dashboard's dialect — `customize` resolves
 * to items against catalog plans (attach) or the live subscription (updates). */
export const resolveBillingRequest = async ({
	ctx,
	params,
}: {
	ctx: AutumnContext;
	params: ResolveBillingRequestParams;
}): Promise<{
	request: ResolvedBillingRequestV0;
	unrepresentable: string[];
}> => {
	let fullProduct: FullProduct;
	if (params.tool === "attach") {
		fullProduct = await ProductService.getFull({
			db: ctx.db,
			env: ctx.env,
			idOrInternalId: params.request.plan_id,
			orgId: ctx.org.id,
			version: params.request.version,
		});
	} else {
		const fullCustomer = await CusService.getFull({
			ctx,
			idOrInternalId: params.request.customer_id,
			entityId: params.request.entity_id,
		});
		const targetCustomerProduct = await findTargetCustomerProduct({
			ctx,
			fullCustomer,
			params: params.request,
		});
		fullProduct = params.request.version
			? await ProductService.getFull({
					db: ctx.db,
					env: ctx.env,
					idOrInternalId: targetCustomerProduct.product.id,
					orgId: ctx.org.id,
					version: params.request.version,
				})
			: cusProductToProduct({ cusProduct: targetCustomerProduct });
	}

	const { request, unrepresentable } = billingParamsV1ToV0({
		ctx,
		fullProduct,
		params: params.request,
	});
	return {
		request:
			params.tool === "attach"
				? (request as AttachParamsV0)
				: (request as UpdateSubscriptionV0Params),
		unrepresentable,
	};
};
